import { pool } from "./db/pool.ts";
export { migrate } from "./db/migrate.ts";
export { pool };

/**
 * Legacy (pre-workflow) tables: tasks, events, questions, prs, inbox, settings.
 * They are kept read-mostly for history and the backwards-compatible /api/tasks endpoints;
 * new execution state lives in the workflow_* tables (see src/workflow).
 */
const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];

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
  list() {
    return q("SELECT code, name, project, status, error, created_at, updated_at FROM tasks ORDER BY updated_at DESC");
  },
  async upsert(code: string, workId: number | null, name: string, project: string, payload: unknown) {
    await q(
      `INSERT INTO tasks (code, work_id, name, project, payload, status) VALUES ($1, $2, $3, $4, $5, 'queued')
       ON CONFLICT (code) DO UPDATE SET work_id = excluded.work_id, name = excluded.name, project = excluded.project,
         payload = excluded.payload, updated_at = now()`,
      [code, workId, name, project, JSON.stringify(payload)],
    );
  },
  async setStatus(code: string, status: TaskStatus, error: string | null = null) {
    await q("UPDATE tasks SET status = $1, error = $2, updated_at = now() WHERE code = $3", [status, error, code]);
    await events.add(code, "status", error ? `${status}: ${error}` : status);
  },
  async setSession(code: string, sessionId: string) {
    await q("UPDATE tasks SET session_id = $1 WHERE code = $2", [sessionId, code]);
  },
};

export const events = {
  async add(code: string, kind: string, content: string) {
    await q("INSERT INTO events (task_code, kind, content) VALUES ($1, $2, $3)", [code, kind, content]);
  },
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
  async add(code: string, x: { question: string; context?: string; options?: string[] }) {
    await q("INSERT INTO questions (task_code, question, context, options) VALUES ($1, $2, $3, $4)", [
      code,
      x.question,
      x.context ?? "",
      JSON.stringify(x.options ?? []),
    ]);
  },
  list(code: string) {
    return q<QuestionRow>("SELECT * FROM questions WHERE task_code = $1 ORDER BY id", [code]);
  },
  open(code: string) {
    return q<QuestionRow>("SELECT * FROM questions WHERE task_code = $1 AND answer IS NULL ORDER BY id", [code]);
  },
  async answer(id: string, code: string, answer: string) {
    await q("UPDATE questions SET answer = $1, answered_at = now() WHERE id = $2 AND task_code = $3", [answer, id, code]);
  },
};

export const prs = {
  async upsert(p: { code: string; repo: string; branch: string; url: string; title: string; summary: string; decisions: unknown }) {
    await q(
      `INSERT INTO prs (task_code, repo, branch, url, title, summary, decisions) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (task_code, repo) DO UPDATE SET url = excluded.url, title = excluded.title,
         summary = excluded.summary, decisions = excluded.decisions, created_at = now()`,
      [p.code, p.repo, p.branch, p.url, p.title, p.summary, JSON.stringify(p.decisions)],
    );
  },
  list(code: string) {
    return q("SELECT * FROM prs WHERE task_code = $1 ORDER BY id", [code]);
  },
};

export const inbox = {
  async upsert(t: { workId: number; code: string; name: string; project: string; raw: unknown }) {
    await q(
      `INSERT INTO inbox (work_id, code, name, project, raw) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (work_id) DO UPDATE SET code = excluded.code, name = excluded.name, project = excluded.project,
         raw = excluded.raw, seen_at = now()`,
      [t.workId, t.code, t.name, t.project, JSON.stringify(t.raw)],
    );
  },
  list() {
    return q(
      `SELECT i.work_id, i.code, i.name, i.project, i.picked, i.seen_at, w.id AS work_item_id, w.status AS work_item_status,
              (SELECT r.status FROM workflow_runs r WHERE r.work_item_id = w.id ORDER BY r.id DESC LIMIT 1) AS run_status
         FROM inbox i LEFT JOIN work_items w ON w.code = i.code ORDER BY i.seen_at DESC, i.work_id DESC LIMIT 200`,
    );
  },
  async markPicked(workId: number) {
    await q("UPDATE inbox SET picked = true WHERE work_id = $1", [workId]);
  },
  async unpicked() {
    return q<{ work_id: string; code: string }>("SELECT work_id, code FROM inbox WHERE NOT picked ORDER BY work_id");
  },
};

export const settings = {
  async get(key: string) {
    return (await q<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]))[0]?.value || null;
  },
  async set(key: string, value: string) {
    await q("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);
  },
};
