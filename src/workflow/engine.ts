import type pg from "pg";
import { config } from "../config.ts";
import { outputLocale, resolveOutputLocale, type OutputLocale } from "../agent/language.ts";
import { resolveAgentProvider, type AgentProvider } from "../agent/provider.ts";
import { pool, q, one, withTx, json, type Db } from "../db/pool.ts";
import { notify, notifyStepWaiting } from "../notify.ts";
import { isAmbiguous, rankRepositories, repositories } from "../repos/service.ts";
import { ensureTestOwner } from "../auth/testOwner.ts";
import { definitions } from "./definitions.ts";
import { detectBranchDirectives, normalizeBranchMap } from "./branches.ts";
import { classifyFailure } from "./failures.ts";
import { extractRunMemory } from "../knowledge/memory.ts";
import { storeRunSummary } from "../report/runSummary.ts";
import { background } from "./background.ts";
import { downstream, getPath, topoOrder } from "./graph.ts";
import { localJobs } from "./local.ts";
import { runEvents } from "./events.ts";
import { assertRunTransition, assertStepTransition, deriveRunStatus, DONE, RETRYABLE } from "./stateMachine.ts";
import { buildStepInput, resolveContext, type ResolvedContext, type StepInput } from "./context.ts";
import type { AttemptRow, ExecResult, JobRow, QuestionInput, RunRow, RunStatus, StepRow, StepStatus, WorkflowSpec } from "./types.ts";
import { parseAiSuggest, type ReportSpec } from "../report/aiSuggest.ts";
import { applyProfile, classifyProfile, ProfileNotApplicable, type ProfileChange, type ProfileChoice, type ProfileDecision } from "./profiles.ts";

export const REPORT_STEP_KEY = "task_result_report";

/**
 * Append the optional final Task Result Report step to a run's resolved graph (never to the published definition).
 * Depends on every terminal step, so it runs only after all work (tests, review, PR) is done. Idempotent: a graph that
 * already has a report step (custom workflow, or injected before) is returned unchanged.
 */
