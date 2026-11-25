import type { WorkItemRow } from "../workitems/repository.ts";
import { needsReplayReconciliation, planContinuation, planReplay } from "./replay.ts";
import {
  continuationEvidence,
  latestWaitCheckpoint,
  readExecutionCheckpoint,
  saveExecutionPause,
  validateContinuation,
} from "./checkpoints.ts";
import { reapExpiredLeases as reapExpiredJobs } from "./recovery.ts";
import { answerProblem, questionRow } from "./questionOptions.ts";
import {
  findRun,
  stepsOf,
  loadRunDetail,
  loadStepDetail,
  loadOpenApprovals,
  type OwnerScope,
} from "./runRepository.ts";
export { listCodeScans, listRuns, openQuestions, answeredQuestions } from "./runRepository.ts";
import { loadAgentConfiguration } from "../agent/configurationStore.ts";
import type { AgentConfiguration } from "../agent/configuration.ts";
const frozenProviderFlags = (snapshot: AgentConfiguration | null | undefined) =>
  snapshot
    ? Object.fromEntries(
        Object.entries(snapshot.providers).map(([key, entry]) => [key, entry.enabled]),
      )
    : undefined;
import { completeForRun } from "../agent/complete.ts";
export { releaseAttempt, safeRecovery } from "./recovery.ts";
import { existsSync } from "node:fs";
import { advance } from "./progression.ts";
export { advance } from "./progression.ts";
import { budgetPreflight, enforceBudget } from "./budgets.ts";
import {
  delegationsOf,
  holdForChildren,
  kickDelegations,
  planChildWorkflows,
} from "./delegation.ts";
import {
  EngineError,
  lockRun,
  setStepStatus,
  setRunStatus,
  ensureJob,
  cancelStepJobs,
  type AfterCommit,
} from "./mutations.ts";
export { EngineError } from "./mutations.ts";
import { applyProfileEscalation } from "./profileRuntime.ts";
import { collectMicroEvidence } from "./microEvidence.ts";
import { applyOptimizationDefaults } from "../eval/optimization.ts";
import { z } from "zod";
import { execution } from "../auth/execution.ts";
import {
  buildHandoffPackage,
  providerFailure,
  PAUSABLE_FAILURES,
  AUTOMATIC_FAILURES,
  handoffReadiness,
  handoffBlockReason,
  inspectHandoffWorkspace,
} from "../agent/handoff.ts";
import {
  healthSkipReason,
  isUsableAgent,
  nextHealthyProvider,
  invalidateSharedAgentHealth,
  probeAgentHealth,
  rememberProviderQuota,
  sharedAgentHealth,
} from "../agent/health.ts";
import { count, observe } from "../runtimeMetrics.ts";
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
import {
  allWorkspacesOf,
  WORKSPACE_RELEASE_OPTIONS,
  type WorkspaceConflict,
} from "../git/provider.ts";
import { instanceHealth, ownsInstance, instanceSession } from "../instances.ts";
import { outputLocale, resolveOutputLocale, type OutputLocale } from "../agent/language.ts";
import { providerEnabled, resolveAgentProvider, type AgentProvider } from "../agent/provider.ts";
import { pool, q, one, withTx, json, type Db } from "../db/pool.ts";
import { notify, notifyStepWaiting } from "../notify.ts";
import { selfRepositoryNames } from "../platform/selfDevelopment.ts";
import { isAmbiguous, rankRepositories, repositories } from "../repos/service.ts";
import { allowedRepositoriesForRun, effectivePermissions } from "../repos/access.ts";
import { ensureTestOwner } from "../auth/testOwner.ts";
import { definitions } from "./definitions.ts";
import { detectBranchDirectives, normalizeBranchMap, WORK_ITEM_BRANCH_SOURCE } from "./branches.ts";
import { classifyFailure } from "./failures.ts";
import { markEscalationNotified, recoveryEpisodesOf, recoveryForFailure } from "./recovery.ts";
import { failurePolicy } from "../agent/harness/failure.ts";
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
import { StepSpec } from "./types.ts";
import { injectedCleanup, isCleanupStep, workTerminals } from "./templates.ts";
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
import { decisionsOf, recordDecision, savingsFrom } from "./decisions.ts";
import {
  evaluateGate,
  freezeAutonomy,
  machineApproval,
  machineApprovalOutput,
  recordClarification,
  recordHumanApproval,
} from "./autonomy.ts";
import { checkpointView, isRecoverable, latestRecoverable } from "./checkpointView.ts";
import {
  resolveProfile,
  classifyComplexity,
  classifyWithFallback,
  type ProfileChange,
  type ComplexityDecision,
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
      import("./profiles.ts").ProfileSignals["evidence"]
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
    await cancelLockedRun(c, run, afterCommit, reason);
  });
}

