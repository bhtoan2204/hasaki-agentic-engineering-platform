import { config } from "../config.ts";
import { one, pool } from "../db/pool.ts";
import type { SharedKind } from "./key.ts";
import { sharingHooks } from "./hooks.ts";
import { finish, settleable } from "./repository.ts";

/**
 * What a finished run leaves for others: the snapshot of the analysis (step 5 scrubs it through the hook). Null when
 * the run completed without the output the analysis is made of; the row is then failed, never published empty.
 */
export async function snapshotOf(kind: SharedKind, runId: number): Promise<unknown | null> {
  if (kind === "prod_error.bug_hunt") {
    const h = await one<{ report: unknown }>(
      pool,
      "SELECT report FROM bug_hunts WHERE run_id = $1",
      [runId],
    );
    return h?.report ?? null;
  }
  const step = kind === "code_assessment" ? "assess" : "report";
  const s = await one<{ output: unknown }>(
    pool,
    "SELECT output FROM workflow_steps WHERE run_id = $1 AND key = $2 AND status = 'COMPLETED'",
    [runId, step],
  );
  return s?.output ?? null;
}

const enabled = () => config.sharedResults.prodErrors || config.sharedResults.codeAssessment;

/**
 * Reconcile task: settle running analyses whose run has ended (publish or fail), whose run is gone, or that outlived the
 * running timeout (a run stuck waiting forever must not block the key). Safe on every instance at once: each row is
 * settled by a guarded UPDATE (status = 'running'), so exactly one instance publishes it and notifies the waiters.
 * A timed-out row whose run later completes stays failed; the late result is not published (a new claim re-runs it).
 */
export async function settleSharedAnalyses(limit = 50) {
  if (!enabled()) return 0;
  const hooks = sharingHooks();
  let settled = 0;
  for (const r of await settleable(pool, config.sharedResults.runningTimeoutMinutes, limit)) {
    const id = Number(r.id);
    const runId = r.source_run_id == null ? null : Number(r.source_run_id);
    let outcome: Parameters<typeof finish>[2];
    if (runId == null || r.run_status == null)
      outcome = { status: "failed", failure: { reason: "run missing", run_id: runId } };
    else if (r.run_status === "COMPLETED") {
      const snapshot = await snapshotOf(r.kind, runId);
      outcome =
        snapshot == null
          ? { status: "failed", failure: { reason: "completed without a result", run_id: runId } }
          : { status: "valid", result: hooks.scrub(r.kind, snapshot) };
    } else if (["FAILED", "CANCELED"].includes(r.run_status))
      outcome = {
        status: "failed",
        failure: { reason: `run ${r.run_status.toLowerCase()}`, run_id: runId },
      };
    else
      outcome = {
        status: "failed",
        failure: { reason: "timeout", run_id: runId, run_status: r.run_status },
      };
    if (await finish(pool, id, outcome)) {
      settled++;
      hooks.observe({
        kind: r.kind,
        outcome: outcome.status === "valid" ? "published" : "failed",
        analysisId: id,
        version: null,
        runId,
        actorId: null,
      });
    }
  }
  return settled;
}
