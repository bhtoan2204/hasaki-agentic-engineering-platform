import { pool, q, one, json, type Db } from "../db/pool.ts";

export interface WorkItemRow {
  id: number;
  code: string;
  source: "manual" | "hasaki_work" | "jira" | "legacy";
  external_key: string | null;
  external_id: string | null;
  title: string;
  description: string;
  project: string;
  payload: unknown;
  status: string;
  automation_policy: {
    workflow: string;
    inputs?: Record<string, unknown>;
  } | null;
  legacy_task_code: string | null;
  owner_id?: number | null;
  budget_usd?: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface WorkItemListFilter {
  source?: string;
  status?: string;
  ownerId?: number;
  all?: boolean;
}

export const workItemsRepository = {
  listWorkItems(filter: WorkItemListFilter = {}, db: Db = pool) {
    return q(
      db,
      `SELECT w.id, w.code, w.source, w.title, w.project, w.status, w.automation_policy, w.owner_id, w.created_at, w.updated_at,
              (SELECT count(*)::int FROM workflow_runs r WHERE r.work_item_id = w.id) AS run_count,
              (SELECT r.status FROM workflow_runs r WHERE r.work_item_id = w.id ORDER BY r.id DESC LIMIT 1) AS last_run_status,
              (SELECT r.id FROM workflow_runs r WHERE r.work_item_id = w.id ORDER BY r.id DESC LIMIT 1) AS last_run_id
         FROM work_items w
        WHERE ($1::text IS NULL OR w.source = $1) AND ($2::text IS NULL OR w.status = $2)
          AND w.owner_id IS NOT NULL AND ($3::bool OR w.owner_id = $4)
        ORDER BY w.updated_at DESC LIMIT 500`,
      [filter.source ?? null, filter.status ?? null, !!filter.all, filter.ownerId ?? null],
    );
  },

  getWorkItemById(id: number, db: Db = pool): Promise<WorkItemRow | undefined> {
    return one<WorkItemRow>(db, "SELECT * FROM work_items WHERE id = $1", [id]);
  },

  getWorkItemByCode(
    code: string,
    ownerId: number,
    db: Db = pool,
  ): Promise<WorkItemRow | undefined> {
    return one<WorkItemRow>(db, "SELECT * FROM work_items WHERE code = $1 AND owner_id = $2", [
      code,
      ownerId,
    ]);
  },

  findWorkItemForUpdate(
    code: string,
    ownerId: number,
    db: Db = pool,
  ): Promise<WorkItemRow | undefined> {
    return one<WorkItemRow>(
      db,
      "SELECT * FROM work_items WHERE code = $1 AND owner_id = $2 FOR UPDATE",
      [code, ownerId],
    );
  },

  async getNextWorkItemId(db: Db = pool): Promise<number> {
    const row = await one<{ id: number }>(db, "SELECT nextval('work_items_id_seq')::bigint AS id");
    return Number(row!.id);
  },

  async insertManualWorkItem(
    id: number,
    code: string,
    title: string,
    description: string,
    project: string,
    ownerId: number,
    db: Db = pool,
  ): Promise<void> {
    await q(
      db,
      "INSERT INTO work_items (id, code, source, title, description, project, owner_id) VALUES ($1, $2, 'manual', $3, $4, $5, $6)",
      [id, code, title, description, project, ownerId],
    );
  },

  async insertImportedWorkItem(
    data: {
      code: string;
      source: string;
      externalId?: string | null;
      title: string;
      description?: string;
      project?: string;
      payload?: unknown;
      automationPolicy?: unknown;
      ownerId: number;
    },
    db: Db = pool,
  ): Promise<WorkItemRow> {
    const row = await one<WorkItemRow>(
      db,
      `INSERT INTO work_items (code, source, external_key, external_id, title, description, project, payload, automation_policy, owner_id)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        data.code,
        data.source,
        data.externalId ?? null,
        data.title,
        data.description ?? "",
        data.project ?? "",
        json(data.payload ?? {}),
        json(data.automationPolicy ?? null),
        data.ownerId,
      ],
    );
    return row!;
  },

  async updateImportedWorkItem(
    id: number,
    data: {
      title: string;
      description: string;
      project: string;
      payload: unknown;
      externalId?: string | null;
    },
    db: Db = pool,
  ): Promise<void> {
    await q(
      db,
      `UPDATE work_items SET title = $2, description = $3, project = $4, payload = $5, external_id = COALESCE($6, external_id), updated_at = now() WHERE id = $1`,
      [id, data.title, data.description, data.project, json(data.payload), data.externalId ?? null],
    );
  },

  async updateWorkItem(
    id: number,
    patch: {
      title?: string;
      description?: string;
      project?: string;
      status?: string;
      automation_policy?: unknown;
    },
    db: Db = pool,
  ): Promise<void> {
    const keys = (
      ["title", "description", "project", "status", "automation_policy"] as const
    ).filter((k) => patch[k] !== undefined);
    if (patch.description !== undefined) {
      await q(db, "UPDATE work_items SET description_source = 'manual' WHERE id = $1", [id]);
    }
    if (keys.length) {
      await q(
        db,
        `UPDATE work_items SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
        [id, ...keys.map((k) => (k === "automation_policy" ? json(patch[k]) : patch[k]))],
      );
    }
  },

  async updateWorkItemBudget(id: number, budgetUsd: number | null, db: Db = pool): Promise<void> {
    await q(db, "UPDATE work_items SET budget_usd = $2, updated_at = now() WHERE id = $1", [
      id,
      budgetUsd,
    ]);
  },

  listPullRequests(workItemId: number, db: Db = pool) {
    return q(db, "SELECT * FROM pull_requests WHERE work_item_id = $1 ORDER BY id", [workItemId]);
  },

  listLegacyQuestions(taskCode: string, db: Db = pool) {
    return q(db, "SELECT * FROM questions WHERE task_code = $1 ORDER BY id", [taskCode]);
  },

  listLegacyEvents(taskCode: string, limit = 200, db: Db = pool) {
    return q(db, "SELECT * FROM events WHERE task_code = $1 ORDER BY id DESC LIMIT $2", [
      taskCode,
      limit,
    ]);
  },

  findActiveRunForWorkItem(workItemId: number, db: Db = pool) {
    return one(
      db,
      "SELECT id FROM workflow_runs WHERE work_item_id = $1 AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELED') LIMIT 1",
      [workItemId],
    );
  },
};
