import type { WorkItemRow } from "../../workitems/repository.ts";
import { loadAgentConfiguration } from "../../agent/configurationStore.ts";
import { completeForRun } from "../../agent/complete.ts";
import { advance } from "../progression.ts";
import { EngineError, lockRun, setRunStatus, type AfterCommit } from "../mutations.ts";
import { collectMicroEvidence } from "../microEvidence.ts";
import { applyOptimizationDefaults } from "../../eval/optimization.ts";
import { resolveStepAgent } from "../../agent/stepAgent.ts";
import type pg from "pg";
import { config } from "../../config.ts";
import { executionPolicyVersions } from "../../learning/policyVersions.ts";
import { allWorkspacesOf } from "../../git/provider.ts";
import { resolveOutputLocale, type OutputLocale } from "../../agent/language.ts";
import { resolveAgentProvider, type AgentProvider } from "../../agent/provider.ts";
import { pool, q, one, withTx, json, type Db } from "../../db/pool.ts";
import { selfRepositoryNames } from "../../platform/selfDevelopment.ts";
import { isAmbiguous, rankRepositories, repositories } from "../../repos/service.ts";
import { allowedRepositoriesForRun } from "../../repos/access.ts";
import { ensureTestOwner } from "../../auth/testOwner.ts";
import { definitions } from "../definitions.ts";
import {
  detectBranchDirectives,
  normalizeBranchMap,
  WORK_ITEM_BRANCH_SOURCE,
} from "../branches.ts";
import { topoOrder } from "../graph.ts";
import { runEvents } from "../events.ts";
import { materializeSubtasks } from "../decomposition.ts";
import { StepSpec } from "../types.ts";
import { injectedCleanup, isCleanupStep, workTerminals } from "../templates.ts";
import type { RunRow, WorkflowSpec } from "../types.ts";
import { parseAiSuggest, type ReportSpec } from "../../report/aiSuggest.ts";
import { freezeAutonomy } from "../autonomy.ts";
import {
  resolveProfile,
  classifyComplexity,
  classifyWithFallback,
  type ProfileChange,
  type ComplexityDecision,
  type ProfileChoice,
  type ProfileDecision,
} from "../profiles.ts";
import { setSelectedRepositories } from "./repositorySelection.ts";
import { type WorkflowActionGuard, adoptRun, getRun, txThenRun } from "./shared.ts";

export const REPORT_STEP_KEY = "task_result_report";

/**
 * Append the optional final Task Result Report step to a run's resolved graph (never to the published definition).
 * Depends on every terminal step, so it runs only after all work (tests, review, PR) is done. Idempotent: a graph that
 * already has a report step (custom workflow, or injected before) is returned unchanged.
 */
export function withReportStep(spec: WorkflowSpec, ai: ReportSpec | null): WorkflowSpec {
  if (!ai || spec.steps.some((s) => s.key === REPORT_STEP_KEY || s.type === "task_result_report"))
    return spec;
  return {
    ...spec,
    steps: [
      ...spec.steps,
      {
        key: REPORT_STEP_KEY,
        type: "task_result_report",
        name: "Task Result Report",
        depends_on: workTerminals(spec.steps),
        config: { ai_suggest: ai, injected: true },
        requires_approval: false,
        max_attempts: 2,
        retry_backoff_seconds: 5,
      },
    ],
  };
}

const createsWorktrees = (s: StepSpec) =>
  s.type === "coding_agent" ||
  (s.type === "integration" &&
    ["integrate_subtasks", "subtask_integration"].includes(String(s.config.action)));

/** Append a workspace cleanup step to a run's resolved graph that creates worktrees but never releases them. */
export function withCleanupStep(spec: WorkflowSpec): WorkflowSpec {
  if (!spec.steps.some(createsWorktrees) || spec.steps.some(isCleanupStep)) return spec;
  return { ...spec, steps: [...spec.steps, StepSpec.parse(injectedCleanup(spec.steps))] };
}

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
  /** Requested autonomy mode; only ever narrowed by the admin policies (see autonomy.ts). */
  autonomy?: unknown;
}

type WorkItemPayload = NonNullable<Parameters<typeof parseAiSuggest>[0]> & {
  risk?: string | null;
  note?: string | null;
};

type ResolvedWorkItem = Omit<WorkItemRow, "payload"> & { payload: WorkItemPayload | null };

