export { releaseAttempt, reapExpiredLeases, safeRecovery } from "./recovery.ts";
import { advance } from "./progression.ts";
export { advance } from "./progression.ts";
import { budgetPreflight, enforceBudget } from "./budgets.ts";
import {
  EngineError,
  lockRun,
  stepsOf,
  setStepStatus,
  setRunStatus,
  ensureJob,
  cancelStepJobs,
  type AfterCommit,
} from "./mutations.ts";
export { EngineError } from "./mutations.ts";
import { applyOptimizationDefaults } from "../eval/optimization.ts";
import { z } from "zod";
import { execution } from "../auth/execution.ts";
import {
  buildHandoffPackage,
  providerFailure,
  PAUSABLE_FAILURES,
  AUTOMATIC_FAILURES,
  handoffReadiness,
  inspectHandoffWorkspace,
} from "../agent/handoff.ts";
import { fallbackPolicy } from "../agent/stepAgent.ts";
import {
  resolveStepAgent,
  effectiveStepConfig,
  StepAgentOverrideConfig,
} from "../agent/stepAgent.ts";
import { normalizeProviderFailure, safeDiagnostics } from "../agent/telemetry.ts";
import type pg from "pg";
import { config } from "../config.ts";
import { executionPolicyVersions } from "../learning/policyVersions.ts";
import { workspacesOf } from "../git/provider.ts";
import { instanceHealth, ownsInstance, instanceSession } from "../instances.ts";
import { outputLocale, resolveOutputLocale, type OutputLocale } from "../agent/language.ts";
import { resolveAgentProvider, type AgentProvider } from "../agent/provider.ts";
import { pool, q, one, withTx, json, type Db } from "../db/pool.ts";
import { notify, notifyStepWaiting } from "../notify.ts";
import { isAmbiguous, rankRepositories, repositories } from "../repos/service.ts";
import { allowedRepositoriesForRun, effectivePermissions } from "../repos/access.ts";
import { ensureTestOwner } from "../auth/testOwner.ts";
import { definitions } from "./definitions.ts";
import { detectBranchDirectives, normalizeBranchMap, WORK_ITEM_BRANCH_SOURCE } from "./branches.ts";
import { classifyFailure } from "./failures.ts";
import { background } from "./background.ts";
import { downstream, topoOrder } from "./graph.ts";
import {
  classificationPrompt,
  decideFeedbackRoute,
  FEEDBACK_MODES,
  feedbackSignals,
  heuristicJudgement,
  parseJudgement,
  replanAnchors,
  routeTargets,
  type FeedbackJudgement,
  type FeedbackMode,
} from "./replan.ts";
import { snapshotUncommitted } from "../git.ts";
import { localJobs } from "./local.ts";
import { runEvents } from "./events.ts";
import { materializeSubtasks } from "./decomposition.ts";
import { DONE, RETRYABLE } from "./stateMachine.ts";
import { buildStepInput, resolveContext, type ResolvedContext, type StepInput } from "./context.ts";
import type {
  AttemptRow,
  ExecResult,
  JobRow,
  QuestionInput,
  RunRow,
  StepRow,
  WorkflowSpec,
} from "./types.ts";
import { parseAiSuggest, type ReportSpec } from "../report/aiSuggest.ts";
import {
  applyProfile,
  classifyComplexity,
  classifyProfile,
  ProfileNotApplicable,
  type ProfileChange,
  type ProfileChoice,
  type ProfileDecision,
} from "./profiles.ts";

export const REPORT_STEP_KEY = "task_result_report";

/**
 * Append the optional final Task Result Report step to a run's resolved graph (never to the published definition).
 * Depends on every terminal step, so it runs only after all work (tests, review, PR) is done. Idempotent: a graph that
 * already has a report step (custom workflow, or injected before) is returned unchanged.
 */
export function withReportStep(spec: WorkflowSpec, ai: ReportSpec | null): WorkflowSpec {
  if (!ai || spec.steps.some((s) => s.key === REPORT_STEP_KEY || s.type === "task_result_report"))
    return spec;
  const terminals = spec.steps
    .filter((s) => !spec.steps.some((o) => o.depends_on.includes(s.key)))
    .map((s) => s.key);
  return {
    ...spec,
    steps: [
      ...spec.steps,
      {
        key: REPORT_STEP_KEY,
        type: "task_result_report",
        name: "Task Result Report",
        depends_on: terminals,
        config: { ai_suggest: ai, injected: true },
        requires_approval: false,
        max_attempts: 2,
        retry_backoff_seconds: 5,
      },
    ],
  };
}

/**
 * WorkflowExecutionService. Invariants:
 *  - lifecycle/result transactions first lock the run row (`lockRun`); begin then locks job → step,
 *    while completion/recovery lock job → attempt → step. Claim/heartbeat/executor writes have narrower contracts;
 *  - step status changes are validated by the state machine;
 *  - an attempt's result is applied only if its job's fencing token and its step's generation are unchanged.
 */

export type WorkflowActionGuard = (db: Db) => Promise<void>;

// ---------------------------------------------------------------- run lifecycle

export interface StartRunInput {
  definitionKey: string;
  version?: number;
  workItemId?: number | null;
  title?: string;
  inputs?: Record<string, unknown>;
  repositories?: string[];
  /** false = create the run in PENDING without scheduling anything (configure first, start later). */
  start?: boolean;
  /** Execution profile: AUTO (default, deterministic classification) or a manual override. */
  profile?: ProfileChoice;
  /** Language of summaries, questions and reports. Omitted → vi. Invalid values are rejected. */
  outputLocale?: "vi" | "en";
  /** Run default provider. Omitted → platform default (Claude unless configured). Agent steps can override it. */
  agentProvider?: AgentProvider | string;
  /** Authenticated creator. A run started from a work item always uses that item's owner. */
  ownerId?: number;
}

export interface ResolvedRunGraph {
  dv: { id: number; key: string; version: number; spec: WorkflowSpec };
  wi: any | null;
  inputs: Record<string, unknown>;
  allowed: string[];
  selected: string[];
  reusedRepositories: boolean;
  decision: ProfileDecision;
  changes: ProfileChange[];
  graph: WorkflowSpec;
  reportAdded: boolean;
  ownerId: number;
}

/**
 * Everything decided at run creation, without writing: allowed/selected repositories (reusing the ones confirmed in an
 * earlier run of the same work item), the execution profile and the resolved graph (profile + report step). Used by
 * startRun and by the preview API, so what the user previews is exactly what runs.
 */
export async function resolveRunGraph(c: Db, input: StartRunInput): Promise<ResolvedRunGraph> {
  const wi = input.workItemId
    ? await one(c, "SELECT * FROM work_items WHERE id = $1", [input.workItemId])
    : null;
  if (input.workItemId && !wi)
    throw new EngineError(`work item ${input.workItemId} not found`, 404);
  let ownerId = input.ownerId ?? null;
  if (wi) {
    if (wi.owner_id == null) throw new EngineError("work item has no owner", 404);
    if (ownerId != null && Number(ownerId) !== Number(wi.owner_id))
      throw new EngineError("run owner must match the work item", 403);
    ownerId = Number(wi.owner_id);
  } else if (ownerId == null && process.env.PLATFORM_TEST === "1")
    ownerId = await ensureTestOwner();
  if (ownerId == null) throw new EngineError("a run needs an owner", 400);
  const owner = await one<{ active: boolean }>(c, "SELECT active FROM users WHERE id = $1", [
    ownerId,
  ]);
  if (!owner?.active) throw new EngineError("owner is not active", 403);
  const dv = await definitions.version(input.definitionKey, input.version, c, ownerId);
  if (!dv)
    throw new EngineError(
      `workflow "${input.definitionKey}"${input.version ? ` v${input.version}` : ""} has no published version`,
      404,
    );
  const inputs = input.inputs ?? {};
  const project = wi?.project || String(inputs.project ?? "");
  // The owner's own effective permissions (platform grant ∩ Bitbucket ∩ repository), narrowed by the project mapping.
  const allowed = await allowedRepositoriesForRun(ownerId, project, "read", {
    db: c,
    verify: true,
  });
  let selected =
    input.repositories ??
    (Array.isArray(inputs.repositories) ? (inputs.repositories as string[]) : []);
  if (!Array.isArray(selected) || selected.some((r) => typeof r !== "string"))
    throw new EngineError("repositories must be a list of repository names", 400);
  const outside = selected.filter((r) => !allowed.includes(r));
  // Same answer for "not registered" and "not yours": the existence of other repositories is not revealed.
  if (outside.length)
    throw new EngineError(
      `repositories not found or not accessible for this run: ${outside.join(", ")}`,
      403,
    );
  // Reuse repositories already confirmed for this work item (skips rediscovery); never outside the allowed set.
  let reusedRepositories = false;
  if (!selected.length && wi) {
    const prev = await one<{ selected_repositories: string[] }>(
      c,
      "SELECT selected_repositories FROM workflow_runs WHERE work_item_id = $1 AND cardinality(selected_repositories) > 0 ORDER BY id DESC LIMIT 1",
      [wi.id],
    );
    if (prev && prev.selected_repositories.every((r) => allowed.includes(r))) {
      selected = prev.selected_repositories;
      reusedRepositories = true;
    }
  }
  // Deterministic discovery signal for profile selection (no LLM).
  const text = [wi?.title, wi?.description, input.title, JSON.stringify(inputs)]
    .filter(Boolean)
    .join("\n");
  const ranked = rankRepositories(
    (await repositories.list(c)).filter((r) => allowed.includes(r.name)),
    { text, project },
  );
  const positive = ranked.filter(
    (r) => r.score > 0 && !r.reasons.every((x) => x.startsWith("mapped to project")),
  );
  const decision0 = classifyProfile(
    {
      title: wi?.title ?? input.title ?? "",
      description: wi?.description ?? String(inputs.description ?? ""),
      project,
      repositories: selected,
      knownRepository: positive.length && !isAmbiguous(positive) ? positive[0].repo : null,
      matchingRepositories: positive.length,
      declaredRisk: (inputs.risk as string) ?? wi?.payload?.risk ?? null,
    },
    input.profile ?? "AUTO",
  );
  const priorFailureRuns = wi
    ? Number(
        (
          await one<{ n: number }>(
            c,
            "SELECT count(*)::int AS n FROM (SELECT outcome FROM workflow_runs WHERE work_item_id = $1 AND outcome IS NOT NULL ORDER BY id DESC LIMIT 5) r WHERE jsonb_array_length(COALESCE(r.outcome->'failure_categories', '[]'::jsonb)) > 0",
            [wi.id],
          )
        )?.n ?? 0,
      )
    : 0;
  const complexity = classifyComplexity(decision0, { priorFailureRuns }, inputs.complexity);
  let decision: ProfileDecision & { complexity: typeof complexity } = {
    ...decision0,
    signals: { ...decision0.signals, reused_repositories: reusedRepositories },
    complexity,
  };
  // High-risk verification stays mandatory: FAST would drop the independent review, so it is refused for HIGH_RISK
  // unless the user explicitly re-classified the task (recorded as an override).
  if (complexity.class === "HIGH_RISK" && decision.profile === "FAST")
    decision = {
      ...decision,
      profile: "STANDARD",
      warnings: [
        ...decision.warnings,
        "FAST refused: HIGH_RISK tasks keep the independent review and approvals (override the complexity class to change this)",
      ],
    };
  let resolved: { spec: WorkflowSpec; changes: ProfileChange[] };
  try {
    resolved = applyProfile(dv.spec, decision.profile);
  } catch (e) {
    if (!(e instanceof ProfileNotApplicable)) throw e;
    decision = {
      ...decision,
      profile: "STANDARD",
      reasons: [...decision.reasons, `FAST not applicable: ${e.message} → STANDARD`],
    };
    resolved = { spec: dv.spec, changes: [] };
  }
  const graph = withReportStep(resolved.spec, wi ? parseAiSuggest(wi.payload) : null);
  return {
    dv,
    wi,
    inputs,
    allowed,
    selected,
    reusedRepositories,
    decision,
    changes: resolved.changes,
    graph,
    reportAdded: graph !== resolved.spec,
    ownerId: ownerId!,
  };
}

export async function previewRun(input: StartRunInput) {
  const r = await resolveRunGraph(pool, input);
  return {
    definition: { key: r.dv.key, version: r.dv.version },
    profile: r.decision,
    changes: r.changes,
    report_step: r.reportAdded,
    selected_repositories: r.selected,
    reused_repositories: r.reusedRepositories,
    published_steps: r.dv.spec.steps.length,
    graph: r.graph,
  };
}

