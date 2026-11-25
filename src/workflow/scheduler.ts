import {
  attachWorkspace,
  findReplayResult,
  fingerprintExecution,
  replayOutputHash,
  safeReplayOutput,
} from "./replay.ts";
import { executionWorkspace, inspectHandoffWorkspace } from "../git/workspaceCheckpoint.ts";
import type { WorkspaceCheckpoint } from "./checkpoints.ts";
import { recordExecutorReturn } from "./checkpoints.ts";
import { purgeDebugEvents, TRACE_LIMITS, traceLog } from "./trace.ts";
import { releaseAttempt } from "./recovery.ts";
import { runIndexOnce } from "../codeIntelligence/indexer.ts";
import { randomUUID } from "node:crypto";
import { instanceSession } from "../instances.ts";
import { config } from "../config.ts";
import { loadPersonalIntegrations } from "../integrations/loadPersonal.ts";
import { execution } from "../auth/execution.ts";
import { onCommittedWrite, pool, one, q, retryTransient } from "../db/pool.ts";
import { JOBS_RUNNABLE } from "./mutations.ts";
import { count, observe, registerGauge } from "../runtimeMetrics.ts";
import { purgeVerificationEvidence } from "../agent/verifyEvidence.ts";
import {
  beginAttempt,
  continueHealthyHandoffForAttempt,
  finishAttempt,
  heartbeat,
  prepareProviderPause,
  previewJob,
  reapExpiredLeases,
  processAutomaticHandoff,
} from "./engine.ts";
import { dispatchRunEffects } from "./effects.ts";
import { getExecutor, makeContext } from "./executors/registry.ts";
import { enforceRunRepositoryAccess } from "../repos/access.ts";
import { repositories, repoPath } from "../repos/service.ts";
import { localJobs } from "./local.ts";
import { deferIfBranchBusy } from "./branchLeases.ts";
import { settleBackground } from "./background.ts";
import type { ExecResult, ExecutionFingerprint, JobRow } from "./types.ts";
import { noteDecision } from "./decisions.ts";
import { log, logError } from "../logging.ts";
import { ignoreError } from "../ignoreError.ts";

/**
 * WorkflowScheduler: PostgreSQL-backed job claiming. No in-memory queue: any number of processes can run
 * workers against the same database; `FOR UPDATE SKIP LOCKED` hands each job to exactly one of them and the
 * fencing token protects against a worker that lost its lease but keeps running.
 */

export interface SchedulerOptions {
  workers: number;
  /** Extra workers that only take short step types, so a long test/agent run never blocks approvals or discovery. */
  lightWorkers?: number;
  leaseSeconds: number;
  heartbeatSeconds: number;
  pollMs: number;
}

// Starts with the instance id: the database (migration 019) only lets the run's own instance take its jobs.
const processId = `${config.instanceId}:${process.pid}:${randomUUID().slice(0, 8)}`;
/** Lease owner as stored: always `<instance>:...`, also for ad-hoc worker ids (tests, CLI). */
const leaseOwner = (workerId: string) =>
  workerId.startsWith(`${config.instanceId}:`) ? workerId : `${config.instanceId}:${workerId}`;

/** Set while the server shuts down: interrupted jobs are handed back to the queue instead of being failed. */
let draining: string | null = null;

/** Step types that finish in seconds (no long agent session or command). */
export const LIGHT_STEP_TYPES = [
  "human_input",
  "human_approval",
  "condition",
  "integration",
  "git_pull_request",
];

let lastTracePurge = 0;

/**
 * DEBUG trace logs expire after `TRACE_DEBUG_RETENTION_DAYS` (default 7) and verification evidence after
 * `VERIFICATION_EVIDENCE_RETENTION_DAYS` (default 30); checked at most once an hour.
 */
export async function purgeDebugEventsThrottled(now = Date.now()) {
  if (now - lastTracePurge < 3_600_000) return 0;
  lastTracePurge = now;
  const days = Number(process.env.TRACE_DEBUG_RETENTION_DAYS);
  const evidenceDays = Number(process.env.VERIFICATION_EVIDENCE_RETENTION_DAYS);
  await purgeVerificationEvidence(
    Number.isFinite(evidenceDays) && evidenceDays > 0 ? evidenceDays : 30,
    pool,
  ).catch((e) => log.error("verification evidence retention:", e.message));
  return purgeDebugEvents(
    Number.isFinite(days) && days > 0 ? days : TRACE_LIMITS.debugRetentionDays,
  );
}