export function withReportStep(spec: WorkflowSpec, ai: ReportSpec | null): WorkflowSpec {
  if (!ai || spec.steps.some((s) => s.key === REPORT_STEP_KEY || s.type === "task_result_report")) return spec;
  const terminals = spec.steps.filter((s) => !spec.steps.some((o) => o.depends_on.includes(s.key))).map((s) => s.key);
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
 *  - every mutation of a run, its steps, attempts or jobs happens in a transaction that first locks the run
 *    row (`lockRun`), so lock order is always run → job → step → attempt;
 *  - step status changes are validated by the state machine;
 *  - an attempt's result is applied only if its job's fencing token and its step's generation are unchanged.
 */

export class EngineError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

type AfterCommit = (cb: () => unknown) => void;

// ---------------------------------------------------------------- low-level helpers

async function lockRun(c: Db, runId: number): Promise<RunRow> {
  const run = await one<RunRow>(c, "SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE", [runId]);
  if (!run) throw new EngineError(`run ${runId} not found`, 404);
  return run;
}

const stepsOf = (c: Db, runId: number) => q<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 ORDER BY position", [runId]);

const JSON_COLS = new Set(["output", "pending_input", "approval", "config"]);

async function updateStep(c: Db, step: StepRow, patch: Partial<Record<keyof StepRow | "ready_at" | "started_at" | "finished_at", unknown>>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  await q(
    c,
    `UPDATE workflow_steps SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
    [step.id, ...keys.map((k) => (JSON_COLS.has(k) ? json((patch as any)[k]) : (patch as any)[k]))],
  );
  Object.assign(step, patch);
}

async function setStepStatus(c: Db, step: StepRow, to: StepStatus, patch: Parameters<typeof updateStep>[2] = {}, note = "") {
  assertStepTransition(step.status, to);
  const from = step.status;
  await updateStep(c, step, { ...patch, status: to });
  if (from !== to) await runEvents.add(c, step.run_id, "status", `${step.key}: ${from} → ${to}${note ? ` (${note})` : ""}`, step.id);
}

async function setRunStatus(c: Db, run: RunRow, to: RunStatus, afterCommit?: AfterCommit, error: string | null = null) {
  if (run.status === to) return;
  assertRunTransition(run.status, to);
  const from = run.status;
  await q(
    c,
    `UPDATE workflow_runs SET status = $2, error = $3, updated_at = now(),
       started_at = COALESCE(started_at, CASE WHEN $2 = 'RUNNING' THEN now() END),
       finished_at = CASE WHEN $2 IN ('COMPLETED', 'FAILED', 'CANCELED') THEN now() ELSE NULL END
     WHERE id = $1`,
    [run.id, to, error],
  );
  run.status = to;
  await runEvents.add(c, run.id, "status", `run: ${from} → ${to}`);
  if (afterCommit && (to === "COMPLETED" || to === "FAILED" || to === "WAITING")) {
    const icon = { COMPLETED: "✅", FAILED: "❌", WAITING: "⏸️" }[to];
    afterCommit(() => background(`notify run ${run.id}`, () => notify(`${icon} Run #${run.id} ${run.title}: ${to}`, `/runs/${run.id}`)));
    // Cross-task memory: verified facts (enabled) + agent conclusions (disabled until a human approves).
    if (to === "COMPLETED") afterCommit(() => background(`memory extraction for run ${run.id}`, () => extractRunMemory(run.id)));
  }
  // "What did this run do?" snapshot for the work item page (factual, from the run's own records; never throws).
  if (afterCommit && (to === "COMPLETED" || to === "FAILED" || to === "CANCELED")) afterCommit(() => background(`run ${run.id} summary`, () => storeRunSummary(run.id)));
}

async function ensureJob(c: Db, step: StepRow, delaySeconds = 0) {
  await q(
    c,
    `INSERT INTO workflow_jobs (run_id, step_id, generation, idempotency_key, available_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5)) ON CONFLICT DO NOTHING`,
    [step.run_id, step.id, step.generation, `step:${step.id}:gen:${step.generation}:n:${step.attempt_count}`, delaySeconds],
  );
}

/** Cancel live jobs of a step and fence out whoever holds them. Returns ids for local abort. */
async function cancelStepJobs(c: Db, stepId: number, reason: string): Promise<number[]> {
  const rows = await q<{ id: number }>(
    c,
    `UPDATE workflow_jobs SET status = 'canceled', fencing_token = fencing_token + 1, last_error = $2, updated_at = now()
      WHERE step_id = $1 AND status IN ('queued', 'running') RETURNING id`,
    [stepId, reason],
  );
  return rows.map((r) => r.id);
}

function runIfMatches(runIf: NonNullable<StepRow["run_if"]>, byKey: Map<string, StepRow>) {
  const src = byKey.get(runIf.step);
  if (runIf.status) return src?.status === runIf.status;
  if (!src || src.status !== "COMPLETED") return false;
  return JSON.stringify(getPath(src.output, runIf.path ?? "result")) === JSON.stringify(runIf.equals);
}

// ---------------------------------------------------------------- advance

/**
 * Move the run forward: promote PENDING steps whose dependencies are done, enqueue READY steps, and derive
 * the run status. Idempotent: calling it twice changes nothing the second time.
 */
export async function advance(c: Db, runId: number, afterCommit?: AfterCommit): Promise<RunRow> {
  const run = await lockRun(c, runId);
  if (run.status === "CANCELED" || run.status === "PENDING") return run;
  // PAUSED runs still promote steps (so step mode shows what is runnable next) but nothing is enqueued.
  const steps = await stepsOf(c, runId);
  const byKey = new Map(steps.map((s) => [s.key, s]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of steps) {
      if (s.status !== "PENDING") continue;
      if (!s.depends_on.every((d) => DONE.includes(byKey.get(d)!.status))) continue;
      if (s.run_if && !runIfMatches(s.run_if, byKey)) {
        await setStepStatus(c, s, "SKIPPED", { output: { skipped: true, reason: `run_if ${s.run_if.step} not matched` }, finished_at: new Date() });
      } else if (s.requires_approval && !(s.approval?.granted && s.approval.generation === s.generation)) {
        await setStepStatus(c, s, "WAITING_APPROVAL", { approval: { gate: true, generation: s.generation, requested_at: new Date() } }, "approval gate");
        afterCommit?.(() => background(`notify run ${run.id}`, () => {
          const en = outputLocale(run) === "en";
          return notifyStepWaiting(en ? `✋ Run #${run.id}: ${s.name} needs approval before it runs` : `✋ Run #${run.id}: bước ${s.name} cần duyệt trước khi chạy`, {
            runId: run.id, runTitle: run.title, stepKey: s.key, stepName: s.name, status: "WAITING_APPROVAL",
            detail: en ? "approve before this step runs" : "cần duyệt trước khi chạy bước này",
            stepId: s.id, generation: s.generation, locale: outputLocale(run), ownerId: run.owner_id ?? undefined,
          });
        }));
      } else {
        await setStepStatus(c, s, "READY", { ready_at: new Date() });
      }
      changed = true;
    }
  }
  if (run.status !== "PAUSED") for (const s of steps) if (s.status === "READY") await ensureJob(c, s);
  await setRunStatus(c, run, deriveRunStatus(run.status, steps), afterCommit);
  return run;
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
  /** Agent implementation. Omitted → claude. Resolved once; retries keep the stored value. */
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
  const wi = input.workItemId ? await one(c, "SELECT * FROM work_items WHERE id = $1", [input.workItemId]) : null;
  if (input.workItemId && !wi) throw new EngineError(`work item ${input.workItemId} not found`, 404);
  let ownerId = input.ownerId ?? null;
  if (wi) {
    if (wi.owner_id == null) throw new EngineError("work item has no owner", 404);
    if (ownerId != null && Number(ownerId) !== Number(wi.owner_id)) throw new EngineError("run owner must match the work item", 403);
    ownerId = Number(wi.owner_id);
  } else if (ownerId == null && process.env.PLATFORM_TEST === "1") ownerId = await ensureTestOwner();
  if (ownerId == null) throw new EngineError("a run needs an owner", 400);
  const owner = await one<{ active: boolean }>(c, "SELECT active FROM users WHERE id = $1", [ownerId]);
  if (!owner?.active) throw new EngineError("owner is not active", 403);
  const dv = await definitions.version(input.definitionKey, input.version, c, ownerId);
  if (!dv) throw new EngineError(`workflow "${input.definitionKey}"${input.version ? ` v${input.version}` : ""} has no published version`, 404);
  const inputs = input.inputs ?? {};
  const project = wi?.project || String(inputs.project ?? "");
  const allowed = await repositories.allowedFor(project, "read", c);
  let selected = input.repositories ?? (Array.isArray(inputs.repositories) ? (inputs.repositories as string[]) : []);
  const outside = selected.filter((r) => !allowed.includes(r));
  if (outside.length) throw new EngineError(`repositories not allowed for this run: ${outside.join(", ")} (allowed: ${allowed.join(", ") || "none"})`, 400);
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
  const text = [wi?.title, wi?.description, input.title, JSON.stringify(inputs)].filter(Boolean).join("\n");
  const ranked = rankRepositories((await repositories.list(c)).filter((r) => allowed.includes(r.name)), { text, project });
  const positive = ranked.filter((r) => r.score > 0 && !r.reasons.every((x) => x.startsWith("mapped to project")));
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
  let decision = { ...decision0, signals: { ...decision0.signals, reused_repositories: reusedRepositories } };
  let resolved: { spec: WorkflowSpec; changes: ProfileChange[] };
  try {
    resolved = applyProfile(dv.spec, decision.profile);
  } catch (e) {
    if (!(e instanceof ProfileNotApplicable)) throw e;
    decision = { ...decision, profile: "STANDARD", reasons: [...decision.reasons, `FAST not applicable: ${e.message} → STANDARD`] };
    resolved = { spec: dv.spec, changes: [] };
  }
  const graph = withReportStep(resolved.spec, wi ? parseAiSuggest(wi.payload) : null);
  return { dv, wi, inputs, allowed, selected, reusedRepositories, decision, changes: resolved.changes, graph, reportAdded: graph !== resolved.spec, ownerId: ownerId! };
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
    agent_provider = resolveAgentProvider(input.agentProvider);
  } catch (e) {
    throw new EngineError((e as Error).message, 400);
  }
  return withTx(async (c, afterCommit) => {
    const r = await resolveRunGraph(c, input);
    const { dv, wi, inputs, allowed, selected, graph } = r;
    const { id } = (await one<{ id: number }>(c, "SELECT nextval('workflow_runs_id_seq')::bigint AS id"))!;
    const raw = String(wi?.code ?? `run-${id}`).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
    const branch = `u${r.ownerId}-${raw}`.slice(0, 80);
    if (wi && inputs.task_code == null) inputs.task_code = wi.code;
    // Existing-branch directives: explicit inputs.branches, else detected from the work item text ("làm tiếp từ branch X ở repo").
    const explicitBranches = normalizeBranchMap(inputs.branches, config.baseBranch);
    if (explicitBranches) inputs.branches = explicitBranches;
    else if (wi) {
      const repoNames = (await q<{ name: string }>(c, "SELECT name FROM repositories")).map((x) => x.name);
      const detected = detectBranchDirectives([wi.title, wi.description, wi.payload?.note].filter(Boolean).join("\n"), repoNames, config.baseBranch);
      if (Object.keys(detected).length) Object.assign(inputs, { branches: detected, branches_source: "work item description" });
    }
    const title = input.title || (wi ? `${wi.code}: ${wi.title}` : `${dv.spec.name} #${id}`);
    const resolvedGraph = { ...graph, profile: r.decision.profile, profile_changes: r.changes };
    await q(
      c,
      `INSERT INTO workflow_runs (id, definition_version_id, definition_key, work_item_id, title, status, inputs, graph,
                                  allowed_repositories, selected_repositories, branch, profile, profile_decision, output_locale, agent_provider, owner_id, worker_instance)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [id, dv.id, dv.key, wi?.id ?? null, title, json(inputs), json(resolvedGraph), allowed, selected, branch, r.decision.profile, json(r.decision), output_locale, agent_provider, r.ownerId, config.instanceId],
    );
    const order = topoOrder(graph.steps);
    for (const s of graph.steps) {
      const requiresApproval = s.requires_approval || (s.type === "git_pull_request" && s.config.mode === "approval");
      await q(
        c,
        `INSERT INTO workflow_steps (run_id, key, type, name, position, depends_on, config, run_if, requires_approval, max_attempts, retry_backoff_s, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING')`,
        [id, s.key, s.type, s.name ?? s.key, order.indexOf(s.key), s.depends_on, json(s.config), json(s.run_if ?? null), requiresApproval, s.max_attempts, s.retry_backoff_seconds],
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
    if (wi) await q(c, "UPDATE work_items SET status = 'in_progress', updated_at = now() WHERE id = $1 AND status = 'open'", [wi.id]);
    const run = (await one<RunRow>(c, "SELECT * FROM workflow_runs WHERE id = $1", [id]))!;
    if (input.start !== false) {
      await setRunStatus(c, run, "RUNNING");
      await advance(c, id, afterCommit);
    }
    return getRun(id, c);
  });
}

export async function startPendingRun(runId: number, repositoriesOverride?: string[], stepMode = false) {
  return withTx(async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    if (run.status !== "PENDING") throw new EngineError(`run ${runId} is ${run.status}, not PENDING`);
    await adoptRun(c, runId);
    if (repositoriesOverride) await setSelectedRepositories(c, run, repositoriesOverride);
    await setRunStatus(c, run, "RUNNING");
    if (stepMode) await setRunStatus(c, run, "PAUSED");
    await advance(c, runId, afterCommit);
    return getRun(runId, c);
  });
}

export async function pauseRun(runId: number) {
  return withTx(async (c) => {
    const run = await lockRun(c, runId);
    if (run.status === "PAUSED") return getRun(runId, c);
    await setRunStatus(c, run, "PAUSED");
    return getRun(runId, c);
  });
}

export async function resumeRun(runId: number) {
  return withTx(async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    if (run.status !== "PAUSED") throw new EngineError(`run ${runId} is ${run.status}, not PAUSED`);
    await adoptRun(c, runId);
    await setRunStatus(c, run, "RUNNING");
    await advance(c, runId, afterCommit);
    return getRun(runId, c);
  });
}