export async function startRun(input: StartRunInput) {
  let output_locale: OutputLocale;
  let agent_provider: AgentProvider;
  try {
    output_locale = resolveOutputLocale(input.outputLocale);
    agent_provider = resolveAgentProvider(input.agentProvider ?? config.agent.defaultProvider);
  } catch (e) {
    throw new EngineError((e as Error).message, 400);
  }
  return withTx(async (c, afterCommit) => {
    const r = await resolveRunGraph(c, input);
    const { dv, wi, inputs, allowed, selected, graph } = r;
    const { id } = (await one<{ id: number }>(
      c,
      "SELECT nextval('workflow_runs_id_seq')::bigint AS id",
    ))!;
    const raw = String(wi?.code ?? `run-${id}`)
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 48);
    const branch = `u${r.ownerId}-${raw}`.slice(0, 80);
    if (wi && inputs.task_code == null) inputs.task_code = wi.code;
    // Existing-branch directives: explicit inputs.branches, else detected from the work item text ("làm tiếp từ branch X ở repo").
    const explicitBranches = normalizeBranchMap(inputs.branches, config.baseBranch);
    if (explicitBranches) inputs.branches = explicitBranches;
    else if (wi) {
      const repoNames = (await q<{ name: string }>(c, "SELECT name FROM repositories")).map(
        (x) => x.name,
      );
      const detected = detectBranchDirectives(
        [wi.title, wi.description, wi.payload?.note].filter(Boolean).join("\n"),
        repoNames,
        config.baseBranch,
      );
      if (Object.keys(detected).length)
        Object.assign(inputs, { branches: detected, branches_source: WORK_ITEM_BRANCH_SOURCE });
    }
    const optimized = await applyOptimizationDefaults(
      c,
      r.ownerId!,
      graph,
      inputs,
      input.agentProvider != null,
      r.decision.profile,
      (r.decision as any).complexity?.class ?? null,
    );
    const title = input.title || (wi ? `${wi.code}: ${wi.title}` : `${dv.spec.name} #${id}`);
    try {
      for (const step of optimized.graph.steps)
        resolveStepAgent({ agent_provider, profile: r.decision.profile }, step);
    } catch (error) {
      throw new EngineError((error as Error).message, 400);
    }
    const resolvedGraph = {
      ...optimized.graph,
      profile: r.decision.profile,
      profile_changes: r.changes,
    };
    await q(
      c,
      `INSERT INTO workflow_runs (id, definition_version_id, definition_key, work_item_id, title, status, inputs, graph,
                                  allowed_repositories, selected_repositories, branch, profile, profile_decision, output_locale, agent_provider, owner_id, worker_instance, policy_versions)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        id,
        dv.id,
        dv.key,
        wi?.id ?? null,
        title,
        json(inputs),
        json(resolvedGraph),
        allowed,
        selected,
        branch,
        r.decision.profile,
        json(r.decision),
        output_locale,
        agent_provider,
        r.ownerId,
        config.instanceId,
        json(executionPolicyVersions()),
      ],
    );
    for (const decision of optimized.decisions)
      await q(
        c,
        "INSERT INTO agent_optimization_decisions(run_id,step_key,recommendation_id,policy_id,provenance) VALUES($1,$2,$3,$4,$5)",
        [id, decision.step_key, decision.recommendation_id, decision.policy_id, json(decision)],
      );
    const order = topoOrder(optimized.graph.steps);
    for (const s of optimized.graph.steps) {
      const requiresApproval =
        s.requires_approval || (s.type === "git_pull_request" && s.config.mode === "approval");
      await q(
        c,
        `INSERT INTO workflow_steps (run_id, key, type, name, position, depends_on, config, run_if, requires_approval, max_attempts, retry_backoff_s, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING')`,
        [
          id,
          s.key,
          s.type,
          s.name ?? s.key,
          order.indexOf(s.key),
          s.depends_on,
          json(s.config),
          json(s.run_if ?? null),
          requiresApproval,
          s.max_attempts,
          s.retry_backoff_seconds,
        ],
      );
    }
    await runEvents.add(
      c,
      id,
      "system",
      `run created from ${dv.key} v${dv.version}${wi ? ` for ${wi.code}` : ""} · agent ${agent_provider} · profile ${r.decision.profile} (${r.decision.reasons.join("; ")})` +
        (r.changes.length ? ` · ${r.changes.length} graph change(s)` : "") +
        (r.reportAdded ? " · Task Result Report step added (ai_suggest.report)" : "") +
        (r.reusedRepositories ? ` · reused repositories ${selected.join(", ")}` : ""),
    );
    if (wi)
      await q(
        c,
        "UPDATE work_items SET status = 'in_progress', updated_at = now() WHERE id = $1 AND status = 'open'",
        [wi.id],
      );
    const run = (await one<RunRow>(c, "SELECT * FROM workflow_runs WHERE id = $1", [id]))!;
    if (input.start !== false) {
      await setRunStatus(c, run, "RUNNING");
      await advance(c, id, afterCommit);
    }
    return getRun(id, c);
  });
}

/**
 * Expand the run graph with an approved decomposition plan. One transaction under the run lock; idempotent per plan.
 * Allowed repositories are the run's selected repositories (never caller-supplied).
 */
export async function expandSubtasks(
  runId: number,
  planStepKey: string,
  plan: unknown,
  opts: {
    by: string;
    reason: string;
    kind?: "decomposition" | "replan";
    guard?: WorkflowActionGuard;
  },
) {
  let result!: Awaited<ReturnType<typeof materializeSubtasks>>;
  await txThenRun(runId, async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    await opts.guard?.(c);
    if (["COMPLETED", "CANCELED", "FAILED"].includes(run.status))
      throw new EngineError(`run ${runId} is ${run.status}`, 409);
    result = await materializeSubtasks(c, runId, planStepKey, plan, {
      actor: opts.by,
      reason: opts.reason,
      kind: opts.kind,
      allowedRepositories: run.selected_repositories.filter((r: string) =>
        run.allowed_repositories.includes(r),
      ),
    });
    if (!result.replayed) await advance(c, runId, afterCommit);
  });
  return result;
}

export async function startPendingRun(
  runId: number,
  repositoriesOverride?: string[],
  stepMode = false,
) {
  return txThenRun(runId, async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    if (run.status !== "PENDING")
      throw new EngineError(`run ${runId} is ${run.status}, not PENDING`);
    await adoptRun(c, runId);
    if (repositoriesOverride) await setSelectedRepositories(c, run, repositoriesOverride);
    await setRunStatus(c, run, "RUNNING");
    if (stepMode) await setRunStatus(c, run, "PAUSED");
    await advance(c, runId, afterCommit);
    return;
  });
}

/**
 * Correct the existing-branch directive of a run (e.g. a wrongly detected branch name) before its worktree exists.
 * `branches` = { repo | "*": branch }; an empty value removes the entry (the run then cuts its own branch). Repositories
 * that already have a worktree keep their branch (changing it under a prepared worktree would be unsafe).
 */
export async function setRunBranches(runId: number, branches: unknown, by: string) {
  return withTx(async (c) => {
    const run = await lockRun(c, runId);
    if (run.status === "COMPLETED" || run.status === "CANCELED")
      throw new EngineError(`run ${runId} is ${run.status}`, 409);
    const raw =
      branches && typeof branches === "object" && !Array.isArray(branches)
        ? (branches as Record<string, unknown>)
        : null;
    if (!raw) throw new EngineError('branches must be an object { repo | "*": branch }', 400);
    let next: Record<string, string> | null;
    try {
      next = normalizeBranchMap(
        Object.fromEntries(Object.entries(raw).filter(([, v]) => String(v ?? "").trim())),
        config.baseBranch,
      );
    } catch (e) {
      throw new EngineError((e as Error).message, 400);
    }
    const prepared = (await workspacesOf(run.id, c)).map((w) => w.repo);
    const touched = Object.keys(raw).flatMap((k) =>
      k === "*" ? prepared : prepared.includes(k) ? [k] : [],
    );
    if (touched.length)
      throw new EngineError(
        `worktree already prepared for ${touched.join(", ")}: its branch cannot change in this run`,
        409,
      );
    const inputs = { ...(run.inputs ?? {}) } as Record<string, any>;
    if (next) Object.assign(inputs, { branches: next, branches_source: `set by ${by}` });
    else {
      delete inputs.branches;
      delete inputs.branches_source;
    }
    await q(c, "UPDATE workflow_runs SET inputs = $2, updated_at = now() WHERE id = $1", [
      run.id,
      json(inputs),
    ]);
    await runEvents.add(
      c,
      run.id,
      "system",
      `existing-branch directive ${next ? `set to ${JSON.stringify(next)}` : "removed"} by ${by}`,
    );
    return getRun(run.id, c);
  });
}

export async function pauseRun(runId: number) {
  return txThenRun(runId, async (c) => {
    const run = await lockRun(c, runId);
    if (run.status === "PAUSED") return;
    await setRunStatus(c, run, "PAUSED");
    return;
  });
}

export async function resumeRun(runId: number) {
  return txThenRun(runId, async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    if (run.status !== "PAUSED") throw new EngineError(`run ${runId} is ${run.status}, not PAUSED`);
    await adoptRun(c, runId);
    await setRunStatus(c, run, "RUNNING");
    await advance(c, runId, afterCommit);
    return;
  });
}

export async function cancelRun(runId: number, reason = "canceled by user") {
  return txThenRun(runId, async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    if (run.status === "CANCELED") return;
    const aborted: number[] = [];
    for (const s of await stepsOf(c, runId)) {
      if (["COMPLETED", "SKIPPED", "CANCELED", "FAILED"].includes(s.status)) continue;
      aborted.push(...(await cancelStepJobs(c, s.id, reason)));
      await setStepStatus(c, s, "CANCELED", { finished_at: new Date() }, reason);
    }
    await q(
      c,
      "UPDATE workflow_step_attempts SET status = 'CANCELED', finished_at = now(), error = $2 WHERE run_id = $1 AND status = 'RUNNING'",
      [runId, json({ message: reason })],
    );
    await q(
      c,
      "UPDATE workflow_questions SET status = 'dismissed' WHERE run_id = $1 AND status = 'open'",
      [runId],
    );
    await setRunStatus(c, run, "CANCELED", afterCommit, reason);
    afterCommit(() => aborted.forEach((id) => localJobs.abort(id)));
    return;
  });
}

async function setSelectedRepositories(c: Db, run: RunRow, repos: string[]) {
  const clean = [...new Set(repos.map(String))];
  const outside = clean.filter((r) => !run.allowed_repositories.includes(r));
  if (outside.length)
    throw new EngineError(`repositories outside the allowed set: ${outside.join(", ")}`, 400);
  // The persisted scope may predate a revocation: the owner must still be able to read every selected repository.
  if (clean.length && run.owner_id != null) {
    const perms = await effectivePermissions(Number(run.owner_id), {
      db: c,
      project: String(run.inputs?.project ?? ""),
    });
    const lost = clean.filter((r) => !perms.get(r)?.effective.read);
    if (lost.length)
      throw new EngineError(`repository access revoked for the run owner: ${lost.join(", ")}`, 403);
  }
  await q(
    c,
    "UPDATE workflow_runs SET selected_repositories = $2, updated_at = now() WHERE id = $1",
    [run.id, clean],
  );
  run.selected_repositories = clean;
  await runEvents.add(
    c,
    run.id,
    "system",
    `selected repositories: ${clean.join(", ") || "(none)"}`,
  );
}

export async function selectRepositories(runId: number, repos: string[]) {
  return txThenRun(runId, async (c) => {
    const run = await lockRun(c, runId);
    await setSelectedRepositories(c, run, repos);
    return;
  });
}

// ---------------------------------------------------------------- re-execution

/**
 * Re-execute `stepKey`: bump its generation, make it READY, and reset every transitive dependant to PENDING
 * (their outputs were derived from context that is now stale). Steps that are not downstream keep their
 * results — e.g. retrying implementation reuses the completed analysis and plan.
 */
async function reexecuteTx(
  c: Db,
  run: RunRow,
  stepKey: string,
  pending: Record<string, unknown> | null,
  afterCommit: AfterCommit,
  why: string,
  /** Pending input for specific invalidated dependants (e.g. "rediscover" for the discovery step). */
  dependantInput?: Record<string, Record<string, unknown>>,
) {
  if (run.status === "CANCELED") throw new EngineError("run is canceled");
  const steps = await stepsOf(c, run.id);
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const target = byKey.get(stepKey);
  if (!target) throw new EngineError(`step "${stepKey}" not found`, 404);
  if (target.pending_input?.provider_handoff?.source_attempt_id === target.current_attempt_id)
    throw new EngineError("Review and confirm the pending provider handoff", 409);
  if (!RETRYABLE.includes(target.status))
    throw new EngineError(
      `step "${stepKey}" is ${target.status}; only ${RETRYABLE.join("/")} steps can be re-executed`,
    );
  const blocked = target.depends_on.filter((d) => !DONE.includes(byKey.get(d)!.status));
  if (blocked.length) throw new EngineError(`upstream steps not complete: ${blocked.join(", ")}`);

  const aborted: number[] = [];
  const invalidate = async (s: StepRow, to: "PENDING" | "READY") => {
    aborted.push(...(await cancelStepJobs(c, s.id, `invalidated by re-execution of ${stepKey}`)));
    await q(
      c,
      "UPDATE workflow_step_attempts SET status = 'CANCELED', finished_at = now() WHERE step_id = $1 AND status = 'RUNNING'",
      [s.id],
    );
    await q(
      c,
      "UPDATE workflow_step_attempts SET invalidated_at = now() WHERE step_id = $1 AND invalidated_at IS NULL",
      [s.id],
    );
    await q(
      c,
      "UPDATE workflow_questions SET status = 'dismissed' WHERE step_id = $1 AND status = 'open'",
      [s.id],
    );
    await setStepStatus(
      c,
      s,
      to,
      {
        generation: s.generation + 1,
        attempt_count: 0,
        current_attempt_id: null,
        output: null,
        error: null,
        approval: null,
        pending_input: s === target ? pending : (dependantInput?.[s.key] ?? null),
        ready_at: to === "READY" ? new Date() : null,
        finished_at: null,
      },
      s === target ? why : `invalidated by ${stepKey}`,
    );
  };
  for (const key of downstream(run.graph.steps, stepKey)) {
    await invalidate(byKey.get(key)!, "PENDING");
  }
  await invalidate(target, "READY");
  if (run.status !== "PAUSED") await setRunStatus(c, run, "RUNNING");
  afterCommit(() => aborted.forEach((id) => localJobs.abort(id)));
  await advance(c, run.id, afterCommit);
}