const reconcileTasks: Array<() => Promise<unknown>> = [];
/**
 * Extra periodic work run on the scheduler's existing reconcile tick (no new timer). Each task is single-flight: a tick
 * that finds the previous call still running skips it.
 */
export function registerReconcileTask(name: string, task: () => Promise<unknown>) {
  let running: Promise<unknown> | null = null;
  reconcileTasks.push(() => {
    if (running) return Promise.resolve();
    running = Promise.resolve()
      .then(task)
      .catch((error) => {
        logError("scheduler.reconcile_failed", "Reconcile task failed", error, { task: name });
      })
      .finally(() => (running = null));
    return running;
  });
}

/**
 * Idle workers sleep up to `pollMs`, and wake early when this process commits a job that may be claimable
 * (JOBS_RUNNABLE): a step finishing on the light lane, the first job of a new run or a sibling branch no longer waits
 * for the next poll. One idle worker of each lane kind wakes per signal; a worker that claims a job wakes the next idle
 * one of its kind (parallel branches fan out), one that finds nothing goes back to sleep. The poll remains the fallback
 * for other instances' writes.
 */
type LaneKind = "general" | "light";
const idleWorkers: Record<LaneKind, Array<() => void>> = { general: [], light: [] };
const wakeIdle = (kinds: LaneKind[] = ["general", "light"]) => {
  for (const kind of kinds) {
    const wake = idleWorkers[kind].shift();
    if (wake) {
      count("scheduler.wakes");
      wake();
    }
  }
};
let busyWorkers = 0;
registerGauge("scheduler.busy_workers", () => busyWorkers);
registerGauge(
  "scheduler.idle_workers",
  () => idleWorkers.general.length + idleWorkers.light.length,
);
const wakeAllIdle = () => {
  for (const kind of ["general", "light"] as const)
    for (const wake of idleWorkers[kind].splice(0)) wake();
};
/** Signals so far: a worker that saw a signal arrive after its claim began does not sleep (no lost wake-up). */
let runnableSignals = 0;
onCommittedWrite((tables) => {
  if (!tables.has(JOBS_RUNNABLE)) return;
  runnableSignals++;
  wakeIdle();
});
function idleWait(kind: LaneKind, ms: number, seen: number) {
  if (runnableSignals !== seen) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      const list = idleWorkers[kind];
      const at = list.indexOf(wake);
      if (at >= 0) list.splice(at, 1);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    idleWorkers[kind].push(wake);
  });
}

let automaticHandoff: Promise<void> | null = null;

/**
 * Scan at most one due automatic handoff. Concurrent callers share the scan already in flight.
 * A caller that arrives after it settles scans again; durable handoff state is not cached.
 */
export function reconcileAutomaticHandoff(): Promise<void> {
  if (automaticHandoff) return automaticHandoff;
  const run = processAutomaticHandoff()
    .catch((error) => {
      logError(
        "scheduler.automatic_handoff_failed",
        "Automatic handoff reconciliation failed",
        error,
      );
      throw error;
    })
    .finally(() => {
      if (automaticHandoff === run) automaticHandoff = null;
    });
  automaticHandoff = run;
  return run;
}

/** `onlyTypes`: restrict the claim to these step types (light lane). */
export async function claimJob(
  workerId: string,
  leaseSeconds: number,
  onlyTypes?: string[],
): Promise<JobRow | undefined> {
  const job = await one<JobRow>(
    pool,
    `UPDATE workflow_jobs j
        SET status = 'running', lease_owner = $1, lease_expires_at = now() + make_interval(secs => $2),
            fencing_token = j.fencing_token + 1, claims = j.claims + 1, updated_at = now()
      WHERE j.id = (
        SELECT j2.id FROM workflow_jobs j2 JOIN workflow_runs r ON r.id = j2.run_id JOIN workflow_steps s ON s.id = j2.step_id
         WHERE j2.status = 'queued' AND j2.available_at <= now()
           AND (r.status NOT IN ('PAUSED', 'CANCELED', 'PENDING') OR (r.status = 'PAUSED' AND j2.force))
           AND ($3::text[] IS NULL OR s.type = ANY($3))
           AND r.worker_instance = $4
           AND NOT EXISTS (SELECT 1 FROM platform_instances i WHERE i.instance_id = $4 AND (i.session_id <> $5 OR i.stopped_at IS NOT NULL))
         ORDER BY j2.available_at, j2.id
         FOR UPDATE OF j2 SKIP LOCKED LIMIT 1)
      RETURNING j.*`,
    [leaseOwner(workerId), leaseSeconds, onlyTypes ?? null, config.instanceId, instanceSession],
  );
  if (job) {
    count("scheduler.claims");
    if (job.available_at)
      observe(
        "scheduler.queue_wait_ms",
        Math.max(0, Date.now() - new Date(job.available_at).getTime()),
      );
  } else count("scheduler.claims_empty");
  // Fire-and-forget: tracing must never delay or fail a claim.
  if (job)
    void traceLog({
      runId: job.run_id,
      stepId: job.step_id,
      level: "DEBUG",
      event: "job.claimed",
      message: `job ${job.id} claimed by ${workerId}`,
      data: {
        job_id: job.id,
        fencing_token: job.fencing_token,
        claims: job.claims,
        lease_seconds: leaseSeconds,
      },
    });
  return job;
}

