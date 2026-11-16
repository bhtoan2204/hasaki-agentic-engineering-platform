import { one, pool, withTx } from "../db/pool.ts";
import { branchFor } from "./branches.ts";
import { runEvents } from "./events.ts";
import type { JobRow } from "./types.ts";

/** Step types that check out, change or publish the run's branch. Analysis steps only read and never wait. */
const BRANCH_STEP_TYPES = ["coding_agent", "command", "git_pull_request"];
const RECHECK_SECONDS = 30;

export interface BranchHolder {
  runId: number;
  repo: string;
  branch: string;
}

class BranchBusy extends Error {
  readonly holder: BranchHolder;
  constructor(holder: BranchHolder) {
    super("branch busy");
    this.holder = holder;
  }
}

/**
 * Takes the (repo, branch) lease for every repository of the run, all or nothing. A lease held by a run that is
 * COMPLETED, FAILED or CANCELED is taken over; one held by any other run is returned and nothing is taken.
 */
export async function acquireBranchLeases(runId: number): Promise<BranchHolder | null> {
  try {
    return await withTx(async (c) => {
      const run = await one<{
        branch: string;
        inputs: Record<string, unknown> | null;
        selected_repositories: string[];
        allowed_repositories: string[];
      }>(
        c,
        "SELECT branch, inputs, selected_repositories, allowed_repositories FROM workflow_runs WHERE id = $1",
        [runId],
      );
      if (!run) return null;
      const repos = run.selected_repositories.length
        ? run.selected_repositories
        : run.allowed_repositories;
      // Sorted so concurrent runs lock lease rows in the same order.
      for (const repo of [...repos].sort()) {
        const { branch } = branchFor(run, repo);
        const taken = await one(
          c,
          `INSERT INTO workflow_branch_leases (repo, branch, run_id) VALUES ($1, $2, $3)
           ON CONFLICT (repo, branch) DO UPDATE SET run_id = EXCLUDED.run_id, acquired_at = now()
            WHERE workflow_branch_leases.run_id = EXCLUDED.run_id
               OR EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id = workflow_branch_leases.run_id
                           AND r.status IN ('COMPLETED', 'FAILED', 'CANCELED'))
           RETURNING run_id`,
          [repo, branch, runId],
        );
        if (taken) continue;
        const holder = await one<{ run_id: string }>(
          c,
          "SELECT run_id FROM workflow_branch_leases WHERE repo = $1 AND branch = $2",
          [repo, branch],
        );
        // Throwing rolls back the leases already taken in this call: a waiting run holds none.
        throw new BranchBusy({ runId: Number(holder?.run_id), repo, branch });
      }
      return null;
    });
  } catch (e) {
    if (e instanceof BranchBusy) return e.holder;
    throw e;
  }
}

/**
 * Called right after a job is claimed. Returns true when the job went back to the queue because another active run
 * holds the branch: no attempt starts, and the step is checked again later.
 */
export async function deferIfBranchBusy(job: JobRow, stepType: string): Promise<boolean> {
  if (!BRANCH_STEP_TYPES.includes(stepType)) return false;
  const holder = await acquireBranchLeases(Number(job.run_id));
  if (!holder) return false;
  const reason = `waiting for branch ${holder.branch} in ${holder.repo}: run #${holder.runId} is still using it`;
  const requeued = await one<{ previous: string | null }>(
    pool,
    `WITH old AS (SELECT last_error FROM workflow_jobs WHERE id = $1)
     UPDATE workflow_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
       available_at = now() + make_interval(secs => $3), last_error = $4, updated_at = now()
     WHERE id = $1 AND fencing_token = $2
     RETURNING (SELECT last_error FROM old) AS previous`,
    [job.id, job.fencing_token, RECHECK_SECONDS, reason],
  );
  // One timeline event per holder, not one per recheck.
  if (requeued && requeued.previous !== reason)
    await runEvents.add(pool, Number(job.run_id), "system", reason, Number(job.step_id));
  return true;
}