/** Cancel a run locked by the caller in the current transaction. */
export async function cancelLockedRun(
  c: pg.PoolClient,
  run: RunRow,
  afterCommit: AfterCommit,
  reason: string,
) {
  if (run.status === "CANCELED") return;
  const aborted: number[] = [];
  for (const s of await stepsOf(c, run.id)) {
    if (["COMPLETED", "SKIPPED", "CANCELED", "FAILED"].includes(s.status)) continue;
    aborted.push(...(await cancelStepJobs(c, s.id, reason)));
    await setStepStatus(c, s, "CANCELED", { finished_at: new Date() }, reason);
  }
  await q(
    c,
    "UPDATE workflow_step_attempts SET status = 'CANCELED', finished_at = now(), error = $2 WHERE run_id = $1 AND status = 'RUNNING'",
    [run.id, json({ message: reason })],
  );
  await q(
    c,
    "UPDATE workflow_questions SET status = 'dismissed' WHERE run_id = $1 AND status = 'open'",
    [run.id],
  );
  await setRunStatus(c, run, "CANCELED", afterCommit, reason);
  afterCommit(() => aborted.forEach((id) => localJobs.abort(id)));
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
  force = false,
) {
  if (run.status === "CANCELED") throw new EngineError("run is canceled");
  const steps = await stepsOf(c, run.id);
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const target = byKey.get(stepKey);
  if (!target) throw new EngineError(`step "${stepKey}" not found`, 404);
  if (target.pending_input?.provider_handoff?.source_attempt_id === target.current_attempt_id)
    throw new EngineError("Review and confirm the pending provider handoff", 409);
  if (needsReplayReconciliation(target))
    throw new EngineError("Resolve the current execution reconciliation before re-executing", 409);
  if (!RETRYABLE.includes(target.status))
    throw new EngineError(
      `step "${stepKey}" is ${target.status}; only ${RETRYABLE.join("/")} steps can be re-executed`,
    );
  const blocked = target.depends_on.filter((d) => !DONE.includes(byKey.get(d)!.status));
  if (blocked.length) throw new EngineError(`upstream steps not complete: ${blocked.join(", ")}`);

  const planning = performance.now();
  const plan = await planReplay(c, steps, target, force);
  observe("workflow.replay_plan_ms", performance.now() - planning);
  const blockedReplay = plan.find((item) => item.action === "RECONCILE");
  if (blockedReplay)
    throw new EngineError(
      `Reconcile step "${blockedReplay.key}" before replaying its dependencies`,
      409,
    );
  for (const item of plan) {
    const s = byKey.get(item.key)!;
    await recordDecision(c, {
      runId: run.id,
      stepId: s.id,
      attemptId: s.current_attempt_id,
      generation: s.generation,
      kind: "replay",
      action: item.action,
      outcome: "planned",
      reason: item.reason,
      sourceAttemptId: item.source_attempt_id ?? null,
      details: {
        target: stepKey,
        conditional: !!item.conditional,
        invalidated: item.invalidated,
        force,
      },
    });
  }
  // Every invalidated dependant, then the target, in plan order. Their jobs, running attempts and open questions are
  // fenced in one statement each (same transaction, run locked); each step's own transition and event follow in order.
  const invalidated = [
    ...plan
      .filter((item) => item.invalidated && item.key !== stepKey)
      .map((item) => ({
        s: byKey.get(item.key)!,
        to: "PENDING" as const,
        forced: item.action === "FORCE_REEXECUTE",
        candidate: item.source_attempt_id as number | undefined,
      })),
    {
      s: target,
      to: target.requires_approval ? ("PENDING" as const) : ("READY" as const),
      forced: true,
      candidate: undefined,
    },
  ];
  const ids = invalidated.map(({ s }) => s.id);
  const aborted = await cancelStepJobs(c, ids, `invalidated by re-execution of ${stepKey}`);
  await q(
    c,
    "UPDATE workflow_step_attempts SET status = 'CANCELED', finished_at = now() WHERE step_id = ANY($1::bigint[]) AND status = 'RUNNING'",
    [ids],
  );
  await q(
    c,
    "UPDATE workflow_step_attempts SET invalidated_at = now() WHERE step_id = ANY($1::bigint[]) AND invalidated_at IS NULL",
    [ids],
  );
  await q(
    c,
    "UPDATE workflow_questions SET status = 'dismissed' WHERE step_id = ANY($1::bigint[]) AND status = 'open'",
    [ids],
  );
  for (const { s, to, forced, candidate } of invalidated)
    await setStepStatus(
      c,
      s,
      to,
      {
        generation: s.generation + 1,
        attempt_count: 0,
        current_attempt_id: null,
        replay_source_attempt_id: candidate ?? null,
        replay_forced: forced,
        output: null,
        error: null,
        approval: null,
        pending_input: s === target ? pending : (dependantInput?.[s.key] ?? null),
        ready_at: to === "READY" ? new Date() : null,
        finished_at: null,
      },
      s === target
        ? why
        : `invalidated by ${stepKey}${candidate ? "; compare result at dispatch" : ""}`,
    );
  if (run.status !== "PAUSED") await setRunStatus(c, run, "RUNNING");
  afterCommit(() => aborted.forEach((id) => localJobs.abort(id)));
  await advance(c, run.id, afterCommit);
}

export async function previewReplay(runId: number, stepKey: string, force = false) {
  const run = await findRun(runId);
  if (!run) throw new EngineError(`run ${runId} not found`, 404);
  const steps = await stepsOf(pool, runId);
  const target = steps.find((s) => s.key === stepKey);
  if (!target) throw new EngineError(`step "${stepKey}" not found`, 404);
  const stepsByKey = new Map(steps.map((s) => [s.key, s]));
  const plan = await planReplay(pool, steps, target, force);
  // Estimated work a reuse would avoid: what the reused attempt reported when it ran.
  const withEstimates = await Promise.all(
    plan.map(async (item) => ({
      ...item,
      estimate:
        item.action === "REUSE" && item.source_attempt_id
          ? await savingsFrom(pool, item.source_attempt_id)
          : null,
    })),
  );
  const summary: Record<string, number> = {};
  for (const item of plan) summary[item.action] = (summary[item.action] ?? 0) + 1;
  const sum = (field: "invocations" | "tokens" | "cost_usd") => {
    const known = withEstimates
      .map((i) => i.estimate?.[field])
      .filter((v): v is number => v != null);
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };
  return {
    can_reexecute:
      run.status !== "CANCELED" &&
      RETRYABLE.includes(target.status) &&
      !plan.some((item) => item.action === "RECONCILE") &&
      target.depends_on.every((key) => DONE.includes(stepsByKey.get(key)!.status)),
    continuation: await planContinuation(pool, target),
    steps: withEstimates,
    summary: {
      actions: summary,
      estimated_avoided: {
        invocations: sum("invocations"),
        tokens: sum("tokens"),
        cost_usd: sum("cost_usd"),
      },
    },
  };
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
    /** Internal retry continuation; authorization and observed evidence remain bound to the source attempt. */
    retry?: boolean;
    /** Disable result reuse throughout this replay dependency closure. */
    force?: boolean;
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
    const current = await one<{
      pending_input: { reexecute?: { skills?: unknown } | null } | null;
    }>(c, "SELECT pending_input FROM workflow_steps WHERE run_id = $1 AND key = $2", [
      runId,
      stepKey,
    ]);
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
    const retrySource = opts.retry
      ? await one<{ current_attempt_id: number | null; status: string }>(
          c,
          "SELECT current_attempt_id,status FROM workflow_steps WHERE run_id=$1 AND key=$2",
          [runId, stepKey],
        )
      : null;
    const retry =
      retrySource?.current_attempt_id &&
      ["FAILED", "CANCELED", "RETRYING"].includes(retrySource.status)
        ? { source_attempt_id: retrySource.current_attempt_id }
        : undefined;
    const pending =
      feedback || opts.input || reexecute || retry
        ? {
            ...(opts.input ?? {}),
            ...(retry ? { execution_retry: retry } : {}),
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
    await reexecuteTx(c, run, stepKey, pending, afterCommit, why, undefined, opts.force === true);
    if (feedback) await runEvents.add(c, runId, "user", feedback);
    return;
  });
}