/** What the workers are doing right now (for "why is my step waiting?" in the UI). */
export async function schedulerStatus() {
  const running = await q(
    pool,
    `SELECT j.id AS job_id, j.run_id, r.title AS run_title, s.key AS step_key, s.name AS step_name, s.type AS step_type, j.lease_owner,
            a.started_at, extract(epoch FROM now() - a.started_at)::int AS running_seconds
       FROM workflow_jobs j JOIN workflow_steps s ON s.id = j.step_id JOIN workflow_runs r ON r.id = j.run_id
       LEFT JOIN workflow_step_attempts a ON a.job_id = j.id AND a.status = 'RUNNING'
      WHERE j.status = 'running' ORDER BY j.id`,
  );
  const queued = await q(
    pool,
    `SELECT j.id AS job_id, j.run_id, s.key AS step_key, s.type AS step_type, j.available_at, r.worker_instance
       FROM workflow_jobs j JOIN workflow_steps s ON s.id = j.step_id JOIN workflow_runs r ON r.id = j.run_id
      WHERE j.status = 'queued' AND r.status NOT IN ('PAUSED', 'CANCELED', 'PENDING') ORDER BY j.available_at, j.id`,
  );
  return {
    instance: config.instanceId,
    workers: config.scheduler.workers,
    light_workers: config.scheduler.lightWorkers ?? 1,
    light_step_types: LIGHT_STEP_TYPES,
    running,
    queued,
  };
}

/** Execute one claimed job end to end. */
export async function processJob(
  job: JobRow,
  workerId: string,
  opts: Pick<SchedulerOptions, "leaseSeconds" | "heartbeatSeconds">,
) {
  busyWorkers++;
  const started = performance.now();
  try {
    await runJob(job, workerId, opts);
  } finally {
    busyWorkers--;
    observe("workflow.attempt_ms", performance.now() - started);
  }
}