export async function cancelRun(runId: number, reason = "canceled by user") {
  return withTx(async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    if (run.status === "CANCELED") return getRun(runId, c);
    const aborted: number[] = [];
    for (const s of await stepsOf(c, runId)) {
      if (["COMPLETED", "SKIPPED", "CANCELED", "FAILED"].includes(s.status)) continue;
      aborted.push(...(await cancelStepJobs(c, s.id, reason)));
      await setStepStatus(c, s, "CANCELED", { finished_at: new Date() }, reason);
    }
    await q(c, "UPDATE workflow_step_attempts SET status = 'CANCELED', finished_at = now(), error = $2 WHERE run_id = $1 AND status = 'RUNNING'", [
      runId,
      json({ message: reason }),
    ]);
    await q(c, "UPDATE workflow_questions SET status = 'dismissed' WHERE run_id = $1 AND status = 'open'", [runId]);
    await setRunStatus(c, run, "CANCELED", undefined, reason);
    afterCommit(() => aborted.forEach((id) => localJobs.abort(id)));
    return getRun(runId, c);
  });
}

async function setSelectedRepositories(c: Db, run: RunRow, repos: string[]) {
  const clean = [...new Set(repos.map(String))];
  const outside = clean.filter((r) => !run.allowed_repositories.includes(r));
  if (outside.length) throw new EngineError(`repositories outside the allowed set: ${outside.join(", ")}`, 400);
  await q(c, "UPDATE workflow_runs SET selected_repositories = $2, updated_at = now() WHERE id = $1", [run.id, clean]);
  run.selected_repositories = clean;
  await runEvents.add(c, run.id, "system", `selected repositories: ${clean.join(", ") || "(none)"}`);
}

export async function selectRepositories(runId: number, repos: string[]) {
  return withTx(async (c) => {
    const run = await lockRun(c, runId);
    await setSelectedRepositories(c, run, repos);
    return getRun(runId, c);
  });
}

// ---------------------------------------------------------------- re-execution

/**
 * Re-execute `stepKey`: bump its generation, make it READY, and reset every transitive dependant to PENDING
 * (their outputs were derived from context that is now stale). Steps that are not downstream keep their
 * results — e.g. retrying implementation reuses the completed analysis and plan.
 */