/**
 * Re-execute a step, optionally with developer instructions and extra skills for THIS re-execution only. Skills are
 * pinned to their current version and stored with the instructions in the step's pending input before anything is
 * enqueued, so a worker restart or a job retry uses exactly the same input. Templates and default prompts are untouched.
 */
export async function reexecuteStep(
  runId: number,
  stepKey: string,
  opts: {
    input?: Record<string, unknown>;
    feedback?: string;
    skills?: string[];
    by?: string;
    /** Keep the instructions as a developer decision for every later step of the run (default true). */
    persist?: boolean;
  } = {},
) {
  return txThenRun(runId, async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    const feedback = opts.feedback?.trim() || undefined;
    const keys = [...new Set((opts.skills ?? []).map(String).filter(Boolean))];
    // Only skills the run can actually load: enabled, and shared or owned by the run owner (resolution applies the
    // same rule; anything else would be pinned and then silently dropped).
    const pinnedNew = keys.length
      ? await q<{ key: string; version: number; title: string }>(
          c,
          `SELECT DISTINCT ON (key) key, current_version AS version, title FROM knowledge_items
            WHERE key = ANY($1) AND enabled AND (owner_id IS NULL OR owner_id = $2)
            ORDER BY key, (owner_id IS NULL)`,
          [keys, run.owner_id ?? null],
        )
      : [];
    const unknown = keys.filter((k) => !pinnedNew.some((p) => p.key === k));
    if (unknown.length)
      throw new EngineError(
        `unknown skill(s) or not available to this run (disabled or private to another user): ${unknown.join(", ")}`,
        400,
      );
    // A retry or feedback without a skill choice keeps the skills pinned for the current re-execution.
    const current = await one<{ pending_input: any }>(
      c,
      "SELECT pending_input FROM workflow_steps WHERE run_id = $1 AND key = $2",
      [runId, stepKey],
    );
    const pinned = keys.length
      ? pinnedNew
      : ((current?.pending_input?.reexecute?.skills ?? []) as typeof pinnedNew);
    const reexecute =
      feedback || pinned.length
        ? {
            instructions: feedback ?? null,
            skills: pinned,
            requested_by: opts.by ?? "",
            at: new Date().toISOString(),
          }
        : null;
    const pending =
      feedback || opts.input || reexecute
        ? {
            ...(opts.input ?? {}),
            ...(feedback ? { feedback } : {}),
            ...(reexecute ? { reexecute } : {}),
          }
        : null;
    await adoptRun(c, runId);
    // A developer decision (business rule, scope ruling) must outlive this one attempt: the automatic review → implement
    // loop re-runs steps with fresh input, and without this the next reviewer raises the overruled findings again.
    if (feedback && opts.persist !== false)
      await q(
        c,
        `UPDATE workflow_runs SET inputs = coalesce(inputs, '{}'::jsonb) || jsonb_build_object('developer_decisions',
           coalesce(inputs->'developer_decisions', '[]'::jsonb) || jsonb_build_array($2::jsonb)), updated_at = now()
         WHERE id = $1`,
        [
          runId,
          json({ step: stepKey, text: feedback, by: opts.by ?? "", at: new Date().toISOString() }),
        ],
      );
    const why = reexecute
      ? `re-executed with ${[feedback && (opts.persist !== false ? "instructions (kept for the rest of the run)" : "instructions"), pinned.length && `skills ${pinned.map((p) => `${p.key}@v${p.version}`).join(", ")}`].filter(Boolean).join(" + ")}`
      : "re-executed by user";
    await reexecuteTx(c, run, stepKey, pending, afterCommit, why);
    if (feedback) await runEvents.add(c, runId, "user", feedback);
    return;
  });
}

/** Retry = re-execute a FAILED/CANCELED step (same invalidation semantics). */
export const retryStep = (runId: number, stepKey: string, input?: Record<string, unknown>) =>
  reexecuteStep(runId, stepKey, { input });

/** One model call that judges feedback (injected: the agent layer provides it; null → fallback cues only). */
let feedbackModel: ((run: RunRow, prompt: string) => Promise<string>) | null = null;
export function setFeedbackModel(fn: typeof feedbackModel) {
  feedbackModel = fn;
}

/** Decide where feedback sends the run (no state change). Exposed so the UI can preview the route. */
export async function classifyRunFeedback(runId: number, message: string, mode: FeedbackMode) {
  const run = await getRun(runId);
  const signals = feedbackSignals(message, run.allowed_repositories, run.selected_repositories);
  let judgement: FeedbackJudgement | null = null;
  let modelError: string | undefined;
  if (mode === "auto" && feedbackModel) {
    const steps = await stepsOf(pool, runId);
    const wi = run.work_item_id
      ? await one<{ title: string; description: string }>(
          pool,
          "SELECT title, description FROM work_items WHERE id = $1",
          [run.work_item_id],
        )
      : null;
    try {
      judgement = parseJudgement(
        await feedbackModel(
          run,
          classificationPrompt({
            message,
            task: [run.title, wi?.title, wi?.description].filter(Boolean).join("\n"),
            selected: run.selected_repositories,
            completed: steps
              .filter((x) => x.status === "COMPLETED" && x.output)
              .map((x) => ({
                key: x.key,
                summary: String(x.output?.summary ?? JSON.stringify(x.output)).slice(0, 400),
              })),
          }),
        ),
      );
      if (!judgement) modelError = "unparseable classification reply";
    } catch (e) {
      modelError = (e as Error).message.slice(0, 200);
    }
  }
  const decision = decideFeedbackRoute({
    mode,
    signals,
    judgement,
    fallback: heuristicJudgement(message),
  });
  if (modelError)
    decision.reasons.push(`model classification unavailable (${modelError}); fallback cues used`);
  return { run, decision, ...routeTargets(run.graph, decision.route) };
}

/**
 * Developer feedback. Auto mode judges how far back the run must go (code fix → coding step; design → planning;
 * repository scope → discovery; requirement / full recheck → first steps); an explicit mode is the developer's call.
 * The chosen steps are re-executed through the normal re-execution path (dependants invalidated, history kept), the
 * feedback becomes a developer decision for every later step, and uncommitted work is snapshotted to a ref first.
 */
export async function sendFeedback(
  runId: number,
  message: string,
  opts: { mode?: FeedbackMode; by?: string } = {},
) {
  const mode = opts.mode ?? "auto";
  if (!FEEDBACK_MODES.includes(mode)) throw new EngineError(`unknown feedback mode: ${mode}`, 400);
  const { run, decision, route, targets } = await classifyRunFeedback(runId, message, mode);
  if (!targets.length) throw new EngineError("this workflow has no step that accepts feedback");
  if (run.status === "CANCELED") throw new EngineError("run is canceled");
  const id = `${Date.now().toString(36)}`;
  // Re-planning may discard the approach the code was written for: keep the uncommitted part retrievable.
  const snapshots: Array<{ repo: string; ref: string; commit: string; files: string[] }> = [];
  if (route !== "reimplement")
    for (const w of await workspacesOf(runId))
      try {
        const snap = await snapshotUncommitted(
          w.path,
          `refs/platform/replan/run-${runId}/${id}`,
          `platform: uncommitted work before ${route} (run ${runId})`,
        );
        if (snap) snapshots.push({ repo: w.repo, ...snap });
      } catch (e) {
        throw new EngineError(
          `${w.repo}: cannot snapshot uncommitted changes before ${route} (${(e as Error).message.split("\n")[0]}); commit or resolve them first`,
          409,
        );
      }
  const discovery = replanAnchors(run.graph).rediscover;
  const rediscover = route === "rediscover" || route === "restart";
  const replan = {
    id,
    at: new Date().toISOString(),
    by: opts.by ?? "",
    mode,
    route,
    source: decision.source,
    reasons: decision.reasons,
    signals: decision.signals,
    judgement: decision.judgement ?? null,
    targets,
    invalidated: [
      ...new Set(targets.flatMap((t) => [t, ...downstream(run.graph.steps, t)])),
    ].filter((k) => run.graph.steps.some((s) => s.key === k)),
    snapshots,
    feedback: message.slice(0, 4000),
  };
  return txThenRun(runId, async (c, afterCommit) => {
    let locked = await lockRun(c, runId);
    await adoptRun(c, runId);
    await q(
      c,
      `UPDATE workflow_runs SET inputs = coalesce(inputs, '{}'::jsonb)
         || jsonb_build_object('developer_decisions', coalesce(inputs->'developer_decisions', '[]'::jsonb) || jsonb_build_array($2::jsonb))
         || jsonb_build_object('replans', coalesce(inputs->'replans', '[]'::jsonb) || jsonb_build_array($3::jsonb)),
         updated_at = now() WHERE id = $1`,
      [
        runId,
        json({ step: targets[0], text: message, by: opts.by ?? "", at: replan.at, route }),
        json(replan),
      ],
    );
    const pending = { feedback: message, replan: { id, route, reasons: decision.reasons } };
    const rediscoverInput =
      rediscover && discovery ? { rediscover: { id, feedback: message } } : null;
    for (const t of targets) {
      locked = await lockRun(c, runId);
      const prev = await one<{ pending_input: any }>(
        c,
        "SELECT pending_input FROM workflow_steps WHERE run_id = $1 AND key = $2",
        [runId, t],
      );
      const skills = prev?.pending_input?.reexecute?.skills;
      const own = {
        ...pending,
        ...(Array.isArray(skills) && skills.length
          ? {
              reexecute: { instructions: null, skills, requested_by: opts.by ?? "", at: replan.at },
            }
          : {}),
      };
      await reexecuteTx(
        c,
        locked,
        t,
        t === discovery && rediscoverInput ? { ...own, ...rediscoverInput } : own,
        afterCommit,
        `feedback → ${route} (${decision.source})`,
        rediscoverInput && discovery ? { [discovery]: rediscoverInput } : undefined,
      );
    }
    await runEvents.add(
      c,
      runId,
      "user",
      `Feedback → ${route} [${decision.source}]: re-executing ${targets.join(", ")}${snapshots.length ? `; uncommitted work kept at ${snapshots.map((x) => `${x.repo}@${x.ref}`).join(", ")}` : ""}\n${decision.reasons.map((r) => `- ${r}`).join("\n")}\n\n${message}`,
      null,
      null,
      { replan },
    );
  });
}

/**
 * Step mode: execute one READY step of a PAUSED run now. The run stays paused, so nothing else starts; when the
 * step finishes its dependants become READY and can be run the same way (or the run resumed).
 */
export async function runStepNow(runId: number, stepKey: string) {
  return txThenRun(runId, async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    if (run.status !== "PAUSED")
      throw new EngineError(
        `run is ${run.status}: "run step" is for paused runs (step mode); running runs schedule steps automatically`,
      );
    await adoptRun(c, runId);
    await advance(c, runId, afterCommit);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [
      runId,
      stepKey,
    ]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (s.status !== "READY" && s.status !== "RETRYING")
      throw new EngineError(
        `step "${stepKey}" is ${s.status}; only READY steps can be run (dependencies must be complete)`,
      );
    await ensureJob(c, s);
    await q(
      c,
      "UPDATE workflow_jobs SET force = true, available_at = LEAST(available_at, now()) WHERE step_id = $1 AND status = 'queued'",
      [s.id],
    );
    await runEvents.add(c, runId, "user", `run step ${stepKey} (step mode)`, s.id);
    return;
  });
}

/** Stop a RUNNING step now: its attempt is canceled, the worker is fenced out and aborted; the step becomes FAILED. */
export async function stopStep(runId: number, stepKey: string, reason = "stopped by user") {
  return txThenRun(runId, async (c, afterCommit) => {
    await lockRun(c, runId);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [
      runId,
      stepKey,
    ]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (s.status !== "RUNNING" && s.status !== "RETRYING")
      throw new EngineError(`step "${stepKey}" is ${s.status}, not running`);
    const aborted = await cancelStepJobs(c, s.id, reason);
    await q(
      c,
      "UPDATE workflow_step_attempts SET status = 'CANCELED', finished_at = now(), error = $2 WHERE step_id = $1 AND status = 'RUNNING'",
      [s.id, json({ message: reason })],
    );
    await setStepStatus(c, s, "FAILED", { error: reason, finished_at: new Date() }, reason);
    await runEvents.add(c, runId, "user", `${reason}: ${stepKey}`, s.id);
    afterCommit(() => aborted.forEach((id) => localJobs.abort(id)));
    await advance(c, runId, afterCommit);
    return;
  });
}

export async function skipStep(runId: number, stepKey: string, reason = "skipped by user") {
  return txThenRun(runId, async (c, afterCommit) => {
    await lockRun(c, runId);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [
      runId,
      stepKey,
    ]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (!["PENDING", "READY", "FAILED", "WAITING_INPUT", "WAITING_APPROVAL"].includes(s.status))
      throw new EngineError(`cannot skip a ${s.status} step`);
    const aborted = await cancelStepJobs(c, s.id, reason);
    await q(
      c,
      "UPDATE workflow_questions SET status = 'dismissed' WHERE step_id = $1 AND status = 'open'",
      [s.id],
    );
    await setStepStatus(
      c,
      s,
      "SKIPPED",
      { output: { skipped: true, reason }, finished_at: new Date() },
      reason,
    );
    afterCommit(() => aborted.forEach((id) => localJobs.abort(id)));
    await advance(c, runId, afterCommit);
    return;
  });
}

// ---------------------------------------------------------------- human-in-the-loop

/**
 * Save answers. When a step has no open question left: a `human_input` step completes with the answers as
 * output; an agent step goes back to READY and its next attempt resumes from the persisted checkpoint.
 */
