import { withTx, q, one, type Db } from "../db/pool.ts";

/**
 * Assign unassigned private rows to one admin. Shared workflow templates and seeded knowledge
 * stay owner_id NULL. Context snapshots are not rewritten; they stay authorized through the run.
 */
export async function claimLegacy(adminId: number, db?: Db) {
  const claim = async (c: Db) => {
    const admin = await one<{ id: number }>(c, "SELECT id FROM users WHERE id = $1 AND role = 'admin' AND active", [adminId]);
    if (!admin) throw new Error("claim target must be an active admin");
    const workItems = await c.query("UPDATE work_items SET owner_id = $1 WHERE owner_id IS NULL", [adminId]);
    const runs = await c.query("UPDATE workflow_runs SET owner_id = $1 WHERE owner_id IS NULL", [adminId]);
    const inbox = await c.query("UPDATE inbox SET owner_id = $1 WHERE owner_id IS NULL", [adminId]);
    const tasks = await c.query("UPDATE tasks SET owner_id = $1 WHERE owner_id IS NULL", [adminId]);
    await q(c, "INSERT INTO audit_log (actor_id, action, resource_type, resource_id, detail) VALUES ($1, 'legacy.claim', 'user', $2, $3)", [
      adminId,
      String(adminId),
      JSON.stringify({
        work_items: workItems.rowCount ?? 0,
        runs: runs.rowCount ?? 0,
        inbox: inbox.rowCount ?? 0,
        tasks: tasks.rowCount ?? 0,
      }),
    ]);
    return {
      work_items: workItems.rowCount ?? 0,
      runs: runs.rowCount ?? 0,
      inbox: inbox.rowCount ?? 0,
      tasks: tasks.rowCount ?? 0,
    };
  };
  return db ? claim(db) : withTx(claim);
}