async function reexecuteTx(c: Db, run: RunRow, stepKey: string, pending: Record<string, unknown> | null, afterCommit: AfterCommit, why: string) {
  if (run.status === "CANCELED") throw new EngineError("run is canceled");
  const steps = await stepsOf(c, run.id);
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const target = byKey.get(stepKey);
  if (!target) throw new EngineError(`step "${stepKey}" not found`, 404);
  if (!RETRYABLE.includes(target.status)) throw new EngineError(`step "${stepKey}" is ${target.status}; only ${RETRYABLE.join("/")} steps can be re-executed`);
  const blocked = target.depends_on.filter((d) => !DONE.includes(byKey.get(d)!.status));
  if (blocked.length) throw new EngineError(`upstream steps not complete: ${blocked.join(", ")}`);

  const aborted: number[] = [];
  const invalidate = async (s: StepRow, to: "PENDING" | "READY") => {
    aborted.push(...(await cancelStepJobs(c, s.id, `invalidated by re-execution of ${stepKey}`)));
    await q(c, "UPDATE workflow_step_attempts SET status = 'CANCELED', finished_at = now() WHERE step_id = $1 AND status = 'RUNNING'", [s.id]);
    await q(c, "UPDATE workflow_step_attempts SET invalidated_at = now() WHERE step_id = $1 AND invalidated_at IS NULL", [s.id]);
    await q(c, "UPDATE workflow_questions SET status = 'dismissed' WHERE step_id = $1 AND status = 'open'", [s.id]);
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
        pending_input: s === target ? pending : null,
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
export async function reexecuteStep(runId: number, stepKey: string, opts: { input?: Record<string, unknown>; feedback?: string; skills?: string[]; by?: string } = {}) {
  return withTx(async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    const feedback = opts.feedback?.trim() || undefined;
    const keys = [...new Set((opts.skills ?? []).map(String).filter(Boolean))];
    const pinned = keys.length
      ? await q<{ key: string; version: number; title: string }>(c, "SELECT key, current_version AS version, title FROM knowledge_items WHERE key = ANY($1) ORDER BY key", [keys])
      : [];
    const unknown = keys.filter((k) => !pinned.some((p) => p.key === k));
    if (unknown.length) throw new EngineError(`unknown skill(s): ${unknown.join(", ")}`, 400);
    const reexecute = feedback || pinned.length ? { instructions: feedback ?? null, skills: pinned, requested_by: opts.by ?? "", at: new Date().toISOString() } : null;
    const pending = feedback || opts.input || reexecute ? { ...(opts.input ?? {}), ...(feedback ? { feedback } : {}), ...(reexecute ? { reexecute } : {}) } : null;
    await adoptRun(c, runId);
    const why = reexecute ? `re-executed with ${[feedback && "instructions", pinned.length && `skills ${pinned.map((p) => `${p.key}@v${p.version}`).join(", ")}`].filter(Boolean).join(" + ")}` : "re-executed by user";
    await reexecuteTx(c, run, stepKey, pending, afterCommit, why);
    if (feedback) await runEvents.add(c, runId, "user", feedback);
    return getRun(runId, c);
  });
}

/** Retry = re-execute a FAILED/CANCELED step (same invalidation semantics). */
export const retryStep = (runId: number, stepKey: string, input?: Record<string, unknown>) => reexecuteStep(runId, stepKey, { input });

/** Review feedback ("Nhắn cho agent"): re-run the workflow's feedback step; downstream test/PR re-run too. */
export async function sendFeedback(runId: number, message: string) {
  const run = await getRun(runId);
  const key = run.graph.feedback_step ?? run.graph.steps.find((s) => s.type === "coding_agent")?.key;
  if (!key) throw new EngineError("this workflow has no step that accepts feedback");
  return reexecuteStep(runId, key, { feedback: message });
}

/**
 * Step mode: execute one READY step of a PAUSED run now. The run stays paused, so nothing else starts; when the
 * step finishes its dependants become READY and can be run the same way (or the run resumed).
 */
export async function runStepNow(runId: number, stepKey: string) {
  return withTx(async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    if (run.status !== "PAUSED") throw new EngineError(`run is ${run.status}: "run step" is for paused runs (step mode); running runs schedule steps automatically`);
    await adoptRun(c, runId);
    await advance(c, runId, afterCommit);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [runId, stepKey]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (s.status !== "READY" && s.status !== "RETRYING") throw new EngineError(`step "${stepKey}" is ${s.status}; only READY steps can be run (dependencies must be complete)`);
    await ensureJob(c, s);
    await q(c, "UPDATE workflow_jobs SET force = true, available_at = LEAST(available_at, now()) WHERE step_id = $1 AND status = 'queued'", [s.id]);
    await runEvents.add(c, runId, "user", `run step ${stepKey} (step mode)`, s.id);
    return getRun(runId, c);
  });
}

/** Stop a RUNNING step now: its attempt is canceled, the worker is fenced out and aborted; the step becomes FAILED. */
export async function stopStep(runId: number, stepKey: string, reason = "stopped by user") {
  return withTx(async (c, afterCommit) => {
    await lockRun(c, runId);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [runId, stepKey]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (s.status !== "RUNNING" && s.status !== "RETRYING") throw new EngineError(`step "${stepKey}" is ${s.status}, not running`);
    const aborted = await cancelStepJobs(c, s.id, reason);
    await q(c, "UPDATE workflow_step_attempts SET status = 'CANCELED', finished_at = now(), error = $2 WHERE step_id = $1 AND status = 'RUNNING'", [s.id, json({ message: reason })]);
    await setStepStatus(c, s, "FAILED", { error: reason, finished_at: new Date() }, reason);
    await runEvents.add(c, runId, "user", `${reason}: ${stepKey}`, s.id);
    afterCommit(() => aborted.forEach((id) => localJobs.abort(id)));
    await advance(c, runId, afterCommit);
    return getRun(runId, c);
  });
}

export async function skipStep(runId: number, stepKey: string, reason = "skipped by user") {
  return withTx(async (c, afterCommit) => {
    await lockRun(c, runId);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [runId, stepKey]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (!["PENDING", "READY", "FAILED", "WAITING_INPUT", "WAITING_APPROVAL"].includes(s.status)) throw new EngineError(`cannot skip a ${s.status} step`);
    const aborted = await cancelStepJobs(c, s.id, reason);
    await q(c, "UPDATE workflow_questions SET status = 'dismissed' WHERE step_id = $1 AND status = 'open'", [s.id]);
    await setStepStatus(c, s, "SKIPPED", { output: { skipped: true, reason }, finished_at: new Date() }, reason);
    afterCommit(() => aborted.forEach((id) => localJobs.abort(id)));
    await advance(c, runId, afterCommit);
    return getRun(runId, c);
  });
}

// ---------------------------------------------------------------- human-in-the-loop

/**
 * Save answers. When a step has no open question left: a `human_input` step completes with the answers as
 * output; an agent step goes back to READY and its next attempt resumes from the persisted checkpoint.
 */