export async function answerQuestions(
  answers: Record<string, string>,
  answeredBy = "",
  guard?: WorkflowActionGuard,
) {
  const ids = Object.entries(answers)
    .filter(([, a]) => String(a ?? "").trim())
    .map(([id]) => Number(id));
  if (!ids.length) throw new EngineError("no answers given", 400);
  const runIds = (
    await q<{ run_id: number }>(
      pool,
      "SELECT DISTINCT run_id FROM workflow_questions WHERE id = ANY($1) AND status = 'open' ORDER BY run_id",
      [ids],
    )
  ).map((r) => r.run_id);
  if (!runIds.length) throw new EngineError("no open questions match", 400);
  const resumed: string[] = [];
  let answered = 0;
  for (const runId of runIds) {
    await withTx(async (c, afterCommit) => {
      await lockRun(c, runId);
      await guard?.(c);
      const qs = await q(
        c,
        "SELECT * FROM workflow_questions WHERE run_id = $1 AND id = ANY($2) AND status = 'open' FOR UPDATE",
        [runId, ids],
      );
      if (qs.length) {
        await q(
          c,
          `UPDATE workflow_questions q SET status='answered',answer=a.answer,answered_by=$3,answered_at=now()
          FROM unnest($1::bigint[],$2::text[]) AS a(id,answer) WHERE q.id=a.id`,
          [qs.map((x) => x.id), qs.map((x) => String(answers[x.id]).trim()), answeredBy],
        );
        answered += qs.length;
      }
      for (const stepId of new Set(qs.map((x) => x.step_id as number))) {
        const s = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1", [stepId]))!;
        if (s.pending_input?.provider_handoff) continue; // Record answers without scheduling a continuation.
        if (s.status !== "WAITING_INPUT") continue;
        // Answers to questions of an older attempt are recorded but never resume anything (no extra job).
        if (!qs.some((x) => x.step_id === stepId && x.attempt_id === s.current_attempt_id))
          continue;
        const open = await one<{ n: number }>(
          c,
          "SELECT count(*)::int AS n FROM workflow_questions WHERE step_id = $1 AND status = 'open'",
          [stepId],
        );
        if (open!.n) continue;
        await q(c, "UPDATE workflow_step_attempts SET resolved_at = now() WHERE id = $1", [
          s.current_attempt_id,
        ]);
        if (s.type === "human_input") {
          const all = await q(
            c,
            "SELECT id, question, answer FROM workflow_questions WHERE step_id = $1 AND status = 'answered' AND attempt_id = $2 ORDER BY id",
            [stepId, s.current_attempt_id],
          );
          const output = { answers: all };
          await q(
            c,
            "UPDATE workflow_step_attempts SET status = 'COMPLETED', output = $2, finished_at = now() WHERE id = $1",
            [s.current_attempt_id, json(output)],
          );
          await setStepStatus(c, s, "COMPLETED", { output, finished_at: new Date() }, "answered");
        } else {
          const cp = await one(
            c,
            "SELECT data FROM workflow_checkpoints WHERE attempt_id = $1 ORDER BY id DESC LIMIT 1",
            [s.current_attempt_id],
          );
          if (cp?.data?.recovery?.kind === "REQUIRES_RECONCILIATION") {
            const reply = await one<{ answer: string }>(
              c,
              "SELECT answer FROM workflow_questions WHERE id = $1 AND status = 'answered'",
              [cp.data.recovery.question_id],
            );
            if (
              !reply ||
              !/^(Reconciled — continue|Đã đối soát — tiếp tục|Stop here|Dừng ở đây)$/i.test(
                reply.answer.trim(),
              )
            )
              throw new EngineError(
                "Choose reconciled continue or stop; inspect external effects before retrying.",
                409,
              );
          }
          // A step paused by failure recovery: "stop" ends it as FAILED; anything else runs it again.
          const stop =
            (cp?.data?.failure || cp?.data?.recovery) &&
            (
              await q<{ answer: string }>(
                c,
                "SELECT answer FROM workflow_questions WHERE attempt_id = $1 AND status = 'answered'",
                [s.current_attempt_id],
              )
            ).some((a) => /^\s*(dừng|stop)\b/i.test(a.answer));
          if (stop) {
            await setStepStatus(
              c,
              s,
              "FAILED",
              {
                error: `stopped by the developer after ${cp.data.failure?.class ?? "interruption"} failure`,
                finished_at: new Date(),
              },
              "stopped after failure",
            );
          } else {
            const pending = {
              ...(s.pending_input ?? {}),
              resume: { from_attempt_id: s.current_attempt_id, checkpoint: cp?.data ?? {} },
            };
            await setStepStatus(
              c,
              s,
              "READY",
              { pending_input: pending, ready_at: new Date() },
              "answers received, resuming",
            );
          }
        }
        resumed.push(`${runId}:${s.key}`);
      }
      await advance(c, runId, afterCommit);
    });
  }
  const stillOpen = (await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM workflow_questions WHERE run_id = ANY($1) AND status = 'open'",
    [runIds],
  ))!.n;
  return { answered, resumed, stillOpen };
}

export async function approveStep(
  runId: number,
  stepKey: string,
  opts: {
    comment?: string;
    by?: string;
    repositories?: string[];
    data?: unknown;
    guard?: WorkflowActionGuard;
  } = {},
) {
  return txThenRun(runId, async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    await opts.guard?.(c);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [
      runId,
      stepKey,
    ]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (s.status !== "WAITING_APPROVAL")
      throw new EngineError(`step "${stepKey}" is ${s.status}, not WAITING_APPROVAL`);
    const decision = {
      granted: true,
      generation: s.generation,
      comment: opts.comment ?? "",
      by: opts.by ?? "",
      at: new Date(),
      ...(opts.data !== undefined ? { data: opts.data } : {}),
    };
    if (s.approval?.gate || s.type !== "human_approval") {
      // Gate before execution (requires_approval) or an executor asking for a go-ahead: run the step now.
      await setStepStatus(
        c,
        s,
        "READY",
        { approval: { ...(s.approval ?? {}), ...decision }, ready_at: new Date() },
        "approved",
      );
    } else {
      let repos: string[] | undefined;
      if (s.config.select_repositories) {
        repos = opts.repositories ?? s.approval?.request?.recommended ?? run.selected_repositories;
        if (!repos?.length) throw new EngineError("select at least one repository", 400);
        await setSelectedRepositories(c, run, repos);
      }
      // Branches to review (and to commit fixes on), entered with the repositories: one per repository (`branches`),
      // and/or one for all the others (`branch`). A repository without one is reviewed on the base branch.
      if (s.config.ask_branch && opts.data && typeof opts.data === "object") {
        const d = opts.data as { branch?: unknown; branches?: Record<string, unknown> };
        const clean = (v: unknown) =>
          typeof v === "string" ? v.trim().replace(/^origin\//, "") : "";
        const common = clean(d.branch);
        const chosen = repos ?? run.selected_repositories;
        const perRepo: Record<string, string> = {};
        for (const r of chosen) {
          const b = clean(d.branches?.[r]) || common;
          if (b) perRepo[r] = b;
        }
        try {
          normalizeBranchMap(perRepo, config.baseBranch);
        } catch (e) {
          throw new EngineError((e as Error).message, 400);
        }
        const distinct = [...new Set(Object.values(perRepo))];
        const single =
          distinct.length === 1 && Object.keys(perRepo).length === chosen.length
            ? distinct[0]
            : null;
        await q(
          c,
          `UPDATE workflow_runs SET inputs = coalesce(inputs, '{}'::jsonb) || jsonb_build_object('branch', $2::text, 'branches', $3::jsonb), updated_at = now() WHERE id = $1`,
          [runId, single, Object.keys(perRepo).length ? json(perRepo) : null],
        );
      }
      // Evidence-gated approval: the approved scope is the proposal frozen at request time. A gap in the evidence gate
      // (e.g. a HIGH-risk state change on an unconfirmed root cause) needs an explicit, recorded acknowledgement.
      const scope = s.approval?.request?.scope;
      const acknowledged = Boolean(
        opts.data && typeof opts.data === "object" && (opts.data as any).acknowledge_risk === true,
      );
      if (scope && s.approval?.request?.requires_risk_acknowledgement && !acknowledged)
        throw new EngineError(
          `this proposal is ${scope.risk ?? "?"} risk with an unmet evidence gate (${(scope.gate?.missing ?? []).slice(0, 4).join("; ") || "invariants not verified"}): approving it requires an explicit risk acknowledgement`,
          400,
        );
      if (scope && acknowledged && !decision.comment.trim())
        throw new EngineError(
          "acknowledging an unmet evidence gate requires a comment explaining why",
          400,
        );
      const output = {
        approved: true,
        comment: decision.comment,
        by: decision.by,
        ...(repos ? { repositories: repos } : {}),
        ...(scope
          ? {
              approved_scope: {
                ...scope,
                approved_by: decision.by,
                approved_at: decision.at,
                comment: decision.comment,
                risk_acknowledged: acknowledged,
              },
            }
          : {}),
      };
      if (s.current_attempt_id)
        await q(
          c,
          "UPDATE workflow_step_attempts SET status = 'COMPLETED', output = $2, resolved_at = now(), finished_at = now() WHERE id = $1",
          [s.current_attempt_id, json(output)],
        );
      await setStepStatus(
        c,
        s,
        "COMPLETED",
        { output, approval: { ...(s.approval ?? {}), ...decision }, finished_at: new Date() },
        "approved",
      );
    }
    if (opts.comment)
      await runEvents.add(c, runId, "user", `approved ${stepKey}: ${opts.comment}`, s.id);
    await advance(c, runId, afterCommit);
    return;
  });
}

export async function rejectStep(
  runId: number,
  stepKey: string,
  opts: { comment?: string; by?: string; reexecute?: string; guard?: WorkflowActionGuard } = {},
) {
  return txThenRun(runId, async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    await opts.guard?.(c);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [
      runId,
      stepKey,
    ]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (s.status !== "WAITING_APPROVAL")
      throw new EngineError(`step "${stepKey}" is ${s.status}, not WAITING_APPROVAL`);
    const comment = opts.comment ?? "";
    const target = opts.reexecute ?? s.config.on_reject?.reexecute;
    await runEvents.add(
      c,
      runId,
      "user",
      `rejected ${stepKey}${comment ? `: ${comment}` : ""}`,
      s.id,
    );
    if (target) {
      if (
        !run.graph.steps.some((x) => x.key === target) ||
        !downstream(run.graph.steps, target).has(stepKey)
      )
        throw new EngineError(`"${target}" is not upstream of "${stepKey}"`, 400);
      // The approval step itself is downstream of the target, so it is reset and will ask again.
      await reexecuteTx(
        c,
        run,
        target,
        { feedback: `Reviewer rejected at "${s.name}": ${comment}` },
        afterCommit,
        `re-executed after rejection of ${stepKey}`,
      );
    } else {
      if (s.current_attempt_id)
        await q(
          c,
          "UPDATE workflow_step_attempts SET status = 'FAILED', error = $2, resolved_at = now(), finished_at = now() WHERE id = $1",
          [s.current_attempt_id, json({ message: `rejected: ${comment}` })],
        );
      await setStepStatus(
        c,
        s,
        "FAILED",
        {
          error: `rejected: ${comment}`,
          approval: {
            ...(s.approval ?? {}),
            granted: false,
            comment,
            by: opts.by ?? "",
            at: new Date(),
          },
        },
        "rejected",
      );
      await advance(c, runId, afterCommit);
    }
    return;
  });
}

// ---------------------------------------------------------------- worker side

export interface BegunAttempt {
  run: RunRow;
  step: StepRow;
  attempt: AttemptRow;
  input: StepInput;
  context: ResolvedContext;
}