async function runJob(
  job: JobRow,
  workerId: string,
  opts: Pick<SchedulerOptions, "leaseSeconds" | "heartbeatSeconds">,
) {
  const preview = await previewJob(job.id);
  if (preview && (await deferIfBranchBusy(job, preview.type))) return;
  const begun = await beginAttempt(job, workerId, preview ?? null);
  if (!begun) return;
  const attemptTrace = {
    runId: job.run_id,
    stepId: job.step_id,
    attemptId: begun.attempt.id,
  };
  const startedAt = Date.now();
  void traceLog({
    ...attemptTrace,
    level: "INFO",
    event: "attempt.started",
    status: "RUNNING",
    message: `attempt ${begun.attempt.id} started by ${workerId}`,
    data: { job_id: job.id, fencing_token: job.fencing_token, step_type: begun.step.type },
  });
  const ac = new AbortController();
  localJobs.register(job.id, ac);
  const hb = setInterval(async () => {
    try {
      if (!(await heartbeat(job.id, job.fencing_token, opts.leaseSeconds, begun.attempt.id)))
        ac.abort();
    } catch (e) {
      ac.abort();
      logError("scheduler.heartbeat_failed", "Job heartbeat failed", e, {
        job_id: job.id,
        run_id: job.run_id,
        step_id: job.step_id,
        attempt_id: begun.attempt.id,
        worker_id: workerId,
      });
    }
  }, opts.heartbeatSeconds * 1000);
  const executionAbort = new AbortController();
  const forwardAbort = () => executionAbort.abort();
  ac.signal.addEventListener("abort", forwardAbort, { once: true });
  const timeoutMs = begun.attempt.effective_agent?.timeout_ms;
  let timedOut = false;
  const deadline = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        executionAbort.abort();
      }, timeoutMs)
    : null;
  let result: ExecResult;
  let executorEntered = false;
  let fingerprint: ExecutionFingerprint | undefined;
  let reusedFrom: number | undefined;
  let replayLatencyMs: number | undefined;
  try {
    const ownerId = Number(begun.run.owner_id);
    // Revalidate the owner's repository access before any protected content is touched (revocation, retries,
    // resume and re-execution all pass through here). A revoked selected repository stops the step safely.
    const scope = await execution.run({ userId: ownerId, runId: begun.run.id, kind: "run" }, () =>
      enforceRunRepositoryAccess(begun.run),
    );
    if (scope.blocked.length) {
      result = {
        kind: "failed",
        error: `Repository access revoked for the run owner: ${scope.blocked.join(", ")}. Ask an admin to restore access, then retry the step.`,
        retryable: false,
        details: { code: "repository_access_revoked", repositories: scope.blocked },
      };
    } else {
      if (scope.changed) {
        // The step input and context were assembled before the check: give the attempt the scope it now has.
        begun.input.run.allowed_repositories = begun.run.allowed_repositories;
        if (begun.context.repoPaths && !begun.run.selected_repositories.length) {
          const scopeNames = new Set(begun.run.allowed_repositories);
          begun.context.repoPaths = (await repositories.list())
            .filter((r) => scopeNames.has(r.name))
            .map((r) => ({ name: r.name, path: repoPath(r) }));
        }
      }
      const ctx = makeContext({ ...begun, signal: executionAbort.signal });
      result = await execution.run(
        { userId: ownerId, runId: begun.run.id, kind: "run" },
        async () => {
          await loadPersonalIntegrations();
          const prior = begun.input.pending?.resume?.checkpoint?.execution;
          const handoff = begun.input.pending?.provider_handoff;
          const expected =
            handoff?.workspace_fingerprint ??
            (prior?.workspace_reconciliation_required ? prior.workspace_fingerprint : undefined);
          if (expected) {
            let fingerprint: string | undefined;
            try {
              fingerprint = handoff?.workspace_fingerprint
                ? (await inspectHandoffWorkspace(begun.run.id)).fingerprint
                : (await executionWorkspace(begun.run, begun.step))?.fingerprint;
            } catch {
              // A missing, moved or unreadable checkout requires the same reconciliation as changed bytes.
            }
            if (fingerprint !== expected) {
              const artifactId =
                prior?.workspace_artifact_id ??
                handoff?.package?.execution_checkpoint?.workspace_artifact_id ??
                handoff?.package?.workspace_artifact_id;
              await noteDecision({
                runId: begun.run.id,
                stepId: begun.step.id,
                attemptId: begun.attempt.id,
                generation: begun.attempt.generation,
                kind: "reconcile",
                action: "RECONCILE",
                outcome: "applied",
                reason: fingerprint
                  ? "workspace differs from the execution checkpoint"
                  : "workspace could not be inspected",
                details: {
                  source: handoff ? "provider_handoff" : "execution_checkpoint",
                  workspace_artifact_id: artifactId ?? null,
                },
              });
              return {
                kind: "waiting_input" as const,
                checkpoint: { workspace_recovery: { artifact_id: artifactId ?? null } },
                questions: [
                  {
                    question:
                      "The workspace differs from the execution checkpoint. Reconcile it before continuing.",
                    context:
                      "Inspect the preserved changes before authorizing a fresh continuation.",
                    options: ["Workspace reconciled — continue"],
                  },
                ],
              };
            }
          }
          const replayStarted = Date.now();
          fingerprint = await fingerprintExecution(
            pool,
            begun.run,
            begun.step,
            begun.attempt,
            begun.input,
            begun.context,
          );
          if (scope.changed) fingerprint = { ...fingerprint, reusable: false };
          const previous = await findReplayResult(pool, begun.step, fingerprint);
          if (previous) {
            reusedFrom = previous.id;
            replayLatencyMs = Date.now() - replayStarted;
            return { kind: "completed" as const, output: previous.output };
          }
          if (begun.step.replay_source_attempt_id != null) {
            await ctx.log("system", "Replay candidate did not match current execution inputs", {
              action: "REEXECUTE",
              source_attempt_id: begun.step.replay_source_attempt_id,
            });
            await noteDecision({
              runId: begun.run.id,
              stepId: begun.step.id,
              attemptId: begun.attempt.id,
              generation: begun.attempt.generation,
              kind: "replay",
              action: "REEXECUTE",
              outcome: "applied",
              reason: "replay candidate did not match current execution inputs",
              sourceAttemptId: begun.step.replay_source_attempt_id,
              latencyMs: Date.now() - replayStarted,
            });
          }
          executorEntered = true;
          return getExecutor(begun.step.type).execute(ctx);
        },
      );
    }
  } catch (e) {
    result = ac.signal.aborted
      ? { kind: "failed", error: "aborted (canceled or lease lost)", retryable: false }
      : {
          kind: "failed",
          error: (e as Error)?.message ?? String(e),
          retryable: true,
          details: (e as Error)?.stack,
        };
  }
  try {
    if (deadline) clearTimeout(deadline);
    if (timedOut && !ac.signal.aborted)
      result = {
        kind: "failed",
        error: `execution timeout after ${timeoutMs}ms`,
        retryable: true,
        details: {
          provider_error: {
            code: "execution_timeout",
            message: `execution timeout after ${timeoutMs}ms`,
          },
        },
      };
    let workspace: WorkspaceCheckpoint | undefined;
    if (
      executorEntered &&
      !ac.signal.aborted &&
      ["agent", "coding_agent", "command", "git_pull_request"].includes(begun.step.type)
    ) {
      try {
        workspace = await executionWorkspace(
          begun.run,
          begun.step,
          ["coding_agent", "command"].includes(begun.step.type),
        );
      } catch {
        workspace = { fingerprint: "", unavailable: true };
        await traceLog({
          ...attemptTrace,
          level: "WARN",
          event: "checkpoint.workspace_unavailable",
          message: "Workspace evidence could not be captured within safety and storage limits",
        });
      }
    }
    if (fingerprint) {
      fingerprint = attachWorkspace(fingerprint, workspace?.fingerprint);
      const output = result.kind === "completed" ? result.output : undefined;
      fingerprint = {
        ...fingerprint,
        reusable: fingerprint.reusable && result.kind === "completed" && safeReplayOutput(output),
        ...(result.kind === "completed" && { output_hash: replayOutputHash(output) }),
      };
    }
    const replay = fingerprint
      ? { fingerprint, reusedFrom, latencyMs: replayLatencyMs }
      : undefined;
    const recorded = await retryTransient(
      () => recordExecutorReturn(job, begun.attempt.id, result, workspace, replay),
      `record executor checkpoint ${job.id}`,
    );
    if (!recorded) {
      // Cancellation fences mutations to the step; the original executor can still confirm its own exit.
      await retryTransient(
        () =>
          q(
            pool,
            "UPDATE workflow_step_attempts SET executor_stopped_at=COALESCE(executor_stopped_at,now()) WHERE id=$1 AND fencing_token=$2 AND job_id=$3",
            [begun.attempt.id, job.fencing_token, job.id],
          ),
        `record canceled executor termination ${job.id}`,
      );
    }
    const handoff = recorded ? await prepareProviderPause(begun, result) : undefined;
    if (
      !handoff &&
      (draining || ac.signal.aborted) &&
      result.kind === "failed" &&
      (await retryTransient(
        () =>
          releaseAttempt(
            job.id,
            job.fencing_token,
            begun.attempt.id,
            draining || "worker interrupted: heartbeat unavailable or lease lost",
          ),
        `release job ${job.id}`,
      ))
    ) {
      void traceLog({
        ...attemptTrace,
        level: "WARN",
        event: "attempt.released",
        status: "released",
        durationMs: Date.now() - startedAt,
        message: `attempt ${begun.attempt.id} released: ${draining || "heartbeat unavailable or lease lost"}`,
        data: { job_id: job.id, error: result.error },
      });
      return;
    }
    await retryTransient(
      () =>
        finishAttempt(
          job.id,
          job.fencing_token,
          begun.attempt.id,
          result,
          handoff,
          begun.attempt.run_id,
        ),
      `finish job ${job.id}`,
    );
    void traceLog({
      ...attemptTrace,
      level: result.kind === "failed" ? "ERROR" : "INFO",
      event: "attempt.finished",
      status: result.kind,
      durationMs: Date.now() - startedAt,
      message: `attempt ${begun.attempt.id} ${result.kind}${result.kind === "failed" ? `: ${result.error}` : ""}`,
      data: {
        job_id: job.id,
        retryable: result.kind === "failed" ? (result.retryable ?? null) : null,
        handoff: Boolean(handoff),
        details: result.kind === "failed" ? result.details : undefined,
      },
    });
  } catch (e) {
    void traceLog({
      ...attemptTrace,
      level: "ERROR",
      event: "attempt.finished",
      status: "error",
      durationMs: Date.now() - startedAt,
      message: `attempt ${begun.attempt.id} could not be finished: ${(e as Error)?.message ?? e}`,
      data: { job_id: job.id, result: result.kind },
    });
    throw e;
  } finally {
    if (deadline) clearTimeout(deadline);
    ac.signal.removeEventListener("abort", forwardAbort);
    clearInterval(hb);
    localJobs.unregister(job.id);
  }
  await continueHealthyHandoffForAttempt(begun.attempt.id).catch((e) =>
    log.error("healthy provider continuation:", (e as Error).message),
  );
}

