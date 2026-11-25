import { findRun, stepsOf } from "../runRepository.ts";
import type { AgentConfiguration } from "../../agent/configuration.ts";
import { EngineError, type AfterCommit } from "../mutations.ts";
import type pg from "pg";
import { config } from "../../config.ts";
import { pool, one, withTx, type Db } from "../../db/pool.ts";

export const frozenProviderFlags = (snapshot: AgentConfiguration | null | undefined) =>
  snapshot
    ? Object.fromEntries(
        Object.entries(snapshot.providers).map(([key, entry]) => [key, entry.enabled]),
      )
    : undefined;

/**
 * WorkflowExecutionService. Invariants:
 *  - lifecycle/result transactions first lock the run row (`lockRun`); begin then locks job → step,
 *    while completion/recovery lock job → attempt → step. Claim/heartbeat/executor writes have narrower contracts;
 *  - step status changes are validated by the state machine;
 *  - an attempt's result is applied only if its job's fencing token and its step's generation are unchanged.
 */

export type WorkflowActionGuard = (db: Db) => Promise<void>;

/**
 * Validate the existing owner before starting/resuming/retrying. Local workspaces never move with an API action.
 */
export async function adoptRun(c: Db, runId: number) {
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
export async function txThenRun(
  runId: number,
  fn: (c: pg.PoolClient, afterCommit: AfterCommit) => Promise<void>,
) {
  await withTx(fn);
  return getRun(runId);
}