/** Claim-time validation + attempt creation. Returns null when the job is stale (nothing to do). */
export async function beginAttempt(job: JobRow, worker: string): Promise<BegunAttempt | null> {
  return withTx(async (c) => {
    const run = await lockRun(c, job.run_id);
    if (run.worker_instance !== config.instanceId || !(await ownsInstance(c))) return null;
    if (run.owner_id == null) {
      await q(
        c,
        "UPDATE workflow_jobs SET status = 'canceled', last_error = 'unassigned owner', updated_at = now() WHERE id = $1",
        [job.id],
      );
      return null;
    }
    const owner = await one<{ active: boolean }>(c, "SELECT active FROM users WHERE id = $1", [
      run.owner_id,
    ]);
    if (!owner?.active) {
      await q(
        c,
        "UPDATE workflow_jobs SET status = 'canceled', last_error = 'owner inactive', updated_at = now() WHERE id = $1",
        [job.id],
      );
      return null;
    }
    const j = await one<JobRow>(
      c,
      "SELECT * FROM workflow_jobs WHERE id = $1 AND lease_expires_at > clock_timestamp() FOR UPDATE",
      [job.id],
    );
    if (!j || j.status !== "running" || j.fencing_token !== job.fencing_token) return null;
    const step = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1 FOR UPDATE", [
      j.step_id,
    ]))!;
    const runnable =
      !["PAUSED", "CANCELED", "PENDING"].includes(run.status) ||
      (run.status === "PAUSED" && (j as any).force === true);
    if (
      step.generation !== j.generation ||
      !["READY", "RETRYING"].includes(step.status) ||
      !runnable
    ) {
      // Paused runs: hand the job back untouched; everything else is stale.
      if (run.status === "PAUSED" && step.generation === j.generation)
        await q(
          c,
          "UPDATE workflow_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1",
          [j.id],
        );
      else
        await q(
          c,
          "UPDATE workflow_jobs SET status = 'canceled', last_error = 'stale job', updated_at = now() WHERE id = $1",
          [j.id],
        );
      return null;
    }
    // Run lock makes this a durable reader/writer gate over the existing shared run worktrees.
    const consumers = ["agent", "coding_agent", "command", "git_pull_request"];
    const writers = ["coding_agent", "command", "git_pull_request"];
    if (
      consumers.includes(step.type) &&
      (await one(
        c,
        `SELECT a.id FROM workflow_step_attempts a JOIN workflow_steps s ON s.id=a.step_id
      WHERE a.run_id=$1 AND (a.status='RUNNING' OR a.job_id=ANY($5::bigint[])) AND s.type=ANY($2::text[])
      AND ($3::boolean OR s.type=ANY($4::text[])) LIMIT 1`,
        [run.id, consumers, writers.includes(step.type), writers, localJobs.activeIds()],
      ))
    ) {
      await q(
        c,
        "UPDATE workflow_jobs SET status='queued', lease_owner=NULL, lease_expires_at=NULL, available_at=now()+interval '1 second', updated_at=now() WHERE id=$1",
        [j.id],
      );
      return null;
    }
    const effective = resolveStepAgent(run, step);
    step.config = effectiveStepConfig(step.config, effective);
    const { n } = (await one<{ n: number }>(
      c,
      "SELECT COALESCE(max(number), 0)::int + 1 AS n FROM workflow_step_attempts WHERE step_id = $1",
      [step.id],
    ))!;
    const contextPreparationStarted = performance.now();
    const input = await buildStepInput(c, run, step);
    const context = await resolveContext(c, run, step, input, effective?.provider ?? null);
    const contextPreparationMs = performance.now() - contextPreparationStarted;
    const attempt = (await one<AttemptRow>(
      c,
      `INSERT INTO workflow_step_attempts (step_id, run_id, number, generation, status, job_id, fencing_token, worker, input, context_snapshot_id, metrics, agent_provider, agent_model, effective_agent)
       VALUES ($1, $2, $3, $4, 'RUNNING', $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        step.id,
        run.id,
        n,
        step.generation,
        j.id,
        j.fencing_token,
        worker,
        json(input),
        context.snapshot_id,
        json({ context_preparation_ms: contextPreparationMs }),
        effective?.provider ?? null,
        effective?.model ?? null,
        effective ? json(effective) : null,
      ],
    ))!;
    if (step.pending_input?.provider_handoff?.id) {
      const linked = await q(
        c,
        "UPDATE provider_handoffs SET target_attempt_id=$2 WHERE id=$1 AND status='RESUMED' AND target_attempt_id IS NULL AND step_id=$3 AND generation=$4 RETURNING id",
        [step.pending_input.provider_handoff.id, attempt.id, step.id, step.generation],
      );
      if (
        !linked.length &&
        !(await one(
          c,
          "SELECT id FROM provider_handoffs WHERE id=$1 AND step_id=$2 AND generation=$3 AND status='RESUMED' AND target_attempt_id IS NOT NULL",
          [step.pending_input.provider_handoff.id, step.id, step.generation],
        ))
      )
        throw new EngineError("Handoff continuation stale", 409);
    }
    await setStepStatus(
      c,
      step,
      "RUNNING",
      {
        current_attempt_id: attempt.id,
        attempt_count: step.attempt_count + 1,
        started_at: new Date(),
        error: null,
      },
      `attempt #${n}`,
    );
    return { run, step, attempt, input, context };
  });
}

/** Extend the lease iff we still hold the job. false = fenced out (canceled, re-executed, reaped). */
export async function heartbeat(jobId: number, token: number, leaseSeconds: number) {
  const r = await pool.query(
    `UPDATE workflow_jobs SET lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
      WHERE id = $1 AND fencing_token = $2 AND status = 'running' AND lease_expires_at > clock_timestamp()
        AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id = workflow_jobs.run_id AND r.worker_instance = $4)
        AND NOT EXISTS (SELECT 1 FROM platform_instances i WHERE i.instance_id = $4 AND (i.session_id <> $5 OR i.stopped_at IS NOT NULL))`,
    [jobId, token, leaseSeconds, config.instanceId, instanceSession],
  );
  return r.rowCount === 1;
}

export async function insertQuestions(
  c: Db,
  step: StepRow,
  attemptId: number,
  qs: QuestionInput[],
) {
  for (const x of qs)
    await q(
      c,
      "INSERT INTO workflow_questions (run_id, step_id, attempt_id, question, context, options, suggested_answer) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        step.run_id,
        step.id,
        attemptId,
        x.question,
        x.context ?? "",
        json(x.options ?? []),
        x.suggested_answer ?? x.options?.[0] ?? null,
      ],
    );
}

async function applyResult(
  c: pg.PoolClient,
  run: RunRow,
  step: StepRow,
  attempt: AttemptRow,
  jobId: number | null,
  result: ExecResult,
  afterCommit: AfterCommit,
) {
  if (result.kind === "failed")
    await q(
      c,
      `UPDATE workflow_step_attempts SET metrics = COALESCE(metrics, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [
        attempt.id,
        json({
          normalized_failure_category: normalizeProviderFailure(result.error),
          failure_diagnostics: safeDiagnostics(result.error),
        }),
      ],
    );

  const now = new Date();
  const closeJob = (status: "done" | "failed", err: string | null = null) =>
    jobId
      ? q(
          c,
          "UPDATE workflow_jobs SET status = $2, last_error = $3, lease_expires_at = NULL, updated_at = now() WHERE id = $1",
          [jobId, status, err],
        )
      : null;
  const closeAttempt = (status: AttemptRow["status"], output: unknown, error: unknown = null) =>
    q(
      c,
      "UPDATE workflow_step_attempts SET status = $2, output = $3, error = $4, finished_at = now() WHERE id = $1",
      [attempt.id, status, json(output), json(error)],
    );

  switch (result.kind) {
    case "completed": {
      const out: any = result.output ?? {};
      if (Array.isArray(out?.selected_repositories))
        await setSelectedRepositories(c, run, out.selected_repositories);
      await closeAttempt("COMPLETED", out);
      await setStepStatus(c, step, "COMPLETED", {
        output: out,
        pending_input: null,
        error: null,
        finished_at: now,
      });
      await closeJob("done");
      break;
    }
    case "waiting_input": {
      if (result.questions?.length) await insertQuestions(c, step, attempt.id, result.questions);
      const open = (await one<{ n: number }>(
        c,
        "SELECT count(*)::int AS n FROM workflow_questions WHERE attempt_id = $1 AND status = 'open'",
        [attempt.id],
      ))!.n;
      if (!open)
        return applyResult(
          c,
          run,
          step,
          attempt,
          jobId,
          { kind: "failed", error: "step requested input but asked no question", retryable: false },
          afterCommit,
        );
      await closeAttempt("WAITING_INPUT", result.output ?? null);
      await q(
        c,
        "INSERT INTO workflow_checkpoints (run_id, step_id, attempt_id, reason, data) VALUES ($1, $2, $3, 'waiting_input', $4)",
        [run.id, step.id, attempt.id, json(result.checkpoint ?? {})],
      );
      await setStepStatus(c, step, "WAITING_INPUT", {}, `${open} question(s)`);
      await closeJob("done");
      afterCommit(() =>
        background(`notify run ${run.id}`, () => {
          const en = outputLocale(run) === "en";
          return notifyStepWaiting(
            en
              ? `❓ Run #${run.id} (${run.title}) – ${step.name} has ${open} question(s) to answer`
              : `❓ Run #${run.id} (${run.title}) – bước ${step.name} có ${open} câu hỏi cần trả lời`,
            {
              runId: run.id,
              runTitle: run.title,
              stepKey: step.key,
              stepName: step.name,
              status: "WAITING_INPUT",
              detail: (result.output as any)?.diagnosis?.summary
                ? `${(result.output as any).diagnosis.summary} — ${en ? "choose how to proceed" : "chọn cách xử lý"}`
                : en
                  ? `${open} question(s) to answer`
                  : `${open} câu hỏi cần trả lời`,
              stepId: step.id,
              generation: step.generation,
              attemptId: attempt.id,
              locale: outputLocale(run),
              ownerId: run.owner_id ?? undefined,
            },
          );
        }),
      );
      break;
    }
    case "waiting_approval": {
      await closeAttempt("WAITING_APPROVAL", result.request);
      await q(
        c,
        "INSERT INTO workflow_checkpoints (run_id, step_id, attempt_id, reason, data) VALUES ($1, $2, $3, 'waiting_approval', $4)",
        [run.id, step.id, attempt.id, json(result.checkpoint ?? {})],
      );
      await setStepStatus(c, step, "WAITING_APPROVAL", {
        approval: { request: result.request, generation: step.generation, requested_at: now },
      });
      await closeJob("done");
      afterCommit(() =>
        background(`notify run ${run.id}`, () => {
          const en = outputLocale(run) === "en";
          return notifyStepWaiting(
            en
              ? `✋ Run #${run.id} (${run.title}) – ${step.name} is waiting for approval`
              : `✋ Run #${run.id} (${run.title}) – bước ${step.name} chờ duyệt`,
            {
              runId: run.id,
              runTitle: run.title,
              stepKey: step.key,
              stepName: step.name,
              status: "WAITING_APPROVAL",
              detail: String(
                (result.request as any)?.message ??
                  (step.type === "task_result_report"
                    ? en
                      ? "review the task result report"
                      : "xem lại báo cáo kết quả task"
                    : en
                      ? "waiting for approval"
                      : "chờ duyệt"),
              ).slice(0, 300),
              stepId: step.id,
              generation: step.generation,
              attemptId: attempt.id,
              locale: outputLocale(run),
              ownerId: run.owner_id ?? undefined,
            },
          );
        }),
      );
      break;
    }
    case "reexecute": {
      // Close this attempt first (it decided), then re-execute the target: this step is downstream and becomes PENDING.
      await closeAttempt("COMPLETED", result.output ?? { reexecute: result.target });
      await closeJob("done");
      await reexecuteTx(
        c,
        run,
        result.target,
        { feedback: result.feedback },
        afterCommit,
        `re-executed by ${step.key} (developer decision after test failure)`,
      );
      return;
    }
    case "failed": {
      const decision = classifyFailure(result.error, {
        executorRetryable: result.retryable,
        attempt: step.attempt_count,
        maxAttempts: attempt.effective_agent?.retry?.max_attempts ?? step.max_attempts,
        baseBackoff: attempt.effective_agent?.retry?.backoff_seconds ?? step.retry_backoff_s,
      });
      await closeAttempt("FAILED", null, {
        message: result.error,
        details: result.details ?? null,
        failure: decision,
      });
      if (decision.action === "human") {
        // Pause instead of failing: the developer resolves the cause and answers; the step then runs again.
        const en = outputLocale(run) === "en";
        await insertQuestions(c, step, attempt.id, [
          {
            question: en
              ? `Step "${step.name}" needs you (${decision.class}): ${result.error.slice(0, 600)}`
              : `Bước "${step.name}" cần bạn xử lý (${decision.class}): ${result.error.slice(0, 600)}`,
            context: decision.reason,
            options: en
              ? ["Rerun this step", "Stop here"]
              : ["Đã xử lý xong — chạy lại bước", "Dừng ở đây"],
          },
        ]);
        await q(
          c,
          "INSERT INTO workflow_checkpoints (run_id, step_id, attempt_id, reason, data) VALUES ($1, $2, $3, 'waiting_input', $4)",
          [run.id, step.id, attempt.id, json({ failure: decision })],
        );
        await setStepStatus(c, step, "WAITING_INPUT", {}, `paused: ${decision.class}`);
        await closeJob("done", result.error);
        afterCommit(() =>
          background(`notify run ${run.id}`, () =>
            notifyStepWaiting(
              en
                ? `⏸ Run #${run.id} (${run.title}) – ${step.name} is paused: ${decision.class}`
                : `⏸ Run #${run.id} (${run.title}) – bước ${step.name} tạm dừng: ${decision.class}`,
              {
                runId: run.id,
                runTitle: run.title,
                stepKey: step.key,
                stepName: step.name,
                status: "WAITING_INPUT",
                detail: decision.reason,
                stepId: step.id,
                generation: step.generation,
                attemptId: attempt.id,
                locale: outputLocale(run),
                ownerId: run.owner_id ?? undefined,
              },
            ),
          ),
        );
        break;
      }
      if (decision.action === "retry") {
        await setStepStatus(
          c,
          step,
          "RETRYING",
          { error: result.error },
          `attempt ${step.attempt_count}/${step.max_attempts} failed (${decision.class}); retry in ${decision.delay_s}s`,
        );
        await closeJob("done", result.error);
        // Automatic retries are budget-checked too: a projected overrun pauses the run (the queued job waits for resume).
        if (step.type === "agent" || step.type === "coding_agent")
          await budgetPreflight(c, run, step);
        await ensureJob(c, step, decision.delay_s);
      } else {
        await setStepStatus(c, step, "FAILED", { error: result.error, finished_at: now });
        await closeJob("failed", result.error);
        afterCommit(() =>
          background(`notify run ${run.id}`, () =>
            notify(
              `❌ Run #${run.id} (${run.title}) – bước ${step.name} lỗi: ${result.error.slice(0, 300)}`,
              `/runs/${run.id}`,
            ),
          ),
        );
      }
      break;
    }
  }
  await advance(c, run.id, afterCommit);
}

/**
 * Apply an executor's result. Discarded (attempt marked STALE) if the job was fenced out or the step was
 * re-executed meanwhile — output computed from invalidated context is never written back.
 */