/** Retry = re-execute a FAILED/CANCELED step (same invalidation semantics). */
export const retryStep = (runId: number, stepKey: string, input?: Record<string, unknown>) =>
  reexecuteStep(runId, stepKey, { input, retry: true });

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
    for (const w of (await allWorkspacesOf(runId)).filter((x) => existsSync(x.path)))
      try {
        const snap = await snapshotUncommitted(
          w.path,
          `refs/platform/replan/run-${runId}/${id}${w.subtask_id ? `--${w.subtask_id}` : ""}`,
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
      const prev = await one<{ pending_input: { reexecute?: { skills?: unknown } | null } | null }>(
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
      for (const x of qs) {
        const problem = answerProblem(x.options, String(answers[x.id]));
        if (problem) throw new EngineError(problem, 400);
      }
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
        if (s.pending_input?.provider_handoff?.status) continue; // Unconfirmed handoffs own the continuation.
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
          const cp = await latestWaitCheckpoint(c, s.current_attempt_id);
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
          const replies = await q<{ id: number; answer: string }>(
            c,
            "SELECT id, answer FROM workflow_questions WHERE attempt_id = $1 AND status = 'answered'",
            [s.current_attempt_id],
          );
          if (
            cp?.data?.workspace_recovery &&
            !replies.some((reply) => reply.answer.trim() === "Workspace reconciled — continue")
          )
            throw new EngineError("Confirm workspace reconciliation before continuing", 409);
          if (cp?.data?.agent_configuration_recovery) {
            if (
              !replies.some(
                (reply) => reply.answer.trim() === "Use current configuration for remaining steps",
              )
            )
              throw new EngineError(
                "Choose the explicit configuration recovery option to continue",
                409,
              );
            const currentRun = await lockRun(c, runId);
            if (!currentRun.agent_configuration) {
              const recovered = {
                ...(await loadAgentConfiguration(c)),
                captured_at: new Date().toISOString(),
                capture_source: "authorized-recovery",
              };
              await q(
                c,
                "UPDATE workflow_runs SET agent_configuration=$2 WHERE id=$1 AND agent_configuration IS NULL",
                [runId, json(recovered)],
              );
              await runEvents.add(
                c,
                runId,
                "user",
                `Agent configuration recovered from current settings by ${answeredBy}; historical attempts unchanged`,
                s.id,
              );
            }
          }
          // A step paused by failure recovery: "stop" ends it as FAILED; anything else runs it again.
          const stop =
            (cp?.data?.failure || cp?.data?.recovery || cp?.data?.workspace_conflict) &&
            replies.some((a) => /^\s*(dừng|stop)\b/i.test(a.answer));
          // Choosing the release option is an approval the platform executes itself (prepare_branch moves the holder).
          const release = Array.isArray(cp?.data?.workspace_conflict)
            ? replies.find((a) => WORKSPACE_RELEASE_OPTIONS.includes(a.answer.trim()))
            : undefined;
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
              ...(cp?.data?.workspace_recovery
                ? { provider_handoff: undefined, replay_workspace_recovery: undefined }
                : {}),
              resume: { from_attempt_id: s.current_attempt_id, checkpoint: cp?.data ?? {} },
              ...(release && {
                workspace_release: {
                  holders: (cp?.data.workspace_conflict as WorkspaceConflict[])
                    .filter((x) => x.release === "approval")
                    .map((x) => x.holder_path),
                  question_id: release.id,
                  approved_by: answeredBy,
                },
              }),
            };
            await setStepStatus(
              c,
              s,
              "READY",
              { pending_input: pending, ready_at: new Date() },
              release ? "workspace release approved, resuming" : "answers received, resuming",
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
    /** Hash of the autonomy subject the approver was shown; a mismatch means the request changed (stale approval). */
    subject?: string;
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
    const shown = s.approval?.request?.autonomy?.subject?.hash ?? null;
    if (opts.subject && shown && opts.subject !== shown)
      throw new EngineError(`step "${stepKey}" changed since it was shown; review it again`, 409);
    const decision = {
      granted: true,
      generation: s.generation,
      actor_type: "human" as const,
      comment: opts.comment ?? "",
      by: opts.by ?? "",
      at: new Date(),
      ...(opts.data !== undefined ? { data: opts.data } : {}),
    };
    await recordHumanApproval(c, run, s, decision.by, shown);
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
        opts.data &&
        typeof opts.data === "object" &&
        "acknowledge_risk" in opts.data &&
        opts.data.acknowledge_risk === true,
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

/** What the worker needs to know about a claimed job before the attempt starts (read once, outside the run lock). */
export interface JobPreview {
  type: string;
  config: Record<string, unknown> & { delegation?: { enabled?: unknown } | null };
  agent_override: Record<string, unknown> | null;
  agent_provider: string | null;
  profile: string | null;
  agent_configuration: RunRow["agent_configuration"];
}
export function previewJob(jobId: number) {
  return one<JobPreview>(
    pool,
    `SELECT s.type, s.config, s.agent_override, r.agent_provider, r.profile, r.agent_configuration
       FROM workflow_jobs j
       JOIN workflow_steps s ON s.id = j.step_id
       JOIN workflow_runs r ON r.id = j.run_id
      WHERE j.id = $1`,
    [jobId],
  );
}

/** Probe outside the run lock. A disconnected or quota-exhausted agent is replaced before the attempt starts. */
async function healthyProviderSwitch(jobId: number, known?: JobPreview | null) {
  try {
    const preview = known === undefined ? await previewJob(jobId) : known;
    if (
      !preview ||
      !preview.agent_configuration ||
      !["agent", "coding_agent"].includes(preview.type)
    )
      return null;
    if (preview.config?.delegation?.enabled) return null;
    const policy = fallbackPolicy(preview);
    if (policy.mode === "disabled" || !policy.auto_health) return null;
    const effective = resolveStepAgent(preview, preview);
    if (!effective) return null;
    // The reading shared with chat admission (singleflight, reused up to HEALTH_REUSE_MS, invalidated by provider
    // failures) is enough to keep the chosen provider: the attempt itself still fails closed if it is not ready.
    // Switching away is decided on a fresh probe, never on a reused reading.
    const providers = new Set<string>(policy.providers);
    const shared = (await sharedAgentHealth()).filter((h) => providers.has(h.provider));
    if (isUsableAgent(shared.find((h) => h.provider === effective.provider))) return null;
    count("health.switch_probes");
    const health = await probeAgentHealth(policy.providers);
    const mine = health.find((h) => h.provider === effective.provider);
    if (isUsableAgent(mine)) return null;
    const next = nextHealthyProvider(
      policy.providers,
      new Set([effective.provider]),
      health,
      frozenProviderFlags(preview.agent_configuration),
    );
    if (!next) return null;
    return { from: effective.provider, to: next, reason: healthSkipReason(mine) };
  } catch {
    return null;
  }
}

/** Claim-time validation + attempt creation. Returns null when the job is stale (nothing to do). */
export async function beginAttempt(
  job: JobRow,
  worker: string,
  preview?: JobPreview | null,
): Promise<BegunAttempt | null> {
  const healthSwitch = await healthyProviderSwitch(job.id, preview);
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
      (run.status === "PAUSED" && j.force === true);
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
    // Run lock makes this a durable reader/writer gate. Concurrent coding is admitted only when
    // each step will get its own worktree (isolated_workspace and a distinct subtask id). A separate
    // checkout still does not name the files a step may edit, so an empty file list stays queued.
    const consumers = ["agent", "coding_agent", "command", "git_pull_request"];
    const writers = ["coding_agent", "command", "git_pull_request"];
    type ScopeConfig = {
      isolated_workspace?: unknown;
      max_concurrent_subtasks?: unknown;
      scope?: { owned_files?: string[]; repositories?: string[] } | null;
      subtask?: { owned_files?: string[]; target_repos?: string[] } | null;
      owned_files?: string[];
      target_repos?: string[];
    };
    const isolatedCoding = (
      type: string,
      config: ScopeConfig | null | undefined,
      subtaskId: string | null | undefined,
    ) =>
      type === "coding_agent" &&
      config?.isolated_workspace === true &&
      typeof subtaskId === "string" &&
      /^[a-z0-9][a-z0-9_-]*$/.test(subtaskId);
    const filesOf = (config: ScopeConfig | null | undefined): string[] =>
      config?.scope?.owned_files ?? config?.subtask?.owned_files ?? config?.owned_files ?? [];
    const reposOf = (config: ScopeConfig | null | undefined): string[] =>
      config?.scope?.repositories ?? config?.subtask?.target_repos ?? config?.target_repos ?? [];
    if (consumers.includes(step.type)) {
      const active = await q<{
        id: number;
        step_id: number;
        step_type: string;
        config: ScopeConfig;
        subtask_id: string | null;
      }>(
        c,
        `SELECT a.id, s.id AS step_id, s.type AS step_type, s.config, s.subtask_id
         FROM workflow_step_attempts a
         JOIN workflow_steps s ON s.id = a.step_id
         WHERE a.run_id = $1 AND (a.status = 'RUNNING' OR a.job_id = ANY($2::bigint[])) AND s.type = ANY($3::text[])`,
        [run.id, localJobs.activeIds(), consumers],
      );

      if (active.length > 0) {
        const isConcurrentCandidate = isolatedCoding(step.type, step.config, step.subtask_id);

        let conflict = false;
        if (!isConcurrentCandidate) {
          const isWriter = writers.includes(step.type);
          conflict = active.some((a) => isWriter || writers.includes(a.step_type));
        } else {
          const maxConcurrent = Number(step.config?.max_concurrent_subtasks ?? 4);
          if (active.length >= maxConcurrent) {
            conflict = true;
          } else {
            const stepFiles = filesOf(step.config);
            const stepRepos = reposOf(step.config);
            for (const a of active) {
              if (
                !isolatedCoding(a.step_type, a.config, a.subtask_id) ||
                a.subtask_id === step.subtask_id
              ) {
                conflict = true;
                break;
              }
              const activeFiles = filesOf(a.config);
              if (
                stepFiles.length > 0 &&
                activeFiles.length > 0 &&
                stepFiles.some((f) => activeFiles.includes(f))
              ) {
                conflict = true;
                break;
              }
              const activeRepos = reposOf(a.config);
              const disjointRepos =
                stepRepos.length > 0 &&
                activeRepos.length > 0 &&
                !stepRepos.some((r) => activeRepos.includes(r));
              if (!disjointRepos && (stepFiles.length === 0 || activeFiles.length === 0)) {
                conflict = true;
                break;
              }
            }
          }
        }

        if (conflict) {
          await q(
            c,
            "UPDATE workflow_jobs SET status='queued', lease_owner=NULL, lease_expires_at=NULL, available_at=now()+interval '1 second', updated_at=now() WHERE id=$1",
            [j.id],
          );
          return null;
        }
      }
    }
    if (
      healthSwitch &&
      run.agent_configuration &&
      ["agent", "coding_agent"].includes(step.type) &&
      !step.config.delegation?.enabled
    ) {
      const policy = fallbackPolicy(step);
      const current = resolveStepAgent(run, step);
      if (
        policy.mode !== "disabled" &&
        policy.auto_health &&
        current?.provider === healthSwitch.from &&
        policy.providers.includes(healthSwitch.to)
      ) {
        const override = {
          ...((step.agent_override ?? {}) as object),
          provider: healthSwitch.to,
          model: null,
          reasoning_effort: null,
        };
        await q(c, "UPDATE workflow_steps SET agent_override=$2 WHERE id=$1", [
          step.id,
          json(override),
        ]);
        step.agent_override = override;
        await runEvents.add(
          c,
          run.id,
          "provider_handoff",
          `${healthSwitch.from} skipped (${healthSwitch.reason}); using ${healthSwitch.to}`,
          step.id,
        );
      }
    }
    const previous =
      run.agent_configuration === null
        ? await one<{ effective_agent: AttemptRow["effective_agent"] }>(
            c,
            "SELECT effective_agent FROM workflow_step_attempts WHERE step_id=$1 AND effective_agent IS NOT NULL ORDER BY id DESC LIMIT 1",
            [step.id],
          )
        : null;
    const effective =
      run.agent_configuration === null
        ? (previous?.effective_agent ?? null)
        : resolveStepAgent(run, step);
    step.config = effectiveStepConfig(step.config, effective);
    const { n } = (await one<{ n: number }>(
      c,
      "SELECT COALESCE(max(number), 0)::int + 1 AS n FROM workflow_step_attempts WHERE step_id = $1",
      [step.id],
    ))!;
    const contextPreparationStarted = performance.now();
    const input = await buildStepInput(c, run, step);
    await validateContinuation(c, input, step.id, step.generation);
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
export async function heartbeat(
  jobId: number,
  token: number,
  leaseSeconds: number,
  attemptId?: number,
) {
  const r = await pool.query(
    `UPDATE workflow_jobs SET lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
      WHERE id = $1 AND fencing_token = $2 AND status = 'running' AND lease_expires_at > clock_timestamp()
        AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id = workflow_jobs.run_id AND r.worker_instance = $4)
        AND NOT EXISTS (SELECT 1 FROM platform_instances i WHERE i.instance_id = $4 AND (i.session_id <> $5 OR i.stopped_at IS NOT NULL))
        AND ($6::int IS NULL OR NOT EXISTS (SELECT 1 FROM provider_handoffs h WHERE h.source_attempt_id = $6 AND h.status = 'STOPPING'))`,
    [jobId, token, leaseSeconds, config.instanceId, instanceSession, attemptId ?? null],
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
        json(questionRow(x).options),
        questionRow(x).suggested,
      ],
    );
}

export function reapExpiredLeases() {
  return reapExpiredJobs(async (c, run, step, attempt, jobId, result, afterCommit) => {
    await applyResult(c, run, step, attempt, jobId, result, afterCommit);
    await enforceBudget(c, run, step.id, attempt.id);
  });
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

  if (run.profile === "MICRO" && result.kind === "failed") {
    const pending = await one<{ data: import("./types.ts").EscalationRequest }>(
      c,
      "SELECT data FROM workflow_checkpoints WHERE attempt_id=$1 AND reason='profile_escalation_requested' ORDER BY id DESC LIMIT 1",
      [attempt.id],
    );
    result = {
      kind: "profile_escalation",
      request: pending?.data ?? {
        target: "STANDARD",
        risk: "unknown",
        reason: result.error,
        expectedRevision:
          (run.graph as WorkflowSpec & { profile_revision?: number }).profile_revision ?? 0,
      },
    };
  }
  switch (result.kind) {
    case "profile_escalation": {
      const previousGraph = run.graph;
      const previousProfile = run.profile;
      await q(c, "SAVEPOINT profile_transition");
      try {
        await applyProfileEscalation(c, run, step, attempt, result.request);
        await q(c, "RELEASE SAVEPOINT profile_transition");
      } catch (error) {
        await q(c, "ROLLBACK TO SAVEPOINT profile_transition");
        run.graph = previousGraph;
        run.profile = previousProfile;
        return applyResult(
          c,
          run,
          step,
          attempt,
          jobId,
          {
            kind: "waiting_input",
            checkpoint: { profile_transition: result.request },
            questions: [
              {
                question:
                  "The profile transition requires reconciliation before execution can continue.",
                context: (error as Error).message,
                options: ["Review the preserved checkpoint and resume"],
              },
            ],
          },
          afterCommit,
        );
      }
      break;
    }
    case "completed": {
      let out = result.output ?? {};
      if (
        typeof out === "object" &&
        "selected_repositories" in out &&
        Array.isArray(out.selected_repositories)
      )
        await setSelectedRepositories(c, run, out.selected_repositories);
      // Workflow-to-workflow delegation: requested children are recorded with this completion (same transaction); a
      // blocking request holds the step until the children finish (workflow/delegation.ts).
      if (
        (step.type === "agent" || step.type === "coding_agent") &&
        out &&
        typeof out === "object" &&
        "child_workflows" in out
      ) {
        const plan = await planChildWorkflows(c, run, step, attempt, out);
        out = plan.output as typeof out;
        if (plan.waitFor) {
          await closeAttempt("WAITING_INPUT", out);
          await holdForChildren(c, step, plan.waitFor, afterCommit);
          await closeJob("done");
          break;
        }
        afterCommit(() => kickDelegations());
      }
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
      await recordClarification(
        c,
        run,
        step,
        await q(
          c,
          "SELECT question, options FROM workflow_questions WHERE attempt_id = $1 AND status = 'open'",
          [attempt.id],
        ),
      );
      await closeAttempt("WAITING_INPUT", result.output ?? null);
      const sealed = await readExecutionCheckpoint(c, attempt.id);
      await saveExecutionPause(
        c,
        attempt.id,
        "waiting_input",
        sealed
          ? { ...result.checkpoint, execution: continuationEvidence(sealed) }
          : (result.checkpoint ?? {}),
      );
      await setStepStatus(
        c,
        step,
        "WAITING_INPUT",
        result.checkpoint?.workspace_recovery
          ? { pending_input: { ...step.pending_input, replay_workspace_recovery: true } }
          : {},
        `${open} question(s)`,
      );
      await closeJob("done");
      const diagnosisSummary = (
        result.output as { diagnosis?: { summary?: string } | null } | null | undefined
      )?.diagnosis?.summary;
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
              detail: diagnosisSummary
                ? `${diagnosisSummary} — ${en ? "choose how to proceed" : "chọn cách xử lý"}`
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
      const gate = await evaluateGate(c, run, step, await stepsOf(c, run.id), result.request);
      if (gate?.enforced) {
        step.approval = machineApproval(gate);
        await q(c, "UPDATE workflow_steps SET approval = $2 WHERE id = $1", [
          step.id,
          json(step.approval),
        ]);
        await runEvents.add(
          c,
          run.id,
          "system",
          `${step.key} auto-approved (${gate.mode}): ${gate.reasons.join("; ")}`,
          step.id,
        );
        return applyResult(
          c,
          run,
          step,
          attempt,
          jobId,
          { kind: "completed", output: machineApprovalOutput(gate, result.request) },
          afterCommit,
        );
      }
      const request = gate ? { ...(result.request as object), autonomy: gate } : result.request;
      await closeAttempt("WAITING_APPROVAL", request);
      await saveExecutionPause(c, attempt.id, "waiting_approval", result.checkpoint ?? {});
      await setStepStatus(c, step, "WAITING_APPROVAL", {
        approval: { request, generation: step.generation, requested_at: now },
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
                result.request?.message ??
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
        `re-executed by ${step.key} (${result.reason ?? "developer decision after test failure"})`,
      );
      return;
    }
    case "failed": {
      // Workspace-conflict pauses ran no agent turn: they do not consume the retry budget.
      const pauses = await one<{ n: number }>(
        c,
        `SELECT count(*)::int AS n FROM workflow_checkpoints k JOIN workflow_step_attempts a ON a.id = k.attempt_id
          WHERE a.step_id = $1 AND a.generation = $2 AND k.data ? 'workspace_conflict'`,
        [step.id, step.generation],
      );
      const shaped = await recoveryForFailure(
        c,
        run,
        step,
        attempt,
        result,
        classifyFailure(result.error, {
          failureClass: failurePolicy(
            (result.details as { failure_code?: string } | undefined)?.failure_code,
          )?.failureClass,
          executorRetryable: result.retryable,
          attempt: step.attempt_count - (pauses?.n ?? 0),
          maxAttempts: attempt.effective_agent?.retry?.max_attempts ?? step.max_attempts,
          baseBackoff: attempt.effective_agent?.retry?.backoff_seconds ?? step.retry_backoff_s,
        }),
      );
      const decision = shaped.decision;
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
            context:
              decision.reason +
              (en
                ? `\nDiagnosis: ${shaped.diagnosis.category}. Work so far is kept (worktree and checkpoint); "Rerun this step" continues from it.`
                : `\nChẩn đoán: ${shaped.diagnosis.category}. Kết quả đã làm được giữ nguyên (worktree và checkpoint); "chạy lại bước" sẽ tiếp tục từ đó.`),
            options: en
              ? ["Rerun this step", "Stop here"]
              : ["Đã xử lý xong — chạy lại bước", "Dừng ở đây"],
          },
        ]);
        await saveExecutionPause(c, attempt.id, "waiting_input", { failure: decision });
        await setStepStatus(c, step, "WAITING_INPUT", {}, `paused: ${decision.class}`);
        await closeJob("done", result.error);
        if (shaped.notify) await markEscalationNotified(c, run.id, step.id);
        if (shaped.notify)
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
        const sealed = ["agent", "coding_agent"].includes(step.type)
          ? await readExecutionCheckpoint(c, attempt.id)
          : undefined;
        await setStepStatus(
          c,
          step,
          "RETRYING",
          {
            error: result.error,
            ...(sealed && {
              pending_input: {
                ...step.pending_input,
                resume: {
                  from_attempt_id: attempt.id,
                  checkpoint: {
                    execution: {
                      ...continuationEvidence(sealed),
                      workspace_reconciliation_required: true,
                    },
                  },
                },
              },
            }),
          },
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
  /** The attempt's run when the caller has it (an attempt never changes run); read from the attempt otherwise. */
  runId?: number,
) {
  return withTx(async (c, afterCommit) => {
    const attempt0 =
      runId != null
        ? { run_id: runId }
        : await one<AttemptRow>(c, "SELECT run_id FROM workflow_step_attempts WHERE id = $1", [
            attemptId,
          ]);
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
    const microEscalating =
      run.profile === "MICRO" &&
      !request &&
      (result.kind === "profile_escalation" ||
        (result.kind === "failed" && /execution timeout|context.*budget/i.test(result.error)) ||
        !!(await one(
          c,
          "SELECT 1 FROM workflow_checkpoints WHERE attempt_id=$1 AND reason='profile_escalation_requested' LIMIT 1",
          [attempt.id],
        )));
    if (
      !microEscalating &&
      handoff &&
      attempt.executor_stopped_at &&
      (request || handoff.failure)
    ) {
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
  // The pool can issue these reads concurrently; a transaction client queues them.
  const [run, steps] = await Promise.all([findRun(runId, db), stepsOf(db, runId)]);
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

/** Run page view with worker state derived from the stored run and steps. */
export async function runDetail(runId: number) {
  const { run, steps, attempts, questions, artifacts, prs, workspaces, checkpoints } =
    await loadRunDetail(runId);
  if (!run) throw new EngineError(`run ${runId} not found`, 404);
  const { wi_id, wi_code, wi_title, wi_source, wi_project, ...row } = run;
  const work_item =
    wi_id != null
      ? { id: wi_id, code: wi_code, title: wi_title, source: wi_source, project: wi_project }
      : null;
  const [worker, decisions, recovery_episodes, delegation] = await Promise.all([
    instanceHealth(row.worker_instance ?? null),
    decisionsOf(runId),
    recoveryEpisodesOf(runId),
    delegationsOf(runId),
  ]);
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
    checkpoints: checkpoints.map((c) => ({
      ...c,
      kind: isRecoverable(String(c.reason)) ? "recoverable" : "note",
    })),
    decisions,
    recovery_episodes,
    delegation,
  };
}

export async function stepDetail(runId: number, stepKey: string) {
  const detail = await loadStepDetail(runId, stepKey);
  if (!detail.step) throw new EngineError(`step "${stepKey}" not found`, 404);
  const step = detail.step;
  // An integrity failure of the wait checkpoint is shown as "no recovery action", never as a read error.
  const [decisions, continuation] = await Promise.all([
    decisionsOf(runId, step.id),
    planContinuation(pool, step).catch(() => null),
  ]);
  const views = detail.checkpoints.map((row) =>
    checkpointView(row, {
      stepGeneration: step.generation,
      attempts: detail.attempts,
      artifacts: detail.artifacts,
      reconciledAt: decisions.filter((d) => d.kind === "reconcile" && d.outcome === "applied"),
    }),
  );
  return {
    ...detail,
    step,
    checkpoint_view: views,
    latest_recoverable: latestRecoverable(views),
    recovery_action: continuation,
    decisions,
  };
}

/**
 * Steps waiting for a human approval (same owner scoping as openQuestions), for the "Questions & approvals" inbox.
 * `quick` = can be decided from the inbox (and Telegram) with approve/reject + comment; repository selection, branch
 * input and fenced provider handoffs need the full step UI. Step outputs are not copied here (they stay in the run).
 */
export async function openApprovals(db: Db = pool, scope?: OwnerScope) {
  const rows = await loadOpenApprovals(db, scope);
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
  // A login, quota or availability failure makes the shared readiness reading suspect: the next admission (chat or
  // workflow) probes again instead of reusing it.
  if (failure && ["AUTHENTICATION", "QUOTA_EXHAUSTED", "PROVIDER_UNAVAILABLE"].includes(failure))
    invalidateSharedAgentHealth();
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
    PAUSABLE_FAILURES.includes(failure) &&
    ((result.kind === "failed" &&
      typeof result.details === "object" &&
      result.details !== null &&
      "provider_error" in result.details &&
      !!result.details.provider_error) ||
      reported?.reported);
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
      blocked: handoffBlockReason(error),
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
  request: { reason: string } | null | undefined,
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
  const policy = fallbackPolicy(step);
  const failedProvider = attempt.agent_provider ?? run.agent_provider;
  const healthFailover =
    !request &&
    !blocked &&
    policy.mode !== "disabled" &&
    policy.auto_health &&
    ["AUTHENTICATION", "QUOTA_EXHAUSTED"].includes(String(p.failure)) &&
    !step.config.delegation?.enabled;
  if (healthFailover && p.failure === "QUOTA_EXHAUSTED" && failedProvider)
    rememberProviderQuota(failedProvider);
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
      !request && (policy.mode === "automatic" || healthFailover),
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
      blocked_reason: blocked,
    },
    package_reference: `provider_handoffs:${handoff.id}`,
    workspace_fingerprint: p.fingerprint ?? null,
  };
  await saveExecutionPause(
    c,
    attempt.id,
    "provider_handoff",
    checkpoint,
    p.fingerprint ? { fingerprint: p.fingerprint } : undefined,
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
  await recordDecision(c, {
    runId: run.id,
    stepId: step.id,
    attemptId: attempt.id,
    generation: attempt.generation,
    kind: "recovery",
    action: "HANDOFF",
    outcome: "planned",
    reason,
    details: {
      handoff_id: handoff.id,
      status: handoff.status,
      failure_category: p.failure ?? null,
    },
  });
  await advance(c, run.id, afterCommit);
}

/** Called after the worker has released the job, so termination is visible to the next provider. */
export async function continueHealthyHandoffForAttempt(attemptId: number) {
  const handoff = await one<{
    id: number;
    run_id: number;
    source_attempt_id: number;
    workspace_fingerprint: string | null;
    original_provider: string;
    failure_category: string;
    key: string;
  }>(
    pool,
    `SELECT h.id, h.run_id, h.source_attempt_id, h.workspace_fingerprint, h.original_provider, h.failure_category, s.key
       FROM provider_handoffs h
       JOIN workflow_steps s ON s.id = h.step_id
      WHERE h.source_attempt_id = $1 AND h.status = 'READY' AND h.automatic
        AND h.failure_category IN ('AUTHENTICATION', 'QUOTA_EXHAUSTED')`,
    [attemptId],
  );
  if (!handoff?.workspace_fingerprint) return;
  const step = await one<StepRow>(pool, "SELECT * FROM workflow_steps WHERE key=$1 AND run_id=$2", [
    handoff.key,
    handoff.run_id,
  ]);
  if (!step) return;
  const policy = fallbackPolicy(step);
  if (!policy.auto_health || policy.mode === "disabled" || step.config.delegation?.enabled) return;
  await continueHealthyProvider(
    handoff.run_id,
    handoff.key,
    {
      id: handoff.id,
      source_attempt_id: handoff.source_attempt_id,
      workspace_fingerprint: handoff.workspace_fingerprint,
    },
    handoff.original_provider,
    policy.providers,
    handoff.failure_category,
  );
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
      prepared = { blocked: handoffBlockReason(e) };
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
            status: blocked ? "BLOCKED" : "READY",
            failure_category: requested.handoff.failure_category ?? null,
            blocked_reason: blocked,
          },
        },
        error: input.reason,
      });
      await saveExecutionPause(
        c,
        input.expected_attempt_id,
        "provider_handoff",
        { provider_handoff: { id: requested.handoff.id } },
        prepared.fingerprint ? { fingerprint: prepared.fingerprint } : undefined,
      );
      await advance(c, runId, afterCommit);
    });
  }
  return one(pool, "SELECT * FROM provider_handoffs WHERE id=$1", [requested.handoff.id]);
}
export const ResumeHandoff = z
  .object({
    handoff_id: z.number().int().positive(),
    expected_attempt_id: z.number().int().positive(),
    provider: z.enum(["claude", "codex", "cursor", "antigravity", "copilot"]),
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
    if (
      s.approval?.actor_type === "machine" &&
      !(await evaluateGate(c, locked, s, await stepsOf(c, locked.id), null))?.enforced
    )
      throw new EngineError(
        "The machine approval no longer holds under the current autonomy policy",
        409,
      );
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
    // max_switches stops automatic failover. A person who confirms a switch is warned and allowed through.
    const switches = history.filter((v) => v.target_provider !== v.original_provider).length;
    const switchBudgetWarning =
      input.provider !== h.original_provider && switches >= policy.max_switches
        ? `Provider switch budget reached (${switches}/${policy.max_switches}); manual confirmation continues`
        : null;
    if (switchBudgetWarning && automatic)
      throw new EngineError("Provider switch budget exhausted", 409);
    const healthFailover =
      policy.auto_health && ["AUTHENTICATION", "QUOTA_EXHAUSTED"].includes(h.failure_category);
    if (automatic) {
      if (
        h.requested_by != null ||
        (!healthFailover &&
          (policy.mode !== "automatic" || !AUTOMATIC_FAILURES.includes(h.failure_category)))
      )
        throw new EngineError("Failure requires manual recovery", 409);
      if (
        [
          h.original_provider,
          ...history.flatMap((v) => [v.original_provider, v.target_provider]),
        ].includes(input.provider)
      )
        throw new EngineError("Automatic provider loop prevented", 409);
      const usage = healthFailover
        ? []
        : await q(
            c,
            "SELECT reported_cost_usd,input_tokens,output_tokens FROM execution_attempt_telemetry WHERE step_id=$1",
            [s.id],
          );
      if (
        !healthFailover &&
        !policy.allow_unknown_cost &&
        (usage.some((u) => u.reported_cost_usd == null) || ready.cost === "unknown")
      )
        throw new EngineError(
          "Unknown provider cost requires explicit fallback policy permission",
          409,
        );
      if (
        !healthFailover &&
        /budget|billing|credit|cost/i.test(h.reason) &&
        !policy.allow_budget_failure
      )
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
    await recordDecision(c, {
      runId,
      stepId: s.id,
      attemptId: h.source_attempt_id,
      generation: s.generation,
      kind: "recovery",
      action: "HANDOFF",
      outcome: "applied",
      reason: `${h.original_provider} → ${input.provider}`,
      sourceAttemptId: h.source_attempt_id,
      latencyMs: h.created_at ? Date.now() - new Date(h.created_at).getTime() : null,
      details: { handoff_id: h.id, automatic, human: !automatic },
    });
    await q(c, "UPDATE workflow_steps SET agent_override=$2 WHERE id=$1", [s.id, json(override)]);
    const sealed = await readExecutionCheckpoint(c, h.source_attempt_id);
    await setStepStatus(
      c,
      s,
      "READY",
      {
        pending_input: {
          provider_handoff: {
            id: h.id,
            source_attempt_id: h.source_attempt_id,
            workspace_fingerprint: h.workspace_fingerprint,
            package: sealed
              ? {
                  ...h.package,
                  execution_checkpoint: continuationEvidence(sealed),
                }
              : h.package,
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
            warning: switchBudgetWarning,
          }),
        ],
      );
    await runEvents.add(
      c,
      runId,
      "provider_handoff",
      switchBudgetWarning
        ? `${h.original_provider} → ${input.provider}; ${switchBudgetWarning}`
        : `${h.original_provider} → ${input.provider}`,
      s.id,
      h.source_attempt_id,
      { handoff_id: h.id, automatic, warning: switchBudgetWarning },
    );
    await advance(c, runId, afterCommit);
    return {
      handoff: { ...h, status: "RESUMED", target_provider: input.provider },
      duplicate: false,
      warning: switchBudgetWarning,
    };
  });
}

