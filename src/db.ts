import { pool } from "./db/pool.ts";

/**
 * Legacy (pre-workflow) tables: tasks, events, questions, prs, inbox, settings.
 * They are kept read-mostly for history and the backwards-compatible /api/tasks endpoints;
 * new execution state lives in the workflow_* tables (see src/workflow).
 */
const q = async <T = any>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows as T[];

export type TaskStatus = "queued" | "running" | "waiting_answer" | "review" | "idle" | "failed";

export interface TaskRow {
  code: string;
  work_id: number | null;
  name: string;
  project: string;
  payload: any;
  status: TaskStatus;
  session_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export const tasks = {
  async get(code: string) {
    return (await q<TaskRow>("SELECT * FROM tasks WHERE code = $1", [code]))[0];
  },
};

export const events = {
  list(code: string, afterId = 0) {
    return q("SELECT * FROM events WHERE task_code = $1 AND id > $2 ORDER BY id", [code, afterId]);
  },
};

export interface QuestionRow {
  id: string;
  task_code: string;
  question: string;
  context: string;
  options: string[];
  answer: string | null;
}

export const questions = {
  list(code: string) {
    return q<QuestionRow>("SELECT * FROM questions WHERE task_code = $1 ORDER BY id", [code]);
  },
};

export const prs = {
  list(code: string) {
    return q("SELECT * FROM prs WHERE task_code = $1 ORDER BY id", [code]);
  },
};

export const inbox = {
  async upsert(t: {
    workId: number;
    code: string;
    name: string;
    project: string;
    raw: unknown;
    ownerId: number;
  }) {
    await q(
      `INSERT INTO inbox (work_id, code, name, project, raw, owner_id) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (owner_id, work_id) WHERE owner_id IS NOT NULL DO UPDATE SET code = excluded.code, name = excluded.name, project = excluded.project,
         raw = excluded.raw, seen_at = now()`,
      [t.workId, t.code, t.name, t.project, JSON.stringify(t.raw), t.ownerId],
    );
  },
  list(ownerId: number) {
    return q(
      `SELECT i.work_id, i.code, i.name, i.project, i.picked, i.seen_at, w.id AS work_item_id, w.status AS work_item_status,
              (SELECT r.status FROM workflow_runs r WHERE r.work_item_id = w.id ORDER BY r.id DESC LIMIT 1) AS run_status
         FROM inbox i LEFT JOIN work_items w ON w.code = i.code AND w.owner_id = i.owner_id
        WHERE i.owner_id = $1
        ORDER BY i.seen_at DESC, i.work_id DESC LIMIT 200`,
      [ownerId],
    );
  },
  async markPicked(workId: number, ownerId: number) {
    await q("UPDATE inbox SET picked = true WHERE work_id = $1 AND owner_id = $2", [
      workId,
      ownerId,
    ]);
  },
  async unpicked(ownerId: number) {
    return q<{ work_id: string; code: string }>(
      "SELECT work_id, code FROM inbox WHERE NOT picked AND owner_id = $1 ORDER BY work_id",
      [ownerId],
    );
  },
};

export const settings = {
  async get(key: string) {
    return (
      (await q<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]))[0]?.value ||
      null
    );
  },
  async set(key: string, value: string) {
    await q(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  },
};
