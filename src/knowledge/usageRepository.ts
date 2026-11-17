import { pool, q, type Db } from "../db/pool.ts";

export function knowledgeUsage(key: string, ownerId: number, all: boolean, db: Db = pool) {
  return q<{
    run_id: number;
    step_key: string;
    step_name: string;
    run_title: string;
    definition_key: string;
    created_at: Date;
    version: number | null;
  }>(
    db,
    `SELECT cs.run_id, s.key AS step_key, s.name AS step_name, r.title AS run_title, r.definition_key, cs.created_at,
            (SELECT (k->>'version')::int FROM jsonb_array_elements(cs.content->'knowledge') k WHERE k->>'key' = $1 LIMIT 1) AS version
       FROM context_snapshots cs JOIN workflow_steps s ON s.id = cs.step_id JOIN workflow_runs r ON r.id = cs.run_id
      WHERE cs.content->'knowledge' @> jsonb_build_array(jsonb_build_object('key', $1::text))
        AND ($2::bool OR r.owner_id = $3)
      ORDER BY cs.id DESC LIMIT 100`,
    [key, all, ownerId],
  );
}