export async function answerQuestions(answers: Record<string, string>, answeredBy = "") {
  const ids = Object.entries(answers)
    .filter(([, a]) => String(a ?? "").trim())
    .map(([id]) => Number(id));
  if (!ids.length) throw new EngineError("no answers given", 400);
  const runIds = (await q<{ run_id: number }>(pool, "SELECT DISTINCT run_id FROM workflow_questions WHERE id = ANY($1) AND status = 'open' ORDER BY run_id", [ids])).map(
    (r) => r.run_id,
  );
  if (!runIds.length) throw new EngineError("no open questions match", 400);
  const resumed: string[] = [];
  let answered = 0;
  for (const runId of runIds) {
    await withTx(async (c, afterCommit) => {
      await lockRun(c, runId);
      const qs = await q(c, "SELECT * FROM workflow_questions WHERE run_id = $1 AND id = ANY($2) AND status = 'open' FOR UPDATE", [runId, ids]);
      for (const x of qs) {
        await q(c, "UPDATE workflow_questions SET status = 'answered', answer = $2, answered_by = $3, answered_at = now() WHERE id = $1", [
          x.id,
          String(answers[x.id]).trim(),
          answeredBy,
        ]);
        answered++;
      }
      for (const stepId of new Set(qs.map((x) => x.step_id as number))) {
        const s = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1", [stepId]))!;
        if (s.status !== "WAITING_INPUT") continue;
        // Answers to questions of an older attempt are recorded but never resume anything (no extra job).
        if (!qs.some((x) => x.step_id === stepId && x.attempt_id === s.current_attempt_id)) continue;
        const open = await one<{ n: number }>(c, "SELECT count(*)::int AS n FROM workflow_questions WHERE step_id = $1 AND status = 'open'", [stepId]);
        if (open!.n) continue;
        await q(c, "UPDATE workflow_step_attempts SET resolved_at = now() WHERE id = $1", [s.current_attempt_id]);
        if (s.type === "human_input") {
          const all = await q(c, "SELECT id, question, answer FROM workflow_questions WHERE step_id = $1 AND status = 'answered' AND attempt_id = $2 ORDER BY id", [
            stepId,
            s.current_attempt_id,
          ]);
          const output = { answers: all };
          await q(c, "UPDATE workflow_step_attempts SET status = 'COMPLETED', output = $2, finished_at = now() WHERE id = $1", [s.current_attempt_id, json(output)]);
          await setStepStatus(c, s, "COMPLETED", { output, finished_at: new Date() }, "answered");
        } else {
          const cp = await one(c, "SELECT data FROM workflow_checkpoints WHERE attempt_id = $1 ORDER BY id DESC LIMIT 1", [s.current_attempt_id]);
          // A step paused by failure recovery: "stop" ends it as FAILED; anything else runs it again.
          const stop = cp?.data?.failure && (await q<{ answer: string }>(c, "SELECT answer FROM workflow_questions WHERE attempt_id = $1 AND status = 'answered'", [s.current_attempt_id])).some((a) => /^\s*(dừng|stop)\b/i.test(a.answer));
          if (stop) {
            await setStepStatus(c, s, "FAILED", { error: `stopped by the developer after ${cp.data.failure.class} failure`, finished_at: new Date() }, "stopped after failure");
          } else {
            const pending = { ...(s.pending_input ?? {}), resume: { from_attempt_id: s.current_attempt_id, checkpoint: cp?.data ?? {} } };
            await setStepStatus(c, s, "READY", { pending_input: pending, ready_at: new Date() }, "answers received, resuming");
          }
        }
        resumed.push(`${runId}:${s.key}`);
      }
      await advance(c, runId, afterCommit);
    });
  }
  const stillOpen = (await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM workflow_questions WHERE run_id = ANY($1) AND status = 'open'", [runIds]))!.n;
  return { answered, resumed, stillOpen };
}

export async function approveStep(runId: number, stepKey: string, opts: { comment?: string; by?: string; repositories?: string[]; data?: unknown } = {}) {
  return withTx(async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [runId, stepKey]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (s.status !== "WAITING_APPROVAL") throw new EngineError(`step "${stepKey}" is ${s.status}, not WAITING_APPROVAL`);
    const decision = { granted: true, generation: s.generation, comment: opts.comment ?? "", by: opts.by ?? "", at: new Date(), ...(opts.data !== undefined ? { data: opts.data } : {}) };
    if (s.approval?.gate || s.type !== "human_approval") {
      // Gate before execution (requires_approval) or an executor asking for a go-ahead: run the step now.
      await setStepStatus(c, s, "READY", { approval: { ...(s.approval ?? {}), ...decision }, ready_at: new Date() }, "approved");
    } else {
      let repos: string[] | undefined;
      if (s.config.select_repositories) {
        repos = opts.repositories ?? s.approval?.request?.recommended ?? run.selected_repositories;
        if (!repos?.length) throw new EngineError("select at least one repository", 400);
        await setSelectedRepositories(c, run, repos);
      }
      // Branch to review (and to commit fixes on), entered with the repositories. Empty = review the base branch.
      const branch = typeof (opts.data as any)?.branch === "string" ? String((opts.data as any).branch).trim().replace(/^origin\//, "") : null;
      if (s.config.ask_branch && branch !== null) {
        if (branch) {
          try {
            normalizeBranchMap({ "*": branch }, config.baseBranch);
          } catch (e) {
            throw new EngineError((e as Error).message, 400);
          }
        }
        await q(c, "UPDATE workflow_runs SET inputs = coalesce(inputs, '{}'::jsonb) || jsonb_build_object('branch', $2::text), updated_at = now() WHERE id = $1", [runId, branch || null]);
      }
      const output = { approved: true, comment: decision.comment, by: decision.by, ...(repos ? { repositories: repos } : {}) };
      if (s.current_attempt_id)
        await q(c, "UPDATE workflow_step_attempts SET status = 'COMPLETED', output = $2, resolved_at = now(), finished_at = now() WHERE id = $1", [
          s.current_attempt_id,
          json(output),
        ]);
      await setStepStatus(c, s, "COMPLETED", { output, approval: { ...(s.approval ?? {}), ...decision }, finished_at: new Date() }, "approved");
    }
    if (opts.comment) await runEvents.add(c, runId, "user", `approved ${stepKey}: ${opts.comment}`, s.id);
    await advance(c, runId, afterCommit);
    return getRun(runId, c);
  });
}

export async function rejectStep(runId: number, stepKey: string, opts: { comment?: string; by?: string; reexecute?: string } = {}) {
  return withTx(async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [runId, stepKey]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (s.status !== "WAITING_APPROVAL") throw new EngineError(`step "${stepKey}" is ${s.status}, not WAITING_APPROVAL`);
    const comment = opts.comment ?? "";
    const target = opts.reexecute ?? s.config.on_reject?.reexecute;
    await runEvents.add(c, runId, "user", `rejected ${stepKey}${comment ? `: ${comment}` : ""}`, s.id);
    if (target) {
      if (!run.graph.steps.some((x) => x.key === target) || !downstream(run.graph.steps, target).has(stepKey))
        throw new EngineError(`"${target}" is not upstream of "${stepKey}"`, 400);
      // The approval step itself is downstream of the target, so it is reset and will ask again.
      await reexecuteTx(c, run, target, { feedback: `Reviewer rejected at "${s.name}": ${comment}` }, afterCommit, `re-executed after rejection of ${stepKey}`);
    } else {
      if (s.current_attempt_id)
        await q(c, "UPDATE workflow_step_attempts SET status = 'FAILED', error = $2, resolved_at = now(), finished_at = now() WHERE id = $1", [
          s.current_attempt_id,
          json({ message: `rejected: ${comment}` }),
        ]);
      await setStepStatus(c, s, "FAILED", { error: `rejected: ${comment}`, approval: { ...(s.approval ?? {}), granted: false, comment, by: opts.by ?? "", at: new Date() } }, "rejected");
      await advance(c, runId, afterCommit);
    }
    return getRun(runId, c);
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
    if (run.owner_id == null) {
      await q(c, "UPDATE workflow_jobs SET status = 'canceled', last_error = 'unassigned owner', updated_at = now() WHERE id = $1", [job.id]);
      return null;
    }
    const owner = await one<{ active: boolean }>(c, "SELECT active FROM users WHERE id = $1", [run.owner_id]);
    if (!owner?.active) {
      await q(c, "UPDATE workflow_jobs SET status = 'canceled', last_error = 'owner inactive', updated_at = now() WHERE id = $1", [job.id]);
      return null;
    }
    const j = await one<JobRow>(c, "SELECT * FROM workflow_jobs WHERE id = $1 FOR UPDATE", [job.id]);
    if (!j || j.status !== "running" || j.fencing_token !== job.fencing_token) return null;
    const step = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1 FOR UPDATE", [job.step_id]))!;
    const runnable = !["PAUSED", "CANCELED", "PENDING"].includes(run.status) || (run.status === "PAUSED" && (j as any).force === true);
    if (step.generation !== j.generation || !["READY", "RETRYING"].includes(step.status) || !runnable) {
      // Paused runs: hand the job back untouched; everything else is stale.
      if (run.status === "PAUSED" && step.generation === j.generation)
        await q(c, "UPDATE workflow_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1", [j.id]);
      else await q(c, "UPDATE workflow_jobs SET status = 'canceled', last_error = 'stale job', updated_at = now() WHERE id = $1", [j.id]);
      return null;
    }
    const { n } = (await one<{ n: number }>(c, "SELECT COALESCE(max(number), 0)::int + 1 AS n FROM workflow_step_attempts WHERE step_id = $1", [step.id]))!;
    const input = await buildStepInput(c, run, step);
    const context = await resolveContext(c, run, step, input);
    const attempt = (await one<AttemptRow>(
      c,
      `INSERT INTO workflow_step_attempts (step_id, run_id, number, generation, status, job_id, fencing_token, worker, input, context_snapshot_id)
       VALUES ($1, $2, $3, $4, 'RUNNING', $5, $6, $7, $8, $9) RETURNING *`,
      [step.id, run.id, n, step.generation, j.id, j.fencing_token, worker, json(input), context.snapshot_id],
    ))!;
    await setStepStatus(c, step, "RUNNING", { current_attempt_id: attempt.id, attempt_count: step.attempt_count + 1, started_at: new Date(), error: null }, `attempt #${n}`);
    return { run, step, attempt, input, context };
  });
}

