import { pool, one, type Db } from "../db/pool.ts";
/** The database link is authoritative; a user-controlled title/input never disables normal workflow behavior. */
export async function isEvaluationRun(runId: number, db: Db = pool) {
  return !!(await one(
    db,
    "SELECT 1 FROM evaluation_runs WHERE workflow_run_id=$1",
    [runId],
  ));
}
