import { pool, q, json, type Db } from "../db/pool.ts";

/** Event kinds that make up an agent conversation; the run timeline hides the verbose ones. */
export const TRANSCRIPT_ONLY = ["system_prompt", "prompt", "thinking", "tool_result", "result"];

export const runEvents = {
  async add(db: Db, runId: number, kind: string, content: string, stepId: number | null = null, attemptId: number | null = null, data: unknown = null) {
    await q(db, "INSERT INTO workflow_events (run_id, step_id, attempt_id, kind, content, data) VALUES ($1, $2, $3, $4, $5, $6)", [
      runId,
      stepId,
      attemptId,
      kind,
      content,
      json(data),
    ]);
  },
  /** Run timeline: status changes, notes, tool calls (truncated); full transcripts are fetched per attempt. */
  list(runId: number, afterId = 0, db: Db = pool) {
    return q(
      db,
      `SELECT e.id, e.run_id, e.step_id, e.attempt_id, e.kind, e.created_at, s.key AS step_key,
              CASE WHEN length(e.content) > 600 THEN left(e.content, 600) || '…' ELSE e.content END AS content
         FROM workflow_events e LEFT JOIN workflow_steps s ON s.id = e.step_id
        WHERE e.run_id = $1 AND e.id > $2 AND e.kind <> ALL($3) ORDER BY e.id LIMIT 2000`,
      [runId, afterId, TRANSCRIPT_ONLY],
    );
  },
  /** Everything that happened inside one attempt, in order (incremental with `afterId`). */
  transcript(attemptId: number, afterId = 0, db: Db = pool) {
    return q(db, "SELECT id, kind, content, data, created_at FROM workflow_events WHERE attempt_id = $1 AND id > $2 ORDER BY id LIMIT 5000", [attemptId, afterId]);
  },
};
