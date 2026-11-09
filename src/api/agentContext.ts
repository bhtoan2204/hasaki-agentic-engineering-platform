import { pool, q, one } from "../db/pool.ts";
/** Caller must requireAttempt first, using the existing audited support/owner access path. */
export async function attemptContext(attemptId: number, offset = 0) {
  const [pack, continuity, calls, count] = await Promise.all([
    one(pool, "SELECT id,snapshot_id,content_hash,content,created_at FROM agent_context_packs WHERE attempt_id=$1", [
      attemptId,
    ]),
    one(pool, "SELECT * FROM agent_context_continuity WHERE attempt_id=$1", [attemptId]),
    q(
      pool,
      "SELECT id,tool,read_only,status,duration_ms,input_hash,evidence,created_at FROM agent_context_tool_calls WHERE attempt_id=$1 ORDER BY id LIMIT 25 OFFSET $2",
      [attemptId, offset],
    ),
    one(pool, "SELECT count(*)::int AS n FROM agent_context_tool_calls WHERE attempt_id=$1", [attemptId]),
  ]);
  return {
    attempt_id: attemptId,
    pack: pack ?? null,
    continuity: continuity ?? null,
    tool_calls: calls,
    total_calls: count.n,
    offset,
    limit: 25,
  };
}
