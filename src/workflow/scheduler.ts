import { traceLog } from "./trace.ts";
import { reapExpiredLeases, releaseAttempt } from "./recovery.ts";
import { runIndexOnce } from "../codeIntelligence/indexer.ts";
import { randomUUID } from "node:crypto";
import { instanceSession } from "../instances.ts";
import { config } from "../config.ts";
import { loadPersonalIntegrations } from "../integrations/loadPersonal.ts";
import { execution } from "../auth/execution.ts";
import { pool, one, q, retryTransient } from "../db/pool.ts";
import {
  beginAttempt,
  finishAttempt,
  heartbeat,
  prepareProviderPause,
  processAutomaticHandoff,
} from "./engine.ts";
import { dispatchRunEffects } from "./effects.ts";
import { getExecutor, makeContext } from "./executors/registry.ts";
import { enforceRunRepositoryAccess } from "../repos/access.ts";
import { repositories, repoPath } from "../repos/service.ts";
import { localJobs } from "./local.ts";
import { deferIfBranchBusy } from "./branchLeases.ts";
import { settleBackground } from "./background.ts";
import type { ExecResult, JobRow } from "./types.ts";

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

let automaticHandoff: Promise<void> | null = null;

/**
 * Scan at most one due automatic handoff. Concurrent callers share the scan already in flight.
 * A caller that arrives after it settles scans again; durable handoff state is not cached.
 */
export function reconcileAutomaticHandoff(): Promise<void> {
  if (automaticHandoff) return automaticHandoff;
  const run = processAutomaticHandoff().finally(() => {
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
  // Fire-and-forget: tracing must never delay or fail a claim.
  if (job)
    void traceLog({
      runId: job.run_id,
      stepId: job.step_id,
      level: "DEBUG",
      event: "job.claimed",
      message: `job ${job.id} claimed by ${workerId}`,
      data: { job_id: job.id, fencing_token: job.fencing_token, claims: job.claims, lease_seconds: leaseSeconds },
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
  const step = await one<{ type: string }>(pool, "SELECT type FROM workflow_steps WHERE id = $1", [
    job.step_id,
  ]);
  if (step && (await deferIfBranchBusy(job, step.type))) return;
  const begun = await beginAttempt(job, workerId);
  if (!begun) return;
  const ac = new AbortController();
  localJobs.register(job.id, ac);
  const hb = setInterval(async () => {
    try {
      if (
        !(await heartbeat(job.id, job.fencing_token, opts.leaseSeconds, begun.attempt.id))
      )
        ac.abort();
    } catch (e) {
      ac.abort();
      console.error(`heartbeat job ${job.id}:`, (e as Error).message);
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
    await retryTransient(
      () =>
        q(
          pool,
          "UPDATE workflow_step_attempts SET executor_stopped_at=COALESCE(executor_stopped_at,now()) WHERE id=$1 AND fencing_token=$2",
          [begun.attempt.id, job.fencing_token],
        ),
      `record executor termination ${job.id}`,
    );
    const handoff = await prepareProviderPause(begun, result);
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
    )
      return;
    await retryTransient(
      () => finishAttempt(job.id, job.fencing_token, begun.attempt.id, result, handoff),
      `finish job ${job.id}`,
    );
  } finally {
    if (deadline) clearTimeout(deadline);
    ac.signal.removeEventListener("abort", forwardAbort);
    clearInterval(hb);
    localJobs.unregister(job.id);
  }
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
          try {
            await reconcileAutomaticHandoff();
            const job = await claimJob(workerId, opts.leaseSeconds, lane.types);
            if (job) await processJob(job, workerId, opts);
            else if (!lane.types && (await runIndexOnce(indexAbort.signal))) {
              /* optional idle indexing */
            } else await sleep(opts.pollMs);
          } catch (e) {
            console.error(`worker ${workerId}:`, (e as Error).message);
            await sleep(opts.pollMs * 5);
          }
        }
      })(),
    );
  }
  const reconcile = () => {
    reapExpiredLeases().catch((e) => console.error("reaper:", e.message));
    dispatchRunEffects().catch((e) => console.error("run effects:", e.message));
    reconcileAutomaticHandoff().catch((e) => console.error("automatic handoff:", e.message));
  };
  const reaper = setInterval(reconcile, Math.max(5, opts.leaseSeconds / 2) * 1000);
  void reconcile();
  console.log(
    `scheduler: ${opts.workers} worker(s) + ${opts.lightWorkers ?? 1} light worker(s) as ${processId}`,
  );
  return {
    async stop() {
      stopped = true;
      indexAbort.abort();
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