export interface ResolvedRunGraph {
  dv: { id: number; key: string; version: number; spec: WorkflowSpec };
  wi: ResolvedWorkItem | null;
  inputs: Record<string, unknown>;
  allowed: string[];
  selected: string[];
  reusedRepositories: boolean;
  decision: ProfileDecision & { complexity: ComplexityDecision };
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
    ? await one<ResolvedWorkItem>(c, "SELECT * FROM work_items WHERE id = $1", [input.workItemId])
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
  // Self-development always targets this installation unless the caller named repositories.
  // A previous run of the same work item must not reuse some other repository into this workflow.
  const callerChoseRepositories =
    (Array.isArray(input.repositories) && input.repositories.length > 0) ||
    (Array.isArray(inputs.repositories) && (inputs.repositories as unknown[]).length > 0);
  if (dv.spec.execution_mode === "self_development" && !callerChoseRepositories) {
    const names = await selfRepositoryNames(
      (await repositories.list(c)).filter((r) => allowed.includes(r.name)),
    );
    if (names.length !== 1)
      throw new EngineError(
        names.length
          ? `self-development matches more than one platform repository (${names.join(", ")}); pass repositories to choose one`
          : "self-development needs this platform's repository registered and accessible to the run owner",
        400,
      );
    selected = names;
    reusedRepositories = false;
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
  const decision0 = await classifyWithFallback(
    {
      title: wi?.title ?? input.title ?? "",
      description: wi?.description ?? String(inputs.description ?? ""),
      project,
      repositories: selected,
      knownRepository: positive.length && !isAmbiguous(positive) ? positive[0].repo : null,
      matchingRepositories: positive.length,
      declaredRisk: (inputs.risk as string) ?? wi?.payload?.risk ?? null,
      provider: input.agentProvider ?? config.agent.defaultProvider ?? null,
      evidence:
        selected.length === 1
          ? await collectMicroEvidence(selected[0], inputs.files, priorFailureRuns)
          : undefined,
    },
    input.profile ?? "AUTO",
    (prompt) =>
      completeForRun({ agent_provider: input.agentProvider }, prompt, AbortSignal.timeout(5000)),
  );
  const complexity = classifyComplexity(decision0, { priorFailureRuns }, inputs.complexity);
  let decision: ProfileDecision & { complexity: typeof complexity } = {
    ...decision0,
    signals: { ...decision0.signals, reused_repositories: reusedRepositories },
    complexity,
  };
  // High-risk verification stays mandatory: FAST would drop the independent review, so it is refused for HIGH_RISK
  // unless the user explicitly re-classified the task (recorded as an override).
  if (
    complexity.class === "HIGH_RISK" &&
    (decision.profile === "FAST" || decision.profile === "MICRO")
  )
    decision = {
      ...decision,
      profile: "STANDARD",
      warnings: [
        ...decision.warnings,
        "FAST refused: HIGH_RISK tasks keep the independent review and approvals (override the complexity class to change this)",
      ],
    };
  const resolved = resolveProfile(dv.spec, decision);
  decision = resolved.decision;
  if (decision.profile === "MICRO") {
    const evidence = decision.signals.evidence as NonNullable<
      import("../profiles.ts").ProfileSignals["evidence"]
    >;
    const files = evidence.files;
    resolved.spec = {
      ...resolved.spec,
      steps: resolved.spec.steps.map((step) =>
        step.type === "coding_agent"
          ? {
              ...step,
              config: {
                ...step.config,
                micro_scope: files,
                micro_revision: 0,
                micro_source_revision: evidence.revision,
                micro_hashes: evidence.hashes,
              },
            }
          : step,
      ),
    };
  }
  const reported = withReportStep(resolved.spec, wi ? parseAiSuggest(wi.payload) : null);
  const graph = withCleanupStep(reported);
  return {
    dv,
    wi: wi ?? null,
    inputs,
    allowed,
    selected,
    reusedRepositories,
    decision,
    changes: resolved.changes,
    graph,
    reportAdded: reported !== resolved.spec,
    ownerId: ownerId!,
  };
}

export async function previewRun(input: StartRunInput) {
  const r = await resolveRunGraph(pool, input);
  return {
    autonomy: await freezeAutonomy(pool, input.autonomy, r.ownerId),
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

export async function startRun(
  input: StartRunInput,
  tx?: { client: pg.PoolClient; afterCommit: AfterCommit },
) {
  let output_locale: OutputLocale;
  let agent_provider: AgentProvider;
  try {
    output_locale = resolveOutputLocale(input.outputLocale);
    agent_provider = resolveAgentProvider(input.agentProvider);
  } catch (e) {
    throw new EngineError((e as Error).message, 400);
  }
  const create = async (c: pg.PoolClient, afterCommit: AfterCommit) => {
    const agent_configuration = {
      ...(await loadAgentConfiguration(c)),
      captured_at: new Date().toISOString(),
      capture_source: "run-start" as const,
    };
    agent_provider = resolveAgentProvider(
      input.agentProvider ?? agent_configuration.default_provider,
    );
    if (!agent_configuration.providers[agent_provider].enabled)
      throw new EngineError("Requested agent provider is disabled", 400);
    const r = await resolveRunGraph(c, input);
    const { dv, wi, inputs, allowed, selected, graph } = r;
    const autonomy = await freezeAutonomy(c, input.autonomy, r.ownerId);
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
      r.decision.complexity?.class ?? null,
      agent_provider ?? null,
      dv.key,
    );
    const title = input.title || (wi ? `${wi.code}: ${wi.title}` : `${dv.spec.name} #${id}`);
    try {
      for (const step of optimized.graph.steps)
        resolveStepAgent(
          { agent_provider, profile: r.decision.profile, agent_configuration },
          step,
        );
    } catch (error) {
      throw new EngineError((error as Error).message, 400);
    }
    const resolvedGraph = {
      ...optimized.graph,
      profile: r.decision.profile,
      initial_profile: r.decision.profile,
      profile_changes: r.changes,
      profile_revision: 0,
      original_spec: dv.spec,
    };
    await q(
      c,
      `INSERT INTO workflow_runs (id, definition_version_id, definition_key, work_item_id, title, status, inputs, graph,
                                  allowed_repositories, selected_repositories, branch, profile, profile_decision, output_locale, agent_provider, owner_id, worker_instance, policy_versions, agent_configuration, autonomy)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
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
        json({ ...r.decision, initial_profile: r.decision.profile }),
        output_locale,
        agent_provider,
        r.ownerId,
        config.instanceId,
        json(executionPolicyVersions()),
        json(agent_configuration),
        autonomy.sources.length ? json(autonomy) : null,
      ],
    );
    for (const decision of optimized.decisions)
      await q(
        c,
        "INSERT INTO agent_optimization_decisions(run_id,step_key,recommendation_id,policy_id,provenance,source) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          decision.step_key,
          decision.recommendation_id ?? null,
          decision.policy_id ?? null,
          json(decision),
          decision.source === "adaptive_routing" ? "adaptive_routing" : "recommendation",
        ],
      );
    const order = topoOrder(optimized.graph.steps);
    // One statement for the whole graph (a round trip per step inside the transaction was the cost of starting a run).
    await q(
      c,
      `INSERT INTO workflow_steps (run_id, key, type, name, position, depends_on, config, run_if, requires_approval, max_attempts, retry_backoff_s, status)
       SELECT $1, x.key, x.type, x.name, x.position, ARRAY(SELECT jsonb_array_elements_text(x.depends_on)), x.config,
              COALESCE(x.run_if, 'null'), x.requires_approval, x.max_attempts, x.retry_backoff_s, 'PENDING'
         FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS e(v, i),
              jsonb_to_record(e.v) AS x(key text, type text, name text, position int, depends_on jsonb, config jsonb,
                                        run_if jsonb, requires_approval bool, max_attempts int, retry_backoff_s int)
        ORDER BY e.i`,
      [
        id,
        json(
          optimized.graph.steps.map((s) => ({
            key: s.key,
            type: s.type,
            name: s.name ?? s.key,
            position: order.indexOf(s.key),
            depends_on: s.depends_on,
            config: s.config,
            run_if: s.run_if ?? null,
            requires_approval:
              s.requires_approval ||
              (s.type === "git_pull_request" && s.config.mode === "approval"),
            max_attempts: s.max_attempts,
            retry_backoff_s: s.retry_backoff_seconds,
          })),
        ),
      ],
    );
    await runEvents.add(
      c,
      id,
      "system",
      `run created from ${dv.key} v${dv.version}${wi ? ` for ${wi.code}` : ""} · agent ${agent_provider} · profile ${r.decision.profile} (${r.decision.reasons.join("; ")})` +
        (r.changes.length ? ` · ${r.changes.length} graph change(s)` : "") +
        (r.reportAdded ? " · Task Result Report step added (ai_suggest.report)" : "") +
        (r.reusedRepositories ? ` · reused repositories ${selected.join(", ")}` : "") +
        (autonomy.sources.length
          ? ` · autonomy ${autonomy.mode}${autonomy.shadow ? " (shadow)" : ""}${autonomy.downgraded.length ? ` — ${autonomy.downgraded.join("; ")}` : ""}`
          : ""),
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
  };
  return tx ? create(tx.client, tx.afterCommit) : withTx(create);
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
  return txThenRun(runId, (c, afterCommit) =>
    startPendingRunInTx(c, afterCommit, runId, repositoriesOverride, stepMode),
  );
}

export async function startPendingRunInTx(
  c: pg.PoolClient,
  afterCommit: AfterCommit,
  runId: number,
  repositoriesOverride?: string[],
  stepMode = false,
) {
  const run = await lockRun(c, runId);
  if (run.status !== "PENDING") throw new EngineError(`run ${runId} is ${run.status}, not PENDING`);
  await adoptRun(c, runId);
  if (repositoriesOverride) await setSelectedRepositories(c, run, repositoriesOverride);
  await setRunStatus(c, run, "RUNNING");
  if (stepMode) await setRunStatus(c, run, "PAUSED");
  await advance(c, runId, afterCommit);
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
    const prepared = [...new Set((await allWorkspacesOf(run.id, c)).map((w) => w.repo))];
    const touched = Object.keys(raw).flatMap((k) =>
      k === "*" ? prepared : prepared.includes(k) ? [k] : [],
    );
    if (touched.length)
      throw new EngineError(
        `worktree already prepared for ${touched.join(", ")}: its branch cannot change in this run`,
        409,
      );
    const inputs: Record<string, unknown> = { ...(run.inputs ?? {}) };
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
