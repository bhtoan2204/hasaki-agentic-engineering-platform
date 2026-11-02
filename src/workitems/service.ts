import { pool, q, one, withTx, json, type Db } from "../db/pool.ts";
import { listRuns, startRun } from "../workflow/engine.ts";

export interface WorkItemRow {
  id: number;
  code: string;
  source: "manual" | "hasaki_work" | "jira" | "legacy";
  external_key: string | null;
  external_id: string | null;
  title: string;
  description: string;
  project: string;
  payload: any;
  status: string;
  automation_policy: { workflow: string; inputs?: Record<string, unknown> } | null;
  legacy_task_code: string | null;
}

export interface ImportInput {
  source: WorkItemRow["source"];
  code: string;
  externalId?: string | null;
  title: string;
  description?: string;
  project?: string;
  payload?: unknown;
  automationPolicy?: WorkItemRow["automation_policy"];
}

export const workItems = {
  list(filter: { source?: string; status?: string } = {}, db: Db = pool) {
    return q(
      db,
      `SELECT w.id, w.code, w.source, w.title, w.project, w.status, w.automation_policy, w.created_at, w.updated_at,
              (SELECT count(*)::int FROM workflow_runs r WHERE r.work_item_id = w.id) AS run_count,
              (SELECT r.status FROM workflow_runs r WHERE r.work_item_id = w.id ORDER BY r.id DESC LIMIT 1) AS last_run_status,
              (SELECT r.id FROM workflow_runs r WHERE r.work_item_id = w.id ORDER BY r.id DESC LIMIT 1) AS last_run_id
         FROM work_items w
        WHERE ($1::text IS NULL OR w.source = $1) AND ($2::text IS NULL OR w.status = $2)
        ORDER BY w.updated_at DESC LIMIT 500`,
      [filter.source ?? null, filter.status ?? null],
    );
  },

  get(id: number, db: Db = pool) {
    return one<WorkItemRow>(db, "SELECT * FROM work_items WHERE id = $1", [id]);
  },
  byCode(code: string, db: Db = pool) {
    return one<WorkItemRow>(db, "SELECT * FROM work_items WHERE code = $1", [code]);
  },

  async detail(id: number) {
    const wi = await workItems.get(id);
    if (!wi) return undefined;
    const [runs, prs] = await Promise.all([listRuns({ workItemId: id }), q(pool, "SELECT * FROM pull_requests WHERE work_item_id = $1 ORDER BY id", [id])]);
    const legacy = wi.legacy_task_code
      ? {
          questions: await q(pool, "SELECT * FROM questions WHERE task_code = $1 ORDER BY id", [wi.legacy_task_code]),
          events: await q(pool, "SELECT * FROM events WHERE task_code = $1 ORDER BY id DESC LIMIT 200", [wi.legacy_task_code]),
        }
      : null;
    return { ...wi, runs, pull_requests: prs, legacy };
  },

  /** Manual engineering request. Code REQ-<id> doubles as the branch name. */
  async createManual(x: { title: string; description?: string; project?: string; code?: string }) {
    if (!x.title?.trim()) throw new Error("title is required");
    return withTx(async (c) => {
      const { id } = (await one<{ id: number }>(c, "SELECT nextval('work_items_id_seq')::bigint AS id"))!;
      const code = x.code?.trim() || `REQ-${id}`;
      if (!/^[A-Za-z0-9._-]+$/.test(code)) throw new Error("code may contain only letters, digits, . _ -");
      await q(c, "INSERT INTO work_items (id, code, source, title, description, project) VALUES ($1, $2, 'manual', $3, $4, $5)", [
        id,
        code,
        x.title.trim(),
        x.description ?? "",
        x.project ?? "",
      ]);
      return (await workItems.get(id, c))!;
    });
  },

  /**
   * Import or refresh an external work item. NEVER starts a run by itself; the caller decides
   * (explicit user action, or the item's automation policy via `applyAutomationPolicy`).
   */
  async upsertImported(x: ImportInput): Promise<{ item: WorkItemRow; created: boolean }> {
    return withTx(async (c) => {
      const existing = await one<WorkItemRow>(c, "SELECT * FROM work_items WHERE code = $1 FOR UPDATE", [x.code]);
      if (existing) {
        await q(c, `UPDATE work_items SET title = $2, description = $3, project = $4, payload = $5, external_id = COALESCE($6, external_id), updated_at = now() WHERE id = $1`, [
          existing.id,
          x.title,
          x.description ?? existing.description,
          x.project ?? existing.project,
          json(x.payload ?? existing.payload),
          x.externalId ?? null,
        ]);
        return { item: (await workItems.get(existing.id, c))!, created: false };
      }
      const row = await one<WorkItemRow>(
        c,
        `INSERT INTO work_items (code, source, external_key, external_id, title, description, project, payload, automation_policy)
         VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [x.code, x.source, x.externalId ?? null, x.title, x.description ?? "", x.project ?? "", json(x.payload ?? {}), json(x.automationPolicy ?? null)],
      );
      return { item: row!, created: true };
    });
  },

  async update(id: number, patch: { title?: string; description?: string; project?: string; status?: string; automation_policy?: unknown }) {
    const keys = (["title", "description", "project", "status", "automation_policy"] as const).filter((k) => patch[k] !== undefined);
    if (keys.length)
      await q(pool, `UPDATE work_items SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [
        id,
        ...keys.map((k) => (k === "automation_policy" ? json(patch[k]) : patch[k])),
      ]);
    return workItems.get(id);
  },
};

/** The only automatic execution path: an explicit, stored automation policy naming a workflow. */
export async function applyAutomationPolicy(item: WorkItemRow) {
  const wf = item.automation_policy?.workflow;
  if (!wf) return null;
  const active = await one(pool, "SELECT id FROM workflow_runs WHERE work_item_id = $1 AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELED') LIMIT 1", [item.id]);
  if (active) return null;
  return startRun({ definitionKey: wf, workItemId: item.id, inputs: item.automation_policy?.inputs });
}
