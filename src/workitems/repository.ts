import { pool, q, one, json, type Db } from "../db/pool.ts";

export interface WorkItemRow {
  id: number;
  code: string;
  source: "manual" | "hasaki_work";
  external_key: string | null;
  external_id: string | null;
  title: string;
  description: string;
  project: string;
  payload: unknown;
  description_source: "manual" | "import";
  status: string;
  automation_policy: {
    workflow: string;
    inputs?: Record<string, unknown>;
  } | null;
  owner_id: number | null;
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
  ownerId?: number;
}

type WorkItemPatch = {
  title?: string;
  description?: string;
  project?: string;
  status?: string;
  automation_policy?: unknown;
};

export const workItemRepository = {
  list(
    filter: {
      source?: string;
      status?: string;
      ownerId?: number;
      all?: boolean;
    } = {},
    db: Db = pool,
  ) {
    return q<
      Pick<
        WorkItemRow,
        "id" | "code" | "source" | "title" | "project" | "status" | "automation_policy" | "owner_id"
      > & {
        created_at: Date;
        updated_at: Date;
        run_count: number;
        last_run_status: string | null;
        last_run_id: number | null;
      }
    >(
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

  get(id: number, db: Db = pool) {
    return one<WorkItemRow>(db, "SELECT * FROM work_items WHERE id = $1", [id]);
  },
  byCode(code: string, ownerId: number, db: Db = pool) {
    return one<WorkItemRow>(db, "SELECT * FROM work_items WHERE code = $1 AND owner_id = $2", [
      code,
      ownerId,
    ]);
  },

  pullRequests(id: number, db: Db = pool) {
    return q<Record<string, unknown>>(
      db,
      "SELECT * FROM pull_requests WHERE work_item_id = $1 ORDER BY id",
      [id],
    );
  },

  async nextId(db: Db) {
    const row = await one<{ id: number }>(db, "SELECT nextval('work_items_id_seq')::bigint AS id");
    return row!.id;
  },

  async insertManual(
    db: Db,
    id: number,
    input: {
      code: string;
      title: string;
      description: string;
      project: string;
      ownerId: number;
      payload?: Record<string, unknown>;
    },
  ) {
    const row = await one<WorkItemRow>(
      db,
      "INSERT INTO work_items (id, code, source, title, description, project, owner_id, payload) VALUES ($1, $2, 'manual', $3, $4, $5, $6, $7) RETURNING *",
      [
        id,
        input.code,
        input.title,
        input.description,
        input.project,
        input.ownerId,
        json(input.payload ?? {}),
      ],
    );
    return row!;
  },

  /**
   * The branch each repository of a work item was worked on: the pull request's source branch, else the branch of the
   * newest worktree of its runs. This is where a follow-up of the item continues.
   */
  async branches(id: number, db: Db = pool) {
    const prs = await q<{ repo: string; source_branch: string; url: string }>(
      db,
      "SELECT repo, source_branch, url FROM pull_requests WHERE work_item_id = $1 ORDER BY id DESC",
      [id],
    );
    const worktrees = await q<{ repo: string; branch: string }>(
      db,
      `SELECT DISTINCT ON (w.repo) w.repo, w.branch
         FROM execution_workspaces w JOIN workflow_runs r ON r.id = w.run_id
        WHERE r.work_item_id = $1 AND w.subtask_id IS NULL
        ORDER BY w.repo, w.created_at DESC`,
      [id],
    );
    const branches: Record<string, string> = {};
    for (const w of worktrees) branches[w.repo] = w.branch;
    for (const p of [...prs].reverse()) branches[p.repo] = p.source_branch;
    return { branches, pull_requests: prs.map((p) => p.url).filter(Boolean) };
  },

  lockByCode(db: Db, code: string, ownerId: number) {
    return one<WorkItemRow>(
      db,
      "SELECT * FROM work_items WHERE code = $1 AND owner_id = $2 FOR UPDATE",
      [code, ownerId],
    );
  },

  async refreshImport(
    db: Db,
    id: number,
    input: {
      title: string;
      description: string;
      project: string;
      payload: unknown;
      externalId: string | null;
    },
  ) {
    const row = await one<WorkItemRow>(
      db,
      `UPDATE work_items SET title = $2, description = $3, project = $4, payload = $5,
         external_id = COALESCE($6, external_id), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, input.title, input.description, input.project, json(input.payload), input.externalId],
    );
    return row!;
  },

  async insertImport(db: Db, input: ImportInput, ownerId: number) {
    const row = await one<WorkItemRow>(
      db,
      `INSERT INTO work_items (code, source, external_key, external_id, title, description, project, payload, automation_policy, owner_id)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        input.code,
        input.source,
        input.externalId ?? null,
        input.title,
        input.description ?? "",
        input.project ?? "",
        json(input.payload ?? {}),
        json(input.automationPolicy ?? null),
        ownerId,
      ],
    );
    return row!;
  },

  update(id: number, patch: WorkItemPatch, db: Db = pool) {
    const keys = (
      ["title", "description", "project", "status", "automation_policy"] as const
    ).filter((key) => patch[key] !== undefined);
    if (!keys.length) return workItemRepository.get(id, db);
    const assignments = keys.map((key, i) => `${key} = $${i + 2}`);
    if (patch.description !== undefined) assignments.push("description_source = 'manual'");
    return one<WorkItemRow>(
      db,
      `UPDATE work_items SET ${assignments.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...keys.map((key) => (key === "automation_policy" ? json(patch[key]) : patch[key]))],
    );
  },

  async setBudget(id: number, budget: number | null, db: Db = pool) {
    await q(db, "UPDATE work_items SET budget_usd = $2, updated_at = now() WHERE id = $1", [
      id,
      budget,
    ]);
  },
};
