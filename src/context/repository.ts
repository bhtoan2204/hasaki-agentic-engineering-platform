import { pool, q, one, json, type Db } from "../db/pool.ts";
/** Caller must requireAttempt first, using the existing audited support/owner access path. */
export async function attemptContext(attemptId: number, offset = 0, db: Db = pool) {
  const limit = 25;
  const [pack, continuity, calls, count] = await Promise.all([
    one<{
      id: number;
      snapshot_id: number;
      content_hash: string;
      content: unknown;
      created_at: Date;
    }>(
      db,
      "SELECT id,snapshot_id,content_hash,content,created_at FROM agent_context_packs WHERE attempt_id=$1",
      [attemptId],
    ),
    one<Record<string, unknown>>(db, "SELECT * FROM agent_context_continuity WHERE attempt_id=$1", [
      attemptId,
    ]),
    q<Record<string, unknown>>(
      db,
      "SELECT id,tool,read_only,status,duration_ms,input_hash,evidence,created_at FROM agent_context_tool_calls WHERE attempt_id=$1 ORDER BY id LIMIT $3 OFFSET $2",
      [attemptId, offset, limit],
    ),
    one<{ n: number }>(
      db,
      "SELECT count(*)::int AS n FROM agent_context_tool_calls WHERE attempt_id=$1",
      [attemptId],
    ),
  ]);
  return {
    attempt_id: attemptId,
    pack: pack ?? null,
    continuity: continuity ?? null,
    tool_calls: calls,
    total_calls: count!.n,
    offset,
    limit,
  };
}

export function findSnapshot(id: number, db: Db = pool) {
  return one<{
    id: number;
    run_id: number;
    step_id: number;
    hash: string;
    content: unknown;
    created_at: Date;
  }>(db, "SELECT * FROM context_snapshots WHERE id = $1", [id]);
}

export async function insertSnapshot(
  db: Db,
  runId: number,
  stepId: number,
  hash: string,
  content: unknown,
) {
  const row = await one<{ id: number }>(
    db,
    "INSERT INTO context_snapshots (run_id, step_id, hash, content) VALUES ($1, $2, $3, $4) RETURNING id",
    [runId, stepId, hash, json(content)],
  );
  return row!.id;
}
