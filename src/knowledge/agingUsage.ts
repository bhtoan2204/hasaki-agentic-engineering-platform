import { pool, q, type Db } from "../db/pool.ts";
import { ignoreError } from "../ignoreError.ts";
import { background } from "../workflow/background.ts";

/**
 * When task memory was last offered to a prompt (knowledge_usage), and which items are dormant. A leaf module: it
 * only needs the database, so the step transaction, the context tools and the chat can all call it.
 */

/**
 * One statement, ids in a fixed order (concurrent writers lock rows the same way). A hot item is written at most
 * once every five minutes, so a popular memory never becomes a contended row. Loading a dormant item wakes it.
 * Best-effort by design: call it after the caller's transaction committed, and ignore its failure.
 */
export async function recordKnowledgeUsage(ids: Array<number | undefined | null>, db: Db = pool) {
  const unique = [...new Set(ids.filter((i): i is number => Number.isInteger(i)))].sort(
    (a, b) => a - b,
  );
  if (!unique.length) return;
  await q(
    db,
    `INSERT INTO knowledge_usage (item_id, last_loaded_at, loads)
     SELECT i.id, now(), 1 FROM knowledge_items i WHERE i.id = ANY($1) AND i.category = 'task_memory' ORDER BY i.id
     ON CONFLICT (item_id) DO UPDATE SET last_loaded_at = now(), loads = knowledge_usage.loads + 1
      WHERE knowledge_usage.last_loaded_at < now() - interval '5 minutes'`,
    [unique],
  );
  await q(
    db,
    "UPDATE knowledge_aging SET state = 'active', policy = NULL, reason = NULL, at = now() WHERE item_id = ANY($1) AND state = 'dormant'",
    [unique],
  );
}

/**
 * Fire-and-forget form for the places that must never wait for or fail because of usage tracking: runs as background
 * work (shutdown and tests can wait for it), and a failure is counted and dropped.
 */
export const noteKnowledgeUsage = (ids: Array<number | undefined | null>) =>
  background("knowledge usage", () =>
    recordKnowledgeUsage(ids).catch(ignoreError("knowledge.usage")),
  );

/** Keys among `keys` whose item is dormant (ranked after active ones). */
export async function dormantKeys(keys: string[], db: Db = pool): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await q<{ key: string }>(
    db,
    `SELECT i.key FROM knowledge_aging a JOIN knowledge_items i ON i.id = a.item_id
      WHERE a.state = 'dormant' AND i.key = ANY($1)`,
    [keys],
  );
  return new Set(rows.map((r) => r.key));
}
