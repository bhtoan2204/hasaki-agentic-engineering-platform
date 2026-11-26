import {
  continuationEvidence,
  readExecutionCheckpoint,
  saveExecutionPause,
} from "../checkpoints.ts";
import type { Untyped } from "../../untyped.ts";
import { stepsOf } from "../runRepository.ts";
import { advance } from "../progression.ts";
import { EngineError, lockRun, setStepStatus, ensureJob, type AfterCommit } from "../mutations.ts";
import { z } from "zod";
import { execution } from "../../auth/execution.ts";
import {
  buildHandoffPackage,
  providerFailure,
  PAUSABLE_FAILURES,
  AUTOMATIC_FAILURES,
  handoffReadiness,
  handoffBlockReason,
  inspectHandoffWorkspace,
} from "../../agent/handoff.ts";
import {
  nextHealthyProvider,
  invalidateSharedAgentHealth,
  probeAgentHealth,
  rememberProviderQuota,
} from "../../agent/health.ts";
import { providerCapabilities } from "../../agent/providerCapabilities.ts";
import {
  fallbackPolicy,
  resolveStepAgent,
  StepAgentOverrideConfig,
} from "../../agent/stepAgent.ts";
import { safeDiagnostics } from "../../agent/telemetry.ts";
import type pg from "pg";
import { config } from "../../config.ts";
import { ownsInstance } from "../../instances.ts";
import { providerEnabled, type AgentProvider } from "../../agent/provider.ts";
import { pool, q, one, withTx, json } from "../../db/pool.ts";
import { classifyFailure } from "../failures.ts";
import { localJobs } from "../local.ts";
import { runEvents } from "../events.ts";
import type { AttemptRow, ExecResult, JobRow, RunRow, StepRow } from "../types.ts";
import { recordDecision } from "../decisions.ts";
import { evaluateGate } from "../autonomy.ts";
import { frozenProviderFlags } from "./shared.ts";
import { type BegunAttempt, type PreparedHandoff } from "./types.ts";

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

export async function persistProviderPause(
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
    const ctx: ResumeContext = {
      c,
      runId,
      input,
      locked,
      s,
      h,
      automatic,
      actorId,
      afterCommit,
      ready,
      candidate,
    };
    await assertExecutorStopped(ctx);
    await assertHandoffAuthorized(ctx);
    const { policy, history, switchBudgetWarning, healthFailover } =
      await resolveFallbackPolicy(ctx);
    if (automatic) await assertAutomaticResume(ctx, policy, history, healthFailover);
    const override = await assertAgentUnchanged(ctx);
    await confirmHandoff(ctx, override, switchBudgetWarning);
    return {
      handoff: { ...h, status: "RESUMED", target_provider: input.provider },
      duplicate: false,
      warning: switchBudgetWarning,
    };
  });
}

interface ResumeContext {
  c: pg.PoolClient;
  runId: number;
  input: z.infer<typeof ResumeHandoff>;
  locked: RunRow;
  s: StepRow;
  h: Untyped;
  automatic: boolean;
  actorId: number | null;
  afterCommit: AfterCommit;
  ready: Awaited<ReturnType<typeof handoffReadiness>>;
  candidate: ReturnType<typeof resolveStepAgent>;
}

/** The failed attempt's executor has stopped and nothing else of this run is running. */
async function assertExecutorStopped(x: ResumeContext) {
  const { c, runId, locked, s, h } = x;
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
}

/** Workspace, approval, repository scope and delegation checks for the target provider (reads the workspace under the run's scope). */
async function assertHandoffAuthorized(x: ResumeContext) {
  const { c, input, locked, s, h } = x;
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
    ...new Set([...locked.selected_repositories, ...workspace.workspaces.map((w) => w.repository)]),
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
  if (!providerCapabilities(input.provider).guarantees.delegation && s.config.delegation?.enabled)
    throw new EngineError(
      "Target provider cannot enforce the approved delegation sandbox policy",
      409,
    );
}

/** Workflow fallback policy, switch budget and health-failover facts for this confirmation. */
async function resolveFallbackPolicy(x: ResumeContext): Promise<{
  policy: ReturnType<typeof fallbackPolicy>;
  history: Untyped[];
  switchBudgetWarning: string | null;
  healthFailover: boolean;
}> {
  const { c, input, s, h, automatic } = x;
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
  return { policy, history, switchBudgetWarning, healthFailover };
}

/** Automatic failover only: loop, cost, budget and token guards. */
async function assertAutomaticResume(
  x: ResumeContext,
  policy: ReturnType<typeof fallbackPolicy>,
  history: Untyped[],
  healthFailover: boolean,
) {
  const { c, input, s, h, ready } = x;
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

/** Settings may have changed while readiness was probed; open human questions block the confirmation. */
async function assertAgentUnchanged(x: ResumeContext): Promise<object> {
  const { c, input, locked, s, candidate } = x;
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
  return override;
}

/** The writes of a confirmed handoff: resolve the source attempt, mark RESUMED, record the decision, ready the step, enqueue, audit and advance. */
async function confirmHandoff(
  x: ResumeContext,
  override: object,
  switchBudgetWarning: string | null,
) {
  const { c, runId, input, s, h, automatic, actorId, afterCommit } = x;
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
  const { agentProviderStatus } = await import("../../agent/providerStatus.ts");
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
