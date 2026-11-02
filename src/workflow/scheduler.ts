import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { pool, one } from "../db/pool.ts";
import { beginAttempt, finishAttempt, heartbeat, reapExpiredLeases } from "./engine.ts";
import { getExecutor, makeContext } from "./executors/registry.ts";
import { localJobs } from "./local.ts";
import type { ExecResult, JobRow } from "./types.ts";

/**
 * WorkflowScheduler: PostgreSQL-backed job claiming. No in-memory queue: any number of processes can run
 * workers against the same database; `FOR UPDATE SKIP LOCKED` hands each job to exactly one of them and the
 * fencing token protects against a worker that lost its lease but keeps running.
 */

export interface SchedulerOptions {
  workers: number;
  leaseSeconds: number;
  heartbeatSeconds: number;
  pollMs: number;
}

const processId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export async function claimJob(workerId: string, leaseSeconds: number): Promise<JobRow | undefined> {
  return one<JobRow>(
    pool,
    `UPDATE workflow_jobs j
        SET status = 'running', lease_owner = $1, lease_expires_at = now() + make_interval(secs => $2),
            fencing_token = j.fencing_token + 1, claims = j.claims + 1, updated_at = now()
      WHERE j.id = (
        SELECT j2.id FROM workflow_jobs j2 JOIN workflow_runs r ON r.id = j2.run_id
         WHERE j2.status = 'queued' AND j2.available_at <= now() AND r.status NOT IN ('PAUSED', 'CANCELED', 'PENDING')
         ORDER BY j2.available_at, j2.id
         FOR UPDATE OF j2 SKIP LOCKED LIMIT 1)
      RETURNING j.*`,
    [workerId, leaseSeconds],
  );
}

/** Execute one claimed job end to end. */
export async function processJob(job: JobRow, workerId: string, opts: Pick<SchedulerOptions, "leaseSeconds" | "heartbeatSeconds">) {
  const begun = await beginAttempt(job, workerId);
  if (!begun) return;
  const ac = new AbortController();
  localJobs.register(job.id, ac);
  const hb = setInterval(async () => {
    try {
      if (!(await heartbeat(job.id, job.fencing_token, opts.leaseSeconds))) ac.abort();
    } catch (e) {
      console.error(`heartbeat job ${job.id}:`, (e as Error).message);
    }
  }, opts.heartbeatSeconds * 1000);
  let result: ExecResult;
  try {
    const ctx = makeContext({ ...begun, signal: ac.signal });
    result = await getExecutor(begun.step.type).execute(ctx);
  } catch (e) {
    result = ac.signal.aborted
      ? { kind: "failed", error: "aborted (canceled or lease lost)", retryable: false }
      : { kind: "failed", error: (e as Error)?.message ?? String(e), retryable: true, details: (e as Error)?.stack };
  } finally {
    clearInterval(hb);
    localJobs.unregister(job.id);
  }
  await finishAttempt(job.id, job.fencing_token, begun.attempt.id, result);
}

/** Claim and execute at most one job. Returns false when the queue had nothing runnable. Used by tests. */
export async function runOnce(workerId = `${processId}:once`, opts: Pick<SchedulerOptions, "leaseSeconds" | "heartbeatSeconds"> = config.scheduler) {
  const job = await claimJob(workerId, opts.leaseSeconds);
  if (!job) return false;
  await processJob(job, workerId, opts);
  return true;
}

/** Run jobs until the queue is empty (tests / CLI). */
export async function drain(maxJobs = 200) {
  let n = 0;
  while (n < maxJobs && (await runOnce())) n++;
  return n;
}

export function startScheduler(opts: SchedulerOptions = config.scheduler) {
  let stopped = false;
  const loops: Promise<void>[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < opts.workers; i++) {
    const workerId = `${processId}:w${i}`;
    loops.push(
      (async () => {
        while (!stopped) {
          try {
            const job = await claimJob(workerId, opts.leaseSeconds);
            if (job) await processJob(job, workerId, opts);
            else await sleep(opts.pollMs);
          } catch (e) {
            console.error(`worker ${workerId}:`, (e as Error).message);
            await sleep(opts.pollMs * 5);
          }
        }
      })(),
    );
  }
  const reaper = setInterval(() => reapExpiredLeases().catch((e) => console.error("reaper:", e.message)), Math.max(5, opts.leaseSeconds / 2) * 1000);
  void reapExpiredLeases().catch(() => {});
  console.log(`scheduler: ${opts.workers} worker(s) as ${processId}`);
  return {
    async stop() {
      stopped = true;
      clearInterval(reaper);
      await Promise.all(loops);
    },
  };
}