/** Continue a disconnected or quota-exhausted agent on the next healthy provider. No manual switch. */
async function continueHealthyProvider(
  runId: number,
  stepKey: string,
  handoff: { id: number; source_attempt_id: number; workspace_fingerprint: string },
  failedProvider: string,
  order: readonly AgentProvider[],
  failure: string,
) {
  try {
    const health = (await probeAgentHealth(order)).map((row) =>
      row.provider === failedProvider
        ? {
            ...row,
            connected: failure === "AUTHENTICATION" ? false : row.connected,
            quota: failure === "QUOTA_EXHAUSTED" ? ("exhausted" as const) : row.quota,
            reason: failure === "QUOTA_EXHAUSTED" ? "quota exhausted" : row.reason,
          }
        : row,
    );
    const run = await one<RunRow>(pool, "SELECT * FROM workflow_runs WHERE id=$1", [runId]);
    const next = nextHealthyProvider(
      order,
      new Set([failedProvider]),
      health,
      frozenProviderFlags(run?.agent_configuration),
    );
    if (!next) return;
    await resumeProviderHandoff(
      runId,
      stepKey,
      {
        handoff_id: handoff.id,
        expected_attempt_id: handoff.source_attempt_id,
        provider: next,
        confirm: true,
        checkpoint_fingerprint: handoff.workspace_fingerprint,
      },
      null,
      true,
    );
  } catch (error) {
    await q(pool, "UPDATE provider_handoffs SET blocked_reason=$2 WHERE id=$1 AND status='READY'", [
      handoff.id,
      safeDiagnostics(error),
    ]);
  }
}

/** One non-overlapping scheduler reconciliation reads the next persisted due handoff, so restart cannot lose an automatic continuation. */
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
      if (!providerEnabled(provider, frozenProviderFlags(run.agent_configuration)))
        return {
          provider,
          ok: false,
          error: "disabled in Settings",
          models: [],
          quota: "unknown" as const,
          cost: "unknown" as const,
        };
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