/** Claim and execute at most one job. Returns false when the queue had nothing runnable. Used by tests. */
export async function runOnce(
  workerId = `${processId}:once`,
  opts: Pick<SchedulerOptions, "leaseSeconds" | "heartbeatSeconds"> = config.scheduler,
) {
  await reconcileAutomaticHandoff();
  const job = await claimJob(workerId, opts.leaseSeconds);
  if (!job) return runIndexOnce();
  await processJob(job, workerId, opts);
  return true;
}

/** Run jobs until the queue is empty (tests / CLI), then wait for their post-commit side effects. */
export async function drain(maxJobs = 200) {
  let n = 0;
  await settleBackground();
  while (n < maxJobs && (await runOnce())) n++;
  await settleBackground();
  return n;
}

export function startScheduler(opts: SchedulerOptions = config.scheduler) {
  let stopped = false;
  const indexAbort = new AbortController();
  const loops: Promise<void>[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const lanes = [
    ...Array.from({ length: opts.workers }, (_, i) => ({
      id: `${processId}:w${i}`,
      types: undefined as string[] | undefined,
    })),
    ...Array.from({ length: opts.lightWorkers ?? 1 }, (_, i) => ({
      id: `${processId}:light${i}`,
      types: LIGHT_STEP_TYPES,
    })),
  ];
  for (const lane of lanes) {
    const workerId = lane.id;
    loops.push(
      (async () => {
        while (!stopped) {
          // The shared handoff promise logs its own failure once. Each lane still backs off.
          if (
            !(await reconcileAutomaticHandoff().then(
              () => true,
              () => false,
            ))
          ) {
            await sleep(opts.pollMs * 5);
            continue;
          }
          let job: JobRow | undefined;
          try {
            const seen = runnableSignals;
            job = await claimJob(workerId, opts.leaseSeconds, lane.types);
            if (job) {
              wakeIdle([lane.types ? "light" : "general"]); // more may be runnable: let the next idle worker look
              await processJob(job, workerId, opts);
            } else if (!lane.types && (await runIndexOnce(indexAbort.signal))) {
              /* optional idle indexing */
            } else await idleWait(lane.types ? "light" : "general", opts.pollMs, seen);
          } catch (e) {
            logError("scheduler.worker_failed", "Scheduler worker failed", e, {
              worker_id: workerId,
              job_id: job?.id,
              run_id: job?.run_id,
              step_id: job?.step_id,
            });
            await sleep(opts.pollMs * 5);
          }
        }
      })(),
    );
  }
  const reconcile = () => {
    for (const task of reconcileTasks) void task();
    reapExpiredLeases().catch((e) => log.error("reaper:", e.message));
    dispatchRunEffects().catch((e) => log.error("run effects:", e.message));
    // The shared promise has already logged any failure.
    void reconcileAutomaticHandoff().catch(ignoreError("scheduler.automatic_handoff"));
    purgeDebugEventsThrottled().catch((e) => log.error("trace retention:", e.message));
  };
  const reaper = setInterval(reconcile, Math.max(5, opts.leaseSeconds / 2) * 1000);
  void reconcile();
  log.info(
    `scheduler: ${opts.workers} worker(s) + ${opts.lightWorkers ?? 1} light worker(s) as ${processId}`,
  );
  return {
    async stop() {
      stopped = true;
      indexAbort.abort();
      wakeAllIdle();
      clearInterval(reaper);
      await Promise.all(loops);
    },
    /** Stop claiming and reconcile interrupted steps (safe retry or human review, no retry budget used). */
    async drain(reason = "server shutting down") {
      draining = reason;
      stopped = true;
      indexAbort.abort();
      clearInterval(reaper);
      localJobs.abortAll();
      await Promise.all(loops);
      draining = null;
      await settleBackground();
    },
  };
}
