import { pool, q, type Db } from "../db/pool.ts";

export const runEvents = {
  async add(db: Db, runId: number, kind: string, content: string, stepId: number | null = null, attemptId: number | null = null) {
    await q(db, "INSERT INTO workflow_events (run_id, step_id, attempt_id, kind, content) VALUES ($1, $2, $3, $4, $5)", [
      runId,
      stepId,
      attemptId,
      kind,
      content,
    ]);
  },
  list(runId: number, afterId = 0, db: Db = pool) {
    return q(
      db,
      `SELECT e.*, s.key AS step_key FROM workflow_events e LEFT JOIN workflow_steps s ON s.id = e.step_id
        WHERE e.run_id = $1 AND e.id > $2 ORDER BY e.id LIMIT 2000`,
      [runId, afterId],
    );
  },
};