/** Extend the lease iff we still hold the job. false = fenced out (canceled, re-executed, reaped). */
export async function heartbeat(jobId: number, token: number, leaseSeconds: number) {
  const r = await pool.query(
    `UPDATE workflow_jobs SET lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
      WHERE id = $1 AND fencing_token = $2 AND status = 'running'`,
    [jobId, token, leaseSeconds],
  );
  return r.rowCount === 1;
}

export async function insertQuestions(c: Db, step: StepRow, attemptId: number, qs: QuestionInput[]) {
  for (const x of qs)
    await q(c, "INSERT INTO workflow_questions (run_id, step_id, attempt_id, question, context, options, suggested_answer) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
      step.run_id,
      step.id,
      attemptId,
      x.question,
      x.context ?? "",
      json(x.options ?? []),
      x.suggested_answer ?? x.options?.[0] ?? null,
    ]);
}

async function applyResult(c: pg.PoolClient, run: RunRow, step: StepRow, attempt: AttemptRow, jobId: number | null, result: ExecResult, afterCommit: AfterCommit) {
  const now = new Date();
  const closeJob = (status: "done" | "failed", err: string | null = null) =>
    jobId ? q(c, "UPDATE workflow_jobs SET status = $2, last_error = $3, lease_expires_at = NULL, updated_at = now() WHERE id = $1", [jobId, status, err]) : null;
  const closeAttempt = (status: AttemptRow["status"], output: unknown, error: unknown = null) =>
    q(c, "UPDATE workflow_step_attempts SET status = $2, output = $3, error = $4, finished_at = now() WHERE id = $1", [attempt.id, status, json(output), json(error)]);

  switch (result.kind) {
    case "completed": {
      const out: any = result.output ?? {};
      if (Array.isArray(out?.selected_repositories)) await setSelectedRepositories(c, run, out.selected_repositories);
      await closeAttempt("COMPLETED", out);
      await setStepStatus(c, step, "COMPLETED", { output: out, pending_input: null, error: null, finished_at: now });
      await closeJob("done");
      break;
    }
    case "waiting_input": {
      if (result.questions?.length) await insertQuestions(c, step, attempt.id, result.questions);
      const open = (await one<{ n: number }>(c, "SELECT count(*)::int AS n FROM workflow_questions WHERE attempt_id = $1 AND status = 'open'", [attempt.id]))!.n;
      if (!open) return applyResult(c, run, step, attempt, jobId, { kind: "failed", error: "step requested input but asked no question", retryable: false }, afterCommit);
      await closeAttempt("WAITING_INPUT", result.output ?? null);
      await q(c, "INSERT INTO workflow_checkpoints (run_id, step_id, attempt_id, reason, data) VALUES ($1, $2, $3, 'waiting_input', $4)", [
        run.id,
        step.id,
        attempt.id,
        json(result.checkpoint ?? {}),
      ]);
      await setStepStatus(c, step, "WAITING_INPUT", {}, `${open} question(s)`);
      await closeJob("done");
      afterCommit(() => background(`notify run ${run.id}`, () => {
        const en = outputLocale(run) === "en";
        return notifyStepWaiting(en ? `❓ Run #${run.id} (${run.title}) – ${step.name} has ${open} question(s) to answer` : `❓ Run #${run.id} (${run.title}) – bước ${step.name} có ${open} câu hỏi cần trả lời`, {
          runId: run.id, runTitle: run.title, stepKey: step.key, stepName: step.name, status: "WAITING_INPUT",
          detail: (result.output as any)?.diagnosis?.summary
            ? `${(result.output as any).diagnosis.summary} — ${en ? "choose how to proceed" : "chọn cách xử lý"}`
            : (en ? `${open} question(s) to answer` : `${open} câu hỏi cần trả lời`),
          stepId: step.id, generation: step.generation, attemptId: attempt.id, locale: outputLocale(run), ownerId: run.owner_id ?? undefined,
        });
      }));
      break;
    }
    case "waiting_approval": {
      await closeAttempt("WAITING_APPROVAL", result.request);
      await q(c, "INSERT INTO workflow_checkpoints (run_id, step_id, attempt_id, reason, data) VALUES ($1, $2, $3, 'waiting_approval', $4)", [
        run.id,
        step.id,
        attempt.id,
        json(result.checkpoint ?? {}),
      ]);
      await setStepStatus(c, step, "WAITING_APPROVAL", { approval: { request: result.request, generation: step.generation, requested_at: now } });
      await closeJob("done");
      afterCommit(() => background(`notify run ${run.id}`, () => {
        const en = outputLocale(run) === "en";
        return notifyStepWaiting(en ? `✋ Run #${run.id} (${run.title}) – ${step.name} is waiting for approval` : `✋ Run #${run.id} (${run.title}) – bước ${step.name} chờ duyệt`, {
          runId: run.id, runTitle: run.title, stepKey: step.key, stepName: step.name, status: "WAITING_APPROVAL",
          detail: String((result.request as any)?.message ?? (step.type === "task_result_report" ? (en ? "review the task result report" : "xem lại báo cáo kết quả task") : (en ? "waiting for approval" : "chờ duyệt"))).slice(0, 300),
          stepId: step.id, generation: step.generation, attemptId: attempt.id, locale: outputLocale(run), ownerId: run.owner_id ?? undefined,
        });
      }));
      break;
    }
    case "reexecute": {
      // Close this attempt first (it decided), then re-execute the target: this step is downstream and becomes PENDING.
      await closeAttempt("COMPLETED", result.output ?? { reexecute: result.target });
      await closeJob("done");
      await reexecuteTx(c, run, result.target, { feedback: result.feedback }, afterCommit, `re-executed by ${step.key} (developer decision after test failure)`);
      return;
    }
    case "failed": {
      const decision = classifyFailure(result.error, { executorRetryable: result.retryable, attempt: step.attempt_count, maxAttempts: step.max_attempts, baseBackoff: step.retry_backoff_s });
      await closeAttempt("FAILED", null, { message: result.error, details: result.details ?? null, failure: decision });
      if (decision.action === "human") {
        // Pause instead of failing: the developer resolves the cause and answers; the step then runs again.
        const en = outputLocale(run) === "en";
        await insertQuestions(c, step, attempt.id, [
          {
            question: en
              ? `Step "${step.name}" needs you (${decision.class}): ${result.error.slice(0, 600)}`
              : `Bước "${step.name}" cần bạn xử lý (${decision.class}): ${result.error.slice(0, 600)}`,
            context: decision.reason,
            options: en ? ["Rerun this step", "Stop here"] : ["Đã xử lý xong — chạy lại bước", "Dừng ở đây"],
          },
        ]);
        await q(c, "INSERT INTO workflow_checkpoints (run_id, step_id, attempt_id, reason, data) VALUES ($1, $2, $3, 'waiting_input', $4)", [run.id, step.id, attempt.id, json({ failure: decision })]);
        await setStepStatus(c, step, "WAITING_INPUT", {}, `paused: ${decision.class}`);
        await closeJob("done", result.error);
        afterCommit(() =>
          background(`notify run ${run.id}`, () =>
            notifyStepWaiting(en ? `⏸ Run #${run.id} (${run.title}) – ${step.name} is paused: ${decision.class}` : `⏸ Run #${run.id} (${run.title}) – bước ${step.name} tạm dừng: ${decision.class}`, {
              runId: run.id, runTitle: run.title, stepKey: step.key, stepName: step.name, status: "WAITING_INPUT",
              detail: decision.reason, stepId: step.id, generation: step.generation, attemptId: attempt.id, locale: outputLocale(run), ownerId: run.owner_id ?? undefined,
            }),
          ),
        );
        break;
      }
      if (decision.action === "retry") {
        await setStepStatus(c, step, "RETRYING", { error: result.error }, `attempt ${step.attempt_count}/${step.max_attempts} failed (${decision.class}); retry in ${decision.delay_s}s`);
        await closeJob("done", result.error);
        await ensureJob(c, step, decision.delay_s);
      } else {
        await setStepStatus(c, step, "FAILED", { error: result.error, finished_at: now });
        await closeJob("failed", result.error);
        afterCommit(() => background(`notify run ${run.id}`, () => notify(`❌ Run #${run.id} (${run.title}) – bước ${step.name} lỗi: ${result.error.slice(0, 300)}`, `/runs/${run.id}`)));
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
export async function finishAttempt(jobId: number, token: number, attemptId: number, result: ExecResult) {
  return withTx(async (c, afterCommit) => {
    const attempt0 = await one<AttemptRow>(c, "SELECT run_id FROM workflow_step_attempts WHERE id = $1", [attemptId]);
    if (!attempt0) return { applied: false, reason: "attempt not found" };
    const run = await lockRun(c, attempt0.run_id);
    const j = await one<JobRow>(c, "SELECT * FROM workflow_jobs WHERE id = $1 FOR UPDATE", [jobId]);
    const attempt = (await one<AttemptRow>(c, "SELECT * FROM workflow_step_attempts WHERE id = $1 FOR UPDATE", [attemptId]))!;
    if (attempt.status !== "RUNNING") return { applied: false, reason: `attempt already ${attempt.status}` };
    const step = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1 FOR UPDATE", [attempt.step_id]))!;
    const fenced = !j || j.status !== "running" || j.fencing_token !== token;
    const stale = step.current_attempt_id !== attempt.id || step.generation !== attempt.generation || step.status !== "RUNNING";
    if (fenced || stale) {
      const reason = fenced ? "lease lost (fenced out)" : "step was invalidated while running";
      await q(c, "UPDATE workflow_step_attempts SET status = 'STALE', output = $2, error = $3, finished_at = now() WHERE id = $1", [
        attempt.id,
        json(result.kind === "completed" ? result.output : null),
        json({ message: reason }),
      ]);
      await runEvents.add(c, run.id, "system", `${step.key}: attempt #${attempt.number} result discarded: ${reason}`, step.id, attempt.id);
      return { applied: false, reason };
    }
    await applyResult(c, run, step, attempt, jobId, result, afterCommit);
    return { applied: true };
  });
}

/**
 * Graceful shutdown: hand a job this worker is executing back to the queue instead of failing it. The attempt is
 * marked STALE (interrupted) and does NOT count against the step's retry budget; any worker may pick the job up again.
 * Returns false when the job is no longer ours (fenced out, canceled, re-executed): then nothing is changed.
 */
export async function releaseAttempt(jobId: number, token: number, attemptId: number, reason: string) {
  return withTx(async (c) => {
    const attempt0 = await one<AttemptRow>(c, "SELECT run_id FROM workflow_step_attempts WHERE id = $1", [attemptId]);
    if (!attempt0) return false;
    const run = await lockRun(c, attempt0.run_id);
    const j = await one<JobRow>(c, "SELECT * FROM workflow_jobs WHERE id = $1 FOR UPDATE", [jobId]);
    const attempt = (await one<AttemptRow>(c, "SELECT * FROM workflow_step_attempts WHERE id = $1 FOR UPDATE", [attemptId]))!;
    if (attempt.status !== "RUNNING" || !j || j.status !== "running" || j.fencing_token !== token) return false;
    const step = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1 FOR UPDATE", [attempt.step_id]))!;
    await q(c, "UPDATE workflow_step_attempts SET status = 'STALE', error = $2, finished_at = now() WHERE id = $1", [attempt.id, json({ message: reason, interrupted: true })]);
    if (step.current_attempt_id !== attempt.id || step.generation !== attempt.generation || step.status !== "RUNNING") return false;
    await setStepStatus(c, step, "READY", { attempt_count: Math.max(0, step.attempt_count - 1), error: null }, `attempt #${attempt.number} interrupted: ${reason}; requeued (not counted as a retry)`);
    await q(
      c,
      `UPDATE workflow_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, fencing_token = fencing_token + 1,
              available_at = now(), last_error = $2, updated_at = now() WHERE id = $1`,
      [j.id, `interrupted: ${reason}`],
    );
    await runEvents.add(c, run.id, "system", `${step.key}: attempt #${attempt.number} interrupted (${reason}); the step is queued again without using a retry`, step.id, attempt.id);
    return true;
  });
}

/**
 * Pin a run to the platform instance (machine) acting on it, so only that machine's workers execute its steps: the
 * repositories, worktrees and agent login live on that machine. Called when a user (re)starts work on a run.
 */
async function adoptRun(c: Db, runId: number) {
  await q(c, "UPDATE workflow_runs SET worker_instance = $2 WHERE id = $1 AND worker_instance IS DISTINCT FROM $2", [runId, config.instanceId]);
}

/**
 * Recover from crashed workers: jobs whose lease expired are either handed back (no attempt started yet) or
 * their attempt is failed with "worker lease expired" and the normal retry policy applies.
 */
export async function reapExpiredLeases() {
  const expired = await q<JobRow>(pool, "SELECT * FROM workflow_jobs WHERE status = 'running' AND lease_expires_at < now() ORDER BY id LIMIT 50");
  let reaped = 0;
  for (const job of expired) {
    await withTx(async (c, afterCommit) => {
      const run = await lockRun(c, job.run_id);
      const j = await one<JobRow>(c, "SELECT * FROM workflow_jobs WHERE id = $1 AND status = 'running' AND lease_expires_at < now() FOR UPDATE", [job.id]);
      if (!j) return;
      reaped++;
      await q(c, "UPDATE workflow_jobs SET fencing_token = fencing_token + 1, updated_at = now() WHERE id = $1", [j.id]);
      const attempt = await one<AttemptRow>(c, "SELECT * FROM workflow_step_attempts WHERE job_id = $1 AND status = 'RUNNING' FOR UPDATE", [j.id]);
      const step = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1 FOR UPDATE", [j.step_id]))!;
      if (!attempt || step.current_attempt_id !== attempt.id) {
        if (attempt) await q(c, "UPDATE workflow_step_attempts SET status = 'STALE', finished_at = now() WHERE id = $1", [attempt.id]);
        // Claimed but never started (or already superseded): hand the job back.
        await q(c, "UPDATE workflow_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, last_error = 'lease expired before start' WHERE id = $1", [j.id]);
        return;
      }
      await runEvents.add(c, run.id, "system", `${step.key}: worker ${j.lease_owner} lost its lease; attempt #${attempt.number} failed`, step.id, attempt.id);
      await applyResult(c, run, step, attempt, j.id, { kind: "failed", error: `worker lease expired (${j.lease_owner})`, retryable: true }, afterCommit);
    });
  }
  return reaped;
}

// ---------------------------------------------------------------- queries

export async function getRun(runId: number, db: Db = pool) {
  const run = await one<RunRow>(db, "SELECT * FROM workflow_runs WHERE id = $1", [runId]);
  if (!run) throw new EngineError(`run ${runId} not found`, 404);
  const steps = await stepsOf(db, runId);
  return { ...run, steps };
}

export function listRuns(filter: { workItemId?: number; status?: string; limit?: number; ownerId?: number; all?: boolean } = {}, db: Db = pool) {
  const scope = filter.all ? "AND r.owner_id IS NOT NULL" : filter.ownerId ? "AND r.owner_id = " + Number(filter.ownerId) : "";
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

export async function runDetail(runId: number) {
  const run = await getRun(runId);
  const [attempts, questions, artifacts, prs, workspaces, checkpoints] = await Promise.all([
    q(pool, "SELECT a.*, s.key AS step_key FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE a.run_id = $1 ORDER BY a.id", [runId]),
    q(pool, "SELECT q.*, s.key AS step_key FROM workflow_questions q JOIN workflow_steps s ON s.id = q.step_id WHERE q.run_id = $1 ORDER BY q.id", [runId]),
    q(pool, "SELECT id, step_id, attempt_id, kind, name, length(content) AS size, data, created_at FROM workflow_artifacts WHERE run_id = $1 ORDER BY id", [runId]),
    q(pool, "SELECT * FROM pull_requests WHERE run_id = $1 ORDER BY id", [runId]),
    q(pool, "SELECT * FROM execution_workspaces WHERE run_id = $1 ORDER BY id", [runId]),
    q(pool, "SELECT id, step_id, attempt_id, reason, data, created_at FROM workflow_checkpoints WHERE run_id = $1 ORDER BY id", [runId]),
  ]);
  const workItem = run.work_item_id ? await one(pool, "SELECT id, code, title, source, project FROM work_items WHERE id = $1", [run.work_item_id]) : null;
  const def = await one(pool, "SELECT version FROM workflow_definition_versions WHERE id = $1", [run.definition_version_id]);
  return { ...run, definition_version: def?.version, work_item: workItem, attempts, questions, artifacts, pull_requests: prs, workspaces, checkpoints };
}

/** Everything the step inspector shows for one step. */
export async function stepDetail(runId: number, stepKey: string) {
  const step = await one<StepRow>(pool, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [runId, stepKey]);
  if (!step) throw new EngineError(`step "${stepKey}" not found`, 404);
  const [attempts, questions, checkpoints, artifacts, sessions, snapshots, jobs] = await Promise.all([
    q(pool, "SELECT * FROM workflow_step_attempts WHERE step_id = $1 ORDER BY number", [step.id]),
    q(pool, "SELECT * FROM workflow_questions WHERE step_id = $1 ORDER BY id", [step.id]),
    q(pool, "SELECT * FROM workflow_checkpoints WHERE step_id = $1 ORDER BY id", [step.id]),
    q(pool, "SELECT id, attempt_id, kind, name, length(content) AS size, data, created_at FROM workflow_artifacts WHERE step_id = $1 ORDER BY id", [step.id]),
    q(pool, "SELECT s.* FROM agent_sessions s JOIN workflow_step_attempts a ON a.id = s.attempt_id WHERE a.step_id = $1 ORDER BY s.id", [step.id]),
    q(pool, "SELECT id, hash, content, created_at FROM context_snapshots WHERE step_id = $1 ORDER BY id", [step.id]),
    q(pool, "SELECT id, status, generation, available_at, lease_owner, lease_expires_at, claims, force, last_error FROM workflow_jobs WHERE step_id = $1 ORDER BY id DESC LIMIT 10", [step.id]),
  ]);
  return { step, attempts, questions, checkpoints, artifacts, sessions, snapshots, jobs };
}

export function openQuestions(db: Db = pool, scope?: { ownerId?: number; all?: boolean }) {
  const extra = !scope ? "" : scope.all ? "AND r.owner_id IS NOT NULL" : "AND r.owner_id = " + Number(scope.ownerId);
  return q(
    db,
    `SELECT q.*, s.key AS step_key, s.name AS step_name, s.type AS step_type, r.title AS run_title, r.status AS run_status, w.code AS work_item_code
       FROM workflow_questions q JOIN workflow_steps s ON s.id = q.step_id JOIN workflow_runs r ON r.id = q.run_id
       LEFT JOIN work_items w ON w.id = r.work_item_id
      WHERE q.status = 'open' ${extra} ORDER BY q.created_at`,
  );
}

export function answeredQuestions(limit = 100, db: Db = pool, scope?: { ownerId?: number; all?: boolean }) {
  const extra = !scope ? "" : scope.all ? "AND r.owner_id IS NOT NULL" : "AND r.owner_id = " + Number(scope.ownerId);
  return q(
    db,
    `SELECT q.*, s.key AS step_key, s.name AS step_name, s.status AS step_status, r.title AS run_title
       FROM workflow_questions q JOIN workflow_steps s ON s.id = q.step_id JOIN workflow_runs r ON r.id = q.run_id
      WHERE q.status = 'answered' ${extra} ORDER BY q.answered_at DESC LIMIT $1`,
    [limit],
  );
}