export async function finishAttempt(
  jobId: number,
  token: number,
  attemptId: number,
  result: ExecResult,
  handoff?: PreparedHandoff,
) {
  return withTx(async (c, afterCommit) => {
    const attempt0 = await one<AttemptRow>(
      c,
      "SELECT run_id FROM workflow_step_attempts WHERE id = $1",
      [attemptId],
    );
    if (!attempt0) return { applied: false, reason: "attempt not found" };
    const run = await lockRun(c, attempt0.run_id);
    const j = await one<JobRow>(c, "SELECT * FROM workflow_jobs WHERE id = $1 FOR UPDATE", [jobId]);
    const attempt = (await one<AttemptRow>(
      c,
      "SELECT * FROM workflow_step_attempts WHERE id = $1 FOR UPDATE",
      [attemptId],
    ))!;
    if (attempt.status !== "RUNNING")
      return { applied: false, reason: `attempt already ${attempt.status}` };
    const step = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1 FOR UPDATE", [
      attempt.step_id,
    ]))!;
    const live = await one(
      c,
      "SELECT 1 FROM workflow_jobs WHERE id = $1 AND lease_expires_at > clock_timestamp()",
      [jobId],
    );
    const fenced =
      !j ||
      j.id !== attempt.job_id ||
      j.run_id !== run.id ||
      j.step_id !== step.id ||
      j.status !== "running" ||
      j.fencing_token !== token ||
      !live ||
      run.worker_instance !== config.instanceId ||
      !(await ownsInstance(c));
    const stale =
      step.current_attempt_id !== attempt.id ||
      step.generation !== attempt.generation ||
      step.status !== "RUNNING";
    if (fenced && !stale && j?.status === "running") {
      // Keep RUNNING until the reaper reconciles this attempt. Marking it STALE here would strand its RUNNING step.
      return { applied: false, reason: "lease lost (fenced out); awaiting reconciliation" };
    }
    if (fenced || stale) {
      const reason = fenced ? "lease lost (fenced out)" : "step was invalidated while running";
      await q(
        c,
        "UPDATE workflow_step_attempts SET status = 'STALE', output = $2, error = $3, finished_at = now() WHERE id = $1",
        [
          attempt.id,
          json(result.kind === "completed" ? result.output : null),
          json({ message: reason }),
        ],
      );
      await runEvents.add(
        c,
        run.id,
        "system",
        `${step.key}: attempt #${attempt.number} result discarded: ${reason}`,
        step.id,
        attempt.id,
      );
      return { applied: false, reason };
    }
    const request = await one(
      c,
      "SELECT * FROM provider_handoffs WHERE source_attempt_id=$1 AND status='STOPPING' FOR UPDATE",
      [attempt.id],
    );
    // A request may commit after the scheduler inspected the result. Keep that race fail-closed.
    if (request && attempt.executor_stopped_at && !handoff)
      handoff = {
        blocked:
          "Switch request arrived after checkpoint preparation; reinspect the stopped executor's preserved state",
      };
    if (handoff && attempt.executor_stopped_at && (request || handoff.failure)) {
      await persistProviderPause(c, run, step, attempt, j!, result, handoff, request, afterCommit);
    } else {
      await applyResult(c, run, step, attempt, jobId, result, afterCommit);
      await enforceBudget(c, run, step.id, attempt.id);
    }
    return { applied: true };
  });
}

/**
 * Validate the existing owner before starting/resuming/retrying. Local workspaces never move with an API action.
 */
async function adoptRun(c: Db, runId: number) {
  const run = await one(c, "SELECT worker_instance FROM workflow_runs WHERE id = $1", [runId]);
  if (run?.worker_instance !== config.instanceId)
    throw new EngineError(
      run?.worker_instance
        ? `Run belongs to ${run.worker_instance}; continue on that installation. Ownership is never transferred automatically.`
        : "Legacy run has no assigned instance. An administrator must verify its worktrees and explicitly assign worker_instance.",
      409,
    );
}

// ---------------------------------------------------------------- queries

export async function getRun(runId: number, db: Db = pool) {
  // Both reads go out together on the pool (one round trip); inside a transaction the client queues them anyway.
  const [run, steps] = await Promise.all([
    one<RunRow>(db, "SELECT * FROM workflow_runs WHERE id = $1", [runId]),
    stepsOf(db, runId),
  ]);
  if (!run) throw new EngineError(`run ${runId} not found`, 404);
  return { ...run, steps };
}

/**
 * A run-changing transaction whose caller wants the run back: commit first, then read the run on the pool (run + steps
 * in parallel). Inside the transaction those reads would be two more sequential round trips holding the run lock.
 */
async function txThenRun(
  runId: number,
  fn: (c: pg.PoolClient, afterCommit: AfterCommit) => Promise<void>,
) {
  await withTx(fn);
  return getRun(runId);
}

export function listRuns(
  filter: {
    workItemId?: number;
    status?: string;
    limit?: number;
    ownerId?: number;
    all?: boolean;
  } = {},
  db: Db = pool,
) {
  const scope = filter.all
    ? "AND r.owner_id IS NOT NULL"
    : filter.ownerId
      ? "AND r.owner_id = " + Number(filter.ownerId)
      : "";
  return q(
    db,
    `SELECT r.id, r.definition_key, r.work_item_id, r.title, r.status, r.branch, r.selected_repositories, r.output_locale, r.agent_provider, r.owner_id, r.created_at, r.updated_at, r.finished_at,
            v.version AS definition_version, w.code AS work_item_code,
            (SELECT count(*)::int FROM workflow_questions qq WHERE qq.run_id = r.id AND qq.status = 'open') AS open_questions,
            (SELECT json_agg(json_build_object('key', s.key, 'status', s.status) ORDER BY s.position) FROM workflow_steps s WHERE s.run_id = r.id) AS steps
       FROM workflow_runs r JOIN workflow_definition_versions v ON v.id = r.definition_version_id
       LEFT JOIN work_items w ON w.id = r.work_item_id
      WHERE ($1::bigint IS NULL OR r.work_item_id = $1) AND ($2::text IS NULL OR r.status = $2) ${scope}
      ORDER BY r.id DESC LIMIT $3`,
    [filter.workItemId ?? null, filter.status ?? null, filter.limit ?? 100],
  );
}

/** Run page payload. All reads go out together (one round-trip of latency, not one per query). */
export async function runDetail(runId: number) {
  const [run, steps, attempts, questions, artifacts, prs, workspaces, checkpoints] =
    await Promise.all([
      one<
        RunRow & {
          definition_version: number;
          wi_id: number | null;
          wi_code: string;
          wi_title: string;
          wi_source: string;
          wi_project: string;
        }
      >(
        pool,
        `SELECT r.*, v.version AS definition_version, w.id AS wi_id, w.code AS wi_code, w.title AS wi_title, w.source AS wi_source, w.project AS wi_project
         FROM workflow_runs r LEFT JOIN workflow_definition_versions v ON v.id = r.definition_version_id LEFT JOIN work_items w ON w.id = r.work_item_id
        WHERE r.id = $1`,
        [runId],
      ),
      stepsOf(pool, runId),
      q(
        pool,
        "SELECT a.*, s.key AS step_key FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE a.run_id = $1 ORDER BY a.id",
        [runId],
      ),
      q(
        pool,
        "SELECT q.*, s.key AS step_key FROM workflow_questions q JOIN workflow_steps s ON s.id = q.step_id WHERE q.run_id = $1 ORDER BY q.id",
        [runId],
      ),
      q(
        pool,
        "SELECT id, step_id, attempt_id, kind, name, length(content) AS size, data, created_at FROM workflow_artifacts WHERE run_id = $1 ORDER BY id",
        [runId],
      ),
      q(pool, "SELECT * FROM pull_requests WHERE run_id = $1 ORDER BY id", [runId]),
      q(pool, "SELECT * FROM execution_workspaces WHERE run_id = $1 ORDER BY id", [runId]),
      q(
        pool,
        "SELECT id, step_id, attempt_id, reason, data, created_at FROM workflow_checkpoints WHERE run_id = $1 ORDER BY id",
        [runId],
      ),
    ]);
  if (!run) throw new EngineError(`run ${runId} not found`, 404);
  const { wi_id, wi_code, wi_title, wi_source, wi_project, ...row } = run;
  const work_item =
    wi_id != null
      ? { id: wi_id, code: wi_code, title: wi_title, source: wi_source, project: wi_project }
      : null;
  const worker = await instanceHealth(row.worker_instance ?? null);
  const recovery = steps.some((s) => s.status === "WAITING_INPUT" && s.pending_input?.recovery)
    ? "NEEDS_ATTENTION"
    : steps.some((s) => ["READY", "RUNNING"].includes(s.status) && s.pending_input?.recovery)
      ? "RECOVERING"
      : !["COMPLETED", "CANCELED", "FAILED"].includes(row.status) && worker.health !== "ONLINE"
        ? "WAITING_FOR_WORKER"
        : null;
  return {
    ...row,
    worker: {
      ...worker,
      local: row.worker_instance === config.instanceId,
      available: worker.health === "ONLINE",
      recovery,
    },
    steps,
    work_item,
    attempts,
    questions,
    artifacts,
    pull_requests: prs,
    workspaces,
    checkpoints,
  };
}

