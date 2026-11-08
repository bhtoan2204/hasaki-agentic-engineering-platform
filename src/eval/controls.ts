import { one, pool } from "../db/pool.ts";
/** Version inventory only; private knowledge bodies never enter comparison keys. */
export async function contextInventory(owner: number) {
  return (
    await one(
      pool,
      `SELECT md5(COALESCE(string_agg(jsonb_build_array(id,current_version,enabled,enforced,scope_type,scope_ref,priority,updated_at)::text,',' ORDER BY id),'')) AS hash FROM knowledge_items WHERE owner_id IS NULL OR owner_id=$1`,
      [owner],
    )
  ).hash as string;
}