/** Everything the step inspector shows for one step. */
export async function stepDetail(runId: number, stepKey: string) {
  // Every query addresses the step by (run, key) so all of them go out together.
  const sid = "(SELECT id FROM workflow_steps WHERE run_id = $1 AND key = $2)";
  const args = [runId, stepKey];
  const [step, attempts, questions, checkpoints, artifacts, sessions, snapshots, jobs, handoffs] =
    await Promise.all([
      one<StepRow>(pool, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", args),
      q(pool, `SELECT * FROM workflow_step_attempts WHERE step_id = ${sid} ORDER BY number`, args),
      q(pool, `SELECT * FROM workflow_questions WHERE step_id = ${sid} ORDER BY id`, args),
      q(pool, `SELECT * FROM workflow_checkpoints WHERE step_id = ${sid} ORDER BY id`, args),
      q(
        pool,
        `SELECT id, attempt_id, kind, name, length(content) AS size, data, created_at FROM workflow_artifacts WHERE step_id = ${sid} ORDER BY id`,
        args,
      ),
      q(
        pool,
        `SELECT s.* FROM agent_sessions s JOIN workflow_step_attempts a ON a.id = s.attempt_id WHERE a.step_id = ${sid} ORDER BY s.id`,
        args,
      ),
      q(
        pool,
        `SELECT id, hash, content, created_at FROM context_snapshots WHERE step_id = ${sid} ORDER BY id`,
        args,
      ),
      q(
        pool,
        `SELECT id, status, generation, available_at, lease_owner, lease_expires_at, claims, force, last_error FROM workflow_jobs WHERE step_id = ${sid} ORDER BY id DESC LIMIT 10`,
        args,
      ),
      q(
        pool,
        `SELECT h.*,m.previous_attempt_duration_ms,m.handoff_duration_ms,m.new_attempt_duration_ms,m.retry_count,m.reported_cost_usd,m.final_verification_result FROM provider_handoffs h LEFT JOIN provider_handoff_metrics m ON m.id=h.id WHERE h.step_id=${sid} ORDER BY h.id`,
        args,
      ),
    ]);
  if (!step) throw new EngineError(`step "${stepKey}" not found`, 404);
  return { step, attempts, questions, checkpoints, artifacts, sessions, snapshots, jobs, handoffs };
}

export function openQuestions(db: Db = pool, scope?: { ownerId?: number; all?: boolean }) {
  const extra = !scope
    ? ""
    : scope.all
      ? "AND r.owner_id IS NOT NULL"
      : "AND r.owner_id = " + Number(scope.ownerId);
  return q(
    db,
    `SELECT q.*, s.key AS step_key, s.name AS step_name, s.type AS step_type, r.title AS run_title, r.status AS run_status, w.code AS work_item_code
       FROM workflow_questions q JOIN workflow_steps s ON s.id = q.step_id JOIN workflow_runs r ON r.id = q.run_id
       LEFT JOIN work_items w ON w.id = r.work_item_id
      WHERE q.status = 'open' ${extra} ORDER BY q.created_at`,
  );
}

/**
 * Steps waiting for a human approval (same owner scoping as openQuestions), for the "Questions & approvals" inbox.
 * `quick` = can be decided from the inbox (and Telegram) with approve/reject + comment; repository selection, branch
 * input and fenced provider handoffs need the full step UI. Step outputs are not copied here (they stay in the run).
 */
export async function openApprovals(db: Db = pool, scope?: { ownerId?: number; all?: boolean }) {
  const extra = !scope
    ? ""
    : scope.all
      ? "AND r.owner_id IS NOT NULL"
      : "AND r.owner_id = " + Number(scope.ownerId);
  const rows = await q<any>(
    db,
    `SELECT s.id AS step_id, s.run_id, s.key AS step_key, s.name AS step_name, s.type AS step_type, s.updated_at,
            s.approval->'request' AS request, s.config->'on_reject'->>'reexecute' AS reexecute,
            (s.pending_input ? 'provider_handoff') AS provider_handoff,
            r.title AS run_title, r.status AS run_status, w.code AS work_item_code
       FROM workflow_steps s JOIN workflow_runs r ON r.id = s.run_id
       LEFT JOIN work_items w ON w.id = r.work_item_id
      WHERE s.status = 'WAITING_APPROVAL' AND r.status NOT IN ('CANCELED', 'COMPLETED', 'FAILED') ${extra}
      ORDER BY s.updated_at`,
  );
  return rows.map(({ request, ...r }) => {
    const req = request ?? {};
    return {
      ...r,
      message: typeof req.message === "string" ? req.message : null,
      risk: req.scope?.risk ?? req.scope?.gate?.fix_risk ?? null,
      gate_missing: Array.isArray(req.scope?.gate?.missing)
        ? req.scope.gate.missing.slice(0, 6)
        : [],
      requires_risk_acknowledgement: req.requires_risk_acknowledgement === true,
      quick:
        !req.select_repositories &&
        !req.ask_branch &&
        !r.provider_handoff &&
        r.step_type !== "git_pull_request",
    };
  });
}

export function answeredQuestions(
  limit = 100,
  db: Db = pool,
  scope?: { ownerId?: number; all?: boolean },
) {
  const extra = !scope
    ? ""
    : scope.all
      ? "AND r.owner_id IS NOT NULL"
      : "AND r.owner_id = " + Number(scope.ownerId);
  return q(
    db,
    `SELECT q.*, s.key AS step_key, s.name AS step_name, s.status AS step_status, r.title AS run_title
       FROM workflow_questions q JOIN workflow_steps s ON s.id = q.step_id JOIN workflow_runs r ON r.id = q.run_id
      WHERE q.status = 'answered' ${extra} ORDER BY q.answered_at DESC LIMIT $1`,
    [limit],
  );
}

/** Caller must pass through requireRun; config is server-owned, never read from pending input. */
export async function setStepAgent(runId: number, key: string, value: unknown, actorId: number) {
  return withTx(async (c) => {
    const run = await lockRun(c, runId);
    const step = await one<StepRow>(
      c,
      "SELECT * FROM workflow_steps WHERE run_id=$1 AND key=$2 FOR UPDATE",
      [runId, key],
    );
    if (!step || !["agent", "coding_agent"].includes(step.type))
      throw new EngineError("Agent step required", 400);
    if (
      !["PENDING", "READY", "RETRYING", "FAILED", "CANCELED", "WAITING_INPUT"].includes(
        step.status,
      ) ||
      run.status === "CANCELED"
    )
      throw new EngineError("Only pending or retryable agent steps can be changed", 409);
    let override;
    let effective;
    try {
      override = value === null ? null : StepAgentOverrideConfig.parse(value);
      const baselineTools = step.config.agent?.allowed_tools;
      if (
        baselineTools != null &&
        override &&
        Object.hasOwn(override, "allowed_tools") &&
        (override.allowed_tools == null ||
          override.allowed_tools.some((t) => !baselineTools.includes(t)))
      )
        throw new Error("Manual tool permissions must be a subset of the workflow's allowed_tools");
      effective = resolveStepAgent(run, { ...step, agent_override: override });
    } catch (error) {
      throw new EngineError((error as Error).message, 400);
    }
    await q(c, "UPDATE workflow_steps SET agent_override=$2 WHERE id=$1", [
      step.id,
      override == null ? null : json(override),
    ]);
    await q(
      c,
      `INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES($1,'step.agent_override','run',$2,$3)`,
      [
        actorId,
        String(runId),
        json({ step: key, previous: step.agent_override ?? null, override, effective }),
      ],
    );
    return { agent_override: override, effective_agent: effective };
  });
}

export interface PreparedHandoff {
  content?: unknown;
  fingerprint?: string;
  blocked?: string;
  failure?: string | null;
}
/** Called only after execute() has returned; no process timeout race is used to claim termination. */
export async function prepareProviderPause(
  b: BegunAttempt,
  result: ExecResult,
): Promise<PreparedHandoff | undefined> {
  const requested = await one(
    pool,
    "SELECT id FROM provider_handoffs WHERE source_attempt_id=$1 AND status='STOPPING'",
    [b.attempt.id],
  );
  if (!["agent", "coding_agent"].includes(b.step.type)) return;
  const failure = await providerFailure(b.attempt.id, result);
  const policy = fallbackPolicy(b.step);
  const retry =
    result.kind === "failed"
      ? classifyFailure(result.error, {
          executorRetryable: result.retryable,
          attempt: b.step.attempt_count,
          maxAttempts: b.attempt.effective_agent?.retry?.max_attempts ?? b.step.max_attempts,
          baseBackoff: b.step.retry_backoff_s,
        })
      : null;
  const reported = await one(
    pool,
    "SELECT EXISTS(SELECT 1 FROM jsonb_each(COALESCE(metrics->'provider_sessions','{}'::jsonb)) v WHERE v.value->>'normalized_failure_category' IS NOT NULL) AS reported FROM workflow_step_attempts WHERE id=$1",
    [b.attempt.id],
  );
  const supported =
    failure &&
    PAUSABLE_FAILURES.includes(failure as any) &&
    ((result.kind === "failed" && !!(result.details as any)?.provider_error) || reported?.reported);
  if (
    !requested &&
    (policy.mode === "disabled" ||
      !supported ||
      (["RATE_LIMIT", "PROVIDER_UNAVAILABLE", "EXECUTION_TIMEOUT"].includes(failure!) &&
        retry?.action === "retry"))
  )
    return;
  try {
    return {
      ...(await execution.run(
        { userId: Number(b.run.owner_id), runId: b.run.id, kind: "run" },
        () =>
          buildHandoffPackage(
            b.run,
            b.step,
            b.attempt,
            requested
              ? "Manual in-progress switch requested"
              : result.kind === "failed"
                ? result.error
                : "Provider switch",
          ),
      )),
      failure: requested ? null : failure,
    };
  } catch (error) {
    return {
      blocked: `Workspace inspection failed: ${safeDiagnostics(error)}`,
      failure: requested ? null : failure,
    };
  }
}
async function persistProviderPause(
  c: pg.PoolClient,
  run: RunRow,
  step: StepRow,
  attempt: AttemptRow,
  job: JobRow,
  result: ExecResult,
  p: PreparedHandoff,
  request: any,
  afterCommit: AfterCommit,
) {
  const reason =
    request?.reason ??
    (result.kind === "failed" ? safeDiagnostics(result.error) : "Provider switch");
  const concurrent = await one(
    c,
    "SELECT id FROM workflow_step_attempts WHERE run_id=$1 AND id<>$2 AND status='RUNNING' LIMIT 1",
    [run.id, attempt.id],
  );
  const blocked =
    p.blocked ??
    (concurrent ? "Another attempt is running; workspace stability requires reconciliation" : null);
  const handoff = await one(
    c,
    `INSERT INTO provider_handoffs(run_id,step_id,source_attempt_id,generation,original_provider,reason,failure_category,status,package,workspace_fingerprint,ready_at,automatic,blocked_reason)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12)
 ON CONFLICT(source_attempt_id) DO UPDATE SET status=excluded.status,package=excluded.package,workspace_fingerprint=excluded.workspace_fingerprint,ready_at=now(),blocked_reason=excluded.blocked_reason
 RETURNING *`,
    [
      run.id,
      step.id,
      attempt.id,
      step.generation,
      attempt.agent_provider ?? run.agent_provider,
      reason,
      p.failure,
      blocked ? "BLOCKED" : "READY",
      json(p.content ?? null),
      p.fingerprint ?? null,
      !request && fallbackPolicy(step).mode === "automatic",
      blocked,
    ],
  );
  await q(
    c,
    "UPDATE workflow_step_attempts SET status=$2,finished_at=now(),error=$3,metrics=COALESCE(metrics,'{}'::jsonb)||$4,output=$5 WHERE id=$1",
    [
      attempt.id,
      request ? "CANCELED" : "FAILED",
      json({ message: reason, provider_handoff_id: handoff.id }),
      json({ normalized_failure_category: request ? "CANCELED" : p.failure }),
      json(result.kind === "completed" ? result.output : null),
    ],
  );
  await q(
    c,
    "UPDATE workflow_jobs SET status='done',lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1,last_error=$2,updated_at=now() WHERE id=$1",
    [job.id, reason],
  );
  const checkpoint = {
    provider_handoff: {
      id: handoff.id,
      source_attempt_id: attempt.id,
      failure_category: p.failure,
      status: handoff.status,
    },
    package_reference: `provider_handoffs:${handoff.id}`,
    workspace_fingerprint: p.fingerprint ?? null,
  };
  await q(
    c,
    "INSERT INTO workflow_checkpoints(run_id,step_id,attempt_id,reason,data) VALUES($1,$2,$3,'provider_handoff',$4)",
    [run.id, step.id, attempt.id, json(checkpoint)],
  );
  await setStepStatus(
    c,
    step,
    "WAITING_INPUT",
    { pending_input: { ...(step.pending_input ?? {}), ...checkpoint }, error: reason },
    `provider handoff ${handoff.status}: ${p.failure ?? "manual"}`,
  );
  await runEvents.add(c, run.id, "provider_handoff", reason, step.id, attempt.id, {
    handoff_id: handoff.id,
    status: handoff.status,
    failure_category: p.failure,
  });
  await advance(c, run.id, afterCommit);
}

const HandoffRequest = z
  .object({
    expected_attempt_id: z.number().int().positive(),
    reason: z.string().trim().min(1).max(1000).default("Manual provider switch"),
  })
  .strict();
export async function requestProviderHandoff(
  runId: number,
  key: string,
  body: unknown,
  actorId: number,
) {
  const parsed = HandoffRequest.safeParse(body);
  if (!parsed.success) throw new EngineError(parsed.error.message, 400);
  const input = parsed.data;
  const requested = await withTx(async (c) => {
    const run = await lockRun(c, runId);
    assertAssignedLocal(run);
    const step = await one<StepRow>(
      c,
      "SELECT * FROM workflow_steps WHERE run_id=$1 AND key=$2 FOR UPDATE",
      [runId, key],
    );
    if (!step || !["agent", "coding_agent"].includes(step.type) || run.status === "CANCELED")
      throw new EngineError("Agent step on a live run required", 409);
    if (fallbackPolicy(step).mode === "disabled")
      throw new EngineError("Provider handoff disabled by workflow policy", 409);
    if (step.current_attempt_id !== input.expected_attempt_id)
      throw new EngineError("Stale attempt; refresh the handoff preview", 409);
    const existing = await one(c, "SELECT * FROM provider_handoffs WHERE source_attempt_id=$1", [
      step.current_attempt_id,
    ]);
    if (existing) {
      const attempt = await one<AttemptRow>(c, "SELECT * FROM workflow_step_attempts WHERE id=$1", [
        step.current_attempt_id,
      ]);
      if (
        (["READY", "BLOCKED"].includes(existing.status) ||
          (existing.status === "STOPPING" && attempt?.status !== "RUNNING")) &&
        attempt?.executor_stopped_at
      ) {
        await q(
          c,
          "INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES($1,'provider_handoff.reinspect','run',$2,$3)",
          [actorId, String(runId), json({ handoff_id: existing.id })],
        );
        await q(
          c,
          "UPDATE provider_handoffs SET status='STOPPING',automatic=false,requested_by=$2 WHERE id=$1",
          [existing.id, actorId],
        );
        return { handoff: { ...existing, status: "STOPPING" }, jobId: null, run, step, attempt };
      }
      return { handoff: existing, jobId: null };
    }
    if (!["RUNNING", "FAILED", "WAITING_INPUT", "RETRYING", "CANCELED"].includes(step.status))
      throw new EngineError("Step is not running or retryable", 409);
    const attempt = await one<AttemptRow>(c, "SELECT * FROM workflow_step_attempts WHERE id=$1", [
      step.current_attempt_id,
    ]);
    if (!attempt) throw new EngineError("Attempt not found", 404);
    const h = await one(
      c,
      `INSERT INTO provider_handoffs(run_id,step_id,source_attempt_id,generation,original_provider,reason,status,requested_by)
   VALUES($1,$2,$3,$4,$5,$6,'STOPPING',$7) RETURNING *`,
      [
        run.id,
        step.id,
        attempt.id,
        step.generation,
        attempt.agent_provider ?? run.agent_provider,
        safeDiagnostics(input.reason),
        actorId,
      ],
    );
    await q(
      c,
      "INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES($1,'provider_handoff.request','run',$2,$3)",
      [actorId, String(run.id), json({ handoff_id: h.id, step: key, attempt_id: attempt.id })],
    );
    await runEvents.add(
      c,
      run.id,
      "provider_handoff",
      "Cancellation requested; waiting for confirmed executor termination",
      step.id,
      attempt.id,
      { handoff_id: h.id },
    );
    return {
      handoff: h,
      jobId: step.status === "RUNNING" ? attempt.job_id : null,
      run,
      step,
      attempt,
    };
  });
  if (requested.jobId) {
    localJobs.abort(requested.jobId);
    return requested.handoff;
  }
  if (requested.attempt) {
    // Terminal/retryable attempts require a durable termination marker, never mere lease expiry.
    if (!requested.attempt.executor_stopped_at) {
      await q(
        pool,
        "UPDATE provider_handoffs SET status='BLOCKED',blocked_reason='Executor termination is unconfirmed; reconcile on the assigned worker' WHERE id=$1",
        [requested.handoff.id],
      );
      return one(pool, "SELECT * FROM provider_handoffs WHERE id=$1", [requested.handoff.id]);
    }
    let prepared: PreparedHandoff;
    try {
      prepared = await buildHandoffPackage(
        requested.run!,
        requested.step!,
        requested.attempt,
        input.reason,
      );
    } catch (e) {
      prepared = { blocked: safeDiagnostics(e) };
    }
    await withTx(async (c, afterCommit) => {
      await lockRun(c, runId);
      const step = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id=$1 FOR UPDATE", [
        requested.step!.id,
      ]);
      if (
        !step ||
        step.current_attempt_id !== input.expected_attempt_id ||
        step.generation !== requested.handoff.generation ||
        step.status === "RUNNING"
      )
        throw new EngineError("Attempt changed during inspection", 409);
      await q(
        c,
        "UPDATE workflow_jobs SET status='canceled',fencing_token=fencing_token+1,lease_owner=NULL,lease_expires_at=NULL WHERE step_id=$1 AND status IN ('queued','running')",
        [step.id],
      );
      const blocked =
        prepared.blocked ??
        ((await one(
          c,
          "SELECT id FROM workflow_step_attempts WHERE run_id=$1 AND status='RUNNING' LIMIT 1",
          [runId],
        ))
          ? "Another attempt is running"
          : null);
      await q(
        c,
        "UPDATE provider_handoffs SET status=$2,package=$3,workspace_fingerprint=$4,ready_at=now(),blocked_reason=$5 WHERE id=$1",
        [
          requested.handoff.id,
          blocked ? "BLOCKED" : "READY",
          json(prepared.content ?? null),
          prepared.fingerprint ?? null,
          blocked,
        ],
      );
      await setStepStatus(c, step, "WAITING_INPUT", {
        pending_input: {
          ...(step.pending_input ?? {}),
          provider_handoff: {
            id: requested.handoff.id,
            source_attempt_id: input.expected_attempt_id,
          },
        },
        error: input.reason,
      });
      await q(
        c,
        "INSERT INTO workflow_checkpoints(run_id,step_id,attempt_id,reason,data) VALUES($1,$2,$3,'provider_handoff',$4)",
        [
          runId,
          step.id,
          input.expected_attempt_id,
          json({ provider_handoff: { id: requested.handoff.id } }),
        ],
      );
      await advance(c, runId, afterCommit);
    });
  }
  return one(pool, "SELECT * FROM provider_handoffs WHERE id=$1", [requested.handoff.id]);
}
const ResumeHandoff = z
  .object({
    handoff_id: z.number().int().positive(),
    expected_attempt_id: z.number().int().positive(),
    provider: z.enum(["claude", "codex", "cursor", "antigravity"]),
    model: StepAgentOverrideConfig.shape.model.optional(),
    confirm: z.literal(true),
    checkpoint_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export async function resumeProviderHandoff(
  runId: number,
  key: string,
  body: unknown,
  actorId: number | null,
  automatic = false,
) {
  const parsed = ResumeHandoff.safeParse(body);
  if (!parsed.success) throw new EngineError(parsed.error.message, 400);
  const input = parsed.data;
  const run = await one<RunRow>(pool, "SELECT * FROM workflow_runs WHERE id=$1", [runId]);
  if (!run) throw new EngineError("Run not found", 404);
  assertAssignedLocal(run);
  const step = await one<StepRow>(pool, "SELECT * FROM workflow_steps WHERE run_id=$1 AND key=$2", [
    runId,
    key,
  ]);
  if (!step) throw new EngineError("Step not found", 404);
  const candidate = resolveStepAgent(run, {
    ...step,
    agent_override: {
      ...((step.agent_override ?? {}) as object),
      provider: input.provider,
      model: input.model ?? null,
      reasoning_effort: null,
    },
  })!;
  const ready = await handoffReadiness(candidate);
  if (!ready.ok) throw new EngineError(ready.error ?? "Provider readiness is unconfirmed", 409);
  return withTx(async (c, afterCommit) => {
    const locked = await lockRun(c, runId);
    assertAssignedLocal(locked);
    if (!(await ownsInstance(c))) throw new EngineError("Worker instance replaced", 409);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id=$1 FOR UPDATE", [
      step.id,
    ]);
    const h = await one(
      c,
      "SELECT * FROM provider_handoffs WHERE id=$1 AND run_id=$2 AND step_id=$3 FOR UPDATE",
      [input.handoff_id, runId, step.id],
    );
    if (
      !s ||
      !h ||
      h.source_attempt_id !== input.expected_attempt_id ||
      s.current_attempt_id !== input.expected_attempt_id ||
      s.generation !== h.generation
    )
      throw new EngineError("Stale handoff", 409);
    if (locked.status === "CANCELED") throw new EngineError("Run canceled", 409);
    if (h.status === "RESUMED") return { handoff: h, duplicate: true };
    if (
      h.status !== "READY" ||
      s.status !== "WAITING_INPUT" ||
      ["PAUSED", "CANCELED", "PENDING"].includes(locked.status)
    )
      throw new EngineError("Handoff is not ready or run is paused", 409);
    const source = await one(
      c,
      "SELECT executor_stopped_at FROM workflow_step_attempts WHERE id=$1",
      [h.source_attempt_id],
    );
    if (
      !source?.executor_stopped_at ||
      (localJobs.activeIds().length &&
        (await one(
          c,
          "SELECT id FROM workflow_step_attempts WHERE job_id=ANY($1::bigint[]) AND run_id=$2",
          [localJobs.activeIds(), runId],
        )))
    )
      throw new EngineError("Executor termination is not confirmed", 409);
    if (
      await one(
        c,
        "SELECT id FROM workflow_step_attempts WHERE run_id=$1 AND status='RUNNING' LIMIT 1",
        [runId],
      )
    )
      throw new EngineError("Conflicting running attempt", 409);
    const workspace = await execution.run(
      { userId: Number(locked.owner_id), runId: locked.id, kind: "run" },
      () => inspectHandoffWorkspace(locked.id),
    );
    if (input.checkpoint_fingerprint !== h.workspace_fingerprint)
      throw new EngineError("Checkpoint changed; review the latest handoff before confirming", 409);
    if (workspace.fingerprint !== h.workspace_fingerprint)
      throw new EngineError("Workspace changed after checkpoint; reconcile before continuing", 409);
    if (s.requires_approval && !(s.approval?.granted && s.approval.generation === s.generation))
      throw new EngineError("Existing approval gate is not granted", 409);
    const repos = [
      ...new Set([
        ...locked.selected_repositories,
        ...workspace.workspaces.map((w) => w.repository),
      ]),
    ];
    if (repos.some((r) => !locked.allowed_repositories.includes(r)))
      throw new EngineError("Repository scope changed; handoff is not authorized", 409);
    const permitted = await q(
      c,
      "SELECT name FROM repositories WHERE name=ANY($1::text[]) AND enabled AND $2=ANY(allowed_actions)",
      [repos, s.type === "coding_agent" ? "write" : "read"],
    );
    if (permitted.length !== repos.length)
      throw new EngineError("Repository permissions no longer permit this step", 409);
    if (input.provider !== "claude" && s.config.delegation?.enabled)
      throw new EngineError(
        "Target provider cannot enforce the approved delegation sandbox policy",
        409,
      );
    const policy = fallbackPolicy(s);
    const history = await q(
      c,
      "SELECT original_provider,target_provider FROM provider_handoffs WHERE step_id=$1 AND status='RESUMED'",
      [s.id],
    );
    if (policy.mode === "disabled" || !policy.providers.includes(input.provider))
      throw new EngineError("Fallback provider is disabled by workflow policy", 409);
    if (
      input.provider !== h.original_provider &&
      history.filter((v) => v.target_provider !== v.original_provider).length >= policy.max_switches
    )
      throw new EngineError("Provider switch budget exhausted", 409);
    if (automatic) {
      if (
        policy.mode !== "automatic" ||
        !AUTOMATIC_FAILURES.includes(h.failure_category) ||
        h.requested_by != null
      )
        throw new EngineError("Failure requires manual recovery", 409);
      if (
        [
          h.original_provider,
          ...history.flatMap((v) => [v.original_provider, v.target_provider]),
        ].includes(input.provider)
      )
        throw new EngineError("Automatic provider loop prevented", 409);
      const usage = await q(
        c,
        "SELECT reported_cost_usd,input_tokens,output_tokens FROM execution_attempt_telemetry WHERE step_id=$1",
        [s.id],
      );
      if (
        !policy.allow_unknown_cost &&
        (usage.some((u) => u.reported_cost_usd == null) || ready.cost === "unknown")
      )
        throw new EngineError(
          "Unknown provider cost requires explicit fallback policy permission",
          409,
        );
      if (/budget|billing|credit|cost/i.test(h.reason) && !policy.allow_budget_failure)
        throw new EngineError("Budget failure requires explicit fallback policy permission", 409);
      const cost = usage.reduce((n, u) => n + (u.reported_cost_usd ?? 0), 0),
        tokens = usage.reduce((n, u) => n + (u.input_tokens ?? 0) + (u.output_tokens ?? 0), 0);
      if (
        policy.max_reported_cost_usd != null &&
        (usage.some((u) => u.reported_cost_usd == null) || cost >= policy.max_reported_cost_usd)
      )
        throw new EngineError("Reported cost limit reached or coverage incomplete", 409);
      if (
        policy.max_reported_tokens != null &&
        (usage.some((u) => u.input_tokens == null || u.output_tokens == null) ||
          tokens >= policy.max_reported_tokens)
      )
        throw new EngineError("Reported token limit reached or coverage incomplete", 409);
    }
    const override = {
      ...((s.agent_override ?? {}) as object),
      provider: input.provider,
      model: input.model ?? null,
      reasoning_effort: null,
    };
    // Re-resolve inside the lock: settings may have changed while readiness was probed.
    const effective = resolveStepAgent(locked, { ...s, agent_override: override });
    if (JSON.stringify(effective) !== JSON.stringify(candidate))
      throw new EngineError("Agent configuration changed; refresh", 409);
    if (
      await one(c, "SELECT id FROM workflow_questions WHERE step_id=$1 AND status='open' LIMIT 1", [
        s.id,
      ])
    )
      throw new EngineError("Answer pending human questions before confirming the handoff", 409);
    await q(c, "UPDATE workflow_step_attempts SET resolved_at=now() WHERE id=$1", [
      h.source_attempt_id,
    ]);
    await q(
      c,
      "UPDATE provider_handoffs SET status='RESUMED',target_provider=$2,resumed_at=now(),resumed_by=$3,automatic=$4,blocked_reason=NULL WHERE id=$1",
      [h.id, input.provider, actorId, automatic],
    );
    await q(c, "UPDATE workflow_steps SET agent_override=$2 WHERE id=$1", [s.id, json(override)]);
    await setStepStatus(
      c,
      s,
      "READY",
      {
        pending_input: {
          provider_handoff: {
            id: h.id,
            source_attempt_id: h.source_attempt_id,
            package: h.package,
          },
        },
        error: null,
      },
      "provider handoff confirmed",
    );
    await ensureJob(c, s);
    if (actorId != null)
      await q(
        c,
        "INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES($1,'provider_handoff.resume','run',$2,$3)",
        [
          actorId,
          String(runId),
          json({
            handoff_id: h.id,
            original_provider: h.original_provider,
            target_provider: input.provider,
          }),
        ],
      );
    await runEvents.add(
      c,
      runId,
      "provider_handoff",
      `${h.original_provider} → ${input.provider}`,
      s.id,
      h.source_attempt_id,
      { handoff_id: h.id, automatic },
    );
    await advance(c, runId, afterCommit);
    return {
      handoff: { ...h, status: "RESUMED", target_provider: input.provider },
      duplicate: false,
    };
  });
}

/** Existing scheduler polls durable eligible handoffs too, so restart cannot lose an automatic continuation. */
export async function processAutomaticHandoff() {
  const h = await one(
    pool,
    `UPDATE provider_handoffs SET next_check_at=now()+interval '60 seconds' WHERE id=(SELECT h.id FROM provider_handoffs h JOIN workflow_runs r ON r.id=h.run_id WHERE h.status='READY' AND h.automatic AND h.next_check_at<=now() AND r.worker_instance=$1 AND r.status='WAITING' ORDER BY h.id FOR UPDATE OF h SKIP LOCKED LIMIT 1) RETURNING *`,
    [config.instanceId],
  );
  if (!h) return;
  const step = await one<StepRow>(pool, "SELECT * FROM workflow_steps WHERE id=$1", [h.step_id]);
  if (!step) return;
  for (const provider of fallbackPolicy(step).providers) {
    if (provider === h.original_provider) continue;
    try {
      await resumeProviderHandoff(
        h.run_id,
        step.key,
        {
          handoff_id: h.id,
          expected_attempt_id: h.source_attempt_id,
          provider,
          confirm: true,
          checkpoint_fingerprint: h.workspace_fingerprint,
        },
        null,
        true,
      );
      return;
    } catch (error) {
      await q(
        pool,
        "UPDATE provider_handoffs SET blocked_reason=$2 WHERE id=$1 AND status='READY'",
        [h.id, safeDiagnostics(error)],
      );
    }
  }
}

function assertAssignedLocal(run: RunRow) {
  if (run.worker_instance !== config.instanceId)
    throw new EngineError(
      "Continue on the assigned worker; workspace ownership cannot be transferred",
      409,
    );
}

export async function providerHandoffOptions(runId: number, key: string) {
  const run = await one<RunRow>(pool, "SELECT * FROM workflow_runs WHERE id=$1", [runId]);
  if (!run) throw new EngineError("Run not found", 404);
  assertAssignedLocal(run);
  const step = await one<StepRow>(pool, "SELECT * FROM workflow_steps WHERE run_id=$1 AND key=$2", [
    runId,
    key,
  ]);
  if (!step) throw new EngineError("Step not found", 404);
  const { agentProviderStatus } = await import("../agent/providerStatus.ts");
  const catalog = await agentProviderStatus();
  return Promise.all(
    fallbackPolicy(step).providers.map(async (provider) => {
      try {
        const candidate = resolveStepAgent(run, {
          ...step,
          agent_override: { provider, model: null, reasoning_effort: null },
        })!;
        return {
          provider,
          ...(await handoffReadiness(candidate)),
          models: catalog.find((v) => v.id === provider)?.models ?? [],
          model: candidate.model,
        };
      } catch (error) {
        return {
          provider,
          ok: false,
          error: safeDiagnostics(error),
          models: [],
          quota: "unknown",
          cost: "unknown",
        };
      }
    }),
  );
}
