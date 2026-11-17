import { pool, q, one, type Db } from "../db/pool.ts";
import type { RunRow, StepRow } from "./types.ts";

export type OwnerScope = { ownerId?: number; all?: boolean };

type RunListRow = Pick<
  RunRow,
  | "id"
  | "definition_key"
  | "work_item_id"
  | "title"
  | "status"
  | "branch"
  | "selected_repositories"
  | "output_locale"
  | "agent_provider"
  | "owner_id"
  | "created_at"
  | "finished_at"
> & {
  updated_at: Date;
  definition_version: number;
  work_item_code: string | null;
  open_questions: number;
  steps: Array<Pick<StepRow, "key" | "status">> | null;
};

type RunQuestion = { id: number } & Record<string, unknown>;

type ApprovalInboxRow = {
  step_id: number;
  run_id: number;
  step_key: string;
  step_name: string;
  step_type: StepRow["type"];
  updated_at: Date;
  request: {
    message?: unknown;
    scope?: { risk?: unknown; gate?: { fix_risk?: unknown; missing?: unknown } };
    requires_risk_acknowledgement?: boolean;
    select_repositories?: unknown;
    ask_branch?: unknown;
  } | null;
  reexecute: string | null;
  provider_handoff: boolean | null;
  run_title: string;
  run_status: RunRow["status"];
  work_item_code: string | null;
};

export const stepsOf = (db: Db, runId: number) =>
  q<StepRow>(db, "SELECT * FROM workflow_steps WHERE run_id = $1 ORDER BY position", [runId]);

export function findRun(runId: number, db: Db = pool) {
  return one<RunRow>(db, "SELECT * FROM workflow_runs WHERE id = $1", [runId]);
}

export function latestRunForWorkItem(workItemId: number, db: Db = pool) {
  return one<Pick<RunRow, "id" | "status">>(
    db,
    "SELECT id, status FROM workflow_runs WHERE work_item_id = $1 ORDER BY id DESC LIMIT 1",
    [workItemId],
  );
}

export function activeRunForWorkItem(workItemId: number, db: Db = pool) {
  return one<Pick<RunRow, "id">>(
    db,
    "SELECT id FROM workflow_runs WHERE work_item_id = $1 AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELED') LIMIT 1",
    [workItemId],
  );
}

export function cancelableRunsForLegacyTask(workItemId: number, db: Db = pool) {
  return q<Pick<RunRow, "id">>(
    db,
    "SELECT id FROM workflow_runs WHERE work_item_id = $1 AND status NOT IN ('COMPLETED', 'CANCELED')",
    [workItemId],
  );
}

export function legacyRunQuestions(runId: number, db: Db = pool) {
  return q<{
    id: number;
    question: string;
    context: string;
    options: string[];
    answer: string | null;
  }>(
    db,
    "SELECT id, question, context, options, answer FROM workflow_questions WHERE run_id = $1 AND status <> 'dismissed' ORDER BY id",
    [runId],
  );
}

export async function setRunBudget(runId: number, budget: number | null, db: Db = pool) {
  await q(db, "UPDATE workflow_runs SET budget_usd = $2, updated_at = now() WHERE id = $1", [
    runId,
    budget,
  ]);
}

export function runAssignment(runId: number, db: Db = pool) {
  return one<Pick<RunRow, "worker_instance">>(
    db,
    "SELECT worker_instance FROM workflow_runs WHERE id = $1",
    [runId],
  );
}

export function findArtifact(id: number, db: Db = pool) {
  return one<Record<string, unknown>>(db, "SELECT * FROM workflow_artifacts WHERE id = $1", [id]);
}

export function handoffMetrics(runId: number, db: Db = pool) {
  return q<Record<string, unknown>>(
    db,
    "SELECT * FROM provider_handoff_metrics WHERE run_id=$1 ORDER BY id",
    [runId],
  );
}

export function listRuns(
  filter: {
    workItemId?: number;
    status?: string;
    limit?: number;
    ownerId?: number;
    all?: boolean;
  } = {},
  db: Db = pool,
) {
  return q<RunListRow>(
    db,
    `SELECT r.id, r.definition_key, r.work_item_id, r.title, r.status, r.branch, r.selected_repositories, r.output_locale, r.agent_provider, r.owner_id, r.created_at, r.updated_at, r.finished_at,
            v.version AS definition_version, w.code AS work_item_code,
            (SELECT count(*)::int FROM workflow_questions qq WHERE qq.run_id = r.id AND qq.status = 'open') AS open_questions,
            (SELECT json_agg(json_build_object('key', s.key, 'status', s.status) ORDER BY s.position) FROM workflow_steps s WHERE s.run_id = r.id) AS steps
       FROM workflow_runs r JOIN workflow_definition_versions v ON v.id = r.definition_version_id
       LEFT JOIN work_items w ON w.id = r.work_item_id
      WHERE ($1::bigint IS NULL OR r.work_item_id = $1) AND ($2::text IS NULL OR r.status = $2) AND (CASE WHEN $4::bool THEN r.owner_id IS NOT NULL WHEN $5::bigint IS NOT NULL THEN r.owner_id = $5 ELSE true END)
      ORDER BY r.id DESC LIMIT $3`,
    [
      filter.workItemId ?? null,
      filter.status ?? null,
      filter.limit ?? 100,
      !!filter.all,
      filter.ownerId || null,
    ],
  );
}

/** Independent reads are issued together on the pool. */
export async function loadRunDetail(runId: number) {
  const [run, steps, attempts, questions, artifacts, prs, workspaces, checkpoints] =
    await Promise.all([
      one<
        RunRow & {
          definition_version: number;
          wi_id: number | null;
          wi_code: string;
          wi_title: string;
          wi_source: string;
          wi_project: string;
        }
      >(
        pool,
        `SELECT r.*, v.version AS definition_version, w.id AS wi_id, w.code AS wi_code, w.title AS wi_title, w.source AS wi_source, w.project AS wi_project
         FROM workflow_runs r LEFT JOIN workflow_definition_versions v ON v.id = r.definition_version_id LEFT JOIN work_items w ON w.id = r.work_item_id
        WHERE r.id = $1`,
        [runId],
      ),
      stepsOf(pool, runId),
      q<Record<string, unknown>>(
        pool,
        `SELECT a.id, a.step_id, a.run_id, a.number, a.generation, a.status,
                a.agent_provider, a.agent_model, a.metrics, a.error,
                a.invalidated_at, a.resolved_at, a.started_at, a.finished_at,
                a.executor_stopped_at, a.context_snapshot_id, a.agent_session_id,
                CASE WHEN a.output ? 'verification'
                     THEN jsonb_build_object('verification', a.output->'verification') END AS output,
                s.key AS step_key
           FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id
          WHERE a.run_id = $1 ORDER BY a.id`,
        [runId],
      ),
      q<RunQuestion>(
        pool,
        "SELECT q.*, s.key AS step_key FROM workflow_questions q JOIN workflow_steps s ON s.id = q.step_id WHERE q.run_id = $1 ORDER BY q.id",
        [runId],
      ),
      q<Record<string, unknown>>(
        pool,
        "SELECT id, step_id, attempt_id, kind, name, length(content) AS size, data, created_at FROM workflow_artifacts WHERE run_id = $1 ORDER BY id",
        [runId],
      ),
      q<Record<string, unknown>>(
        pool,
        "SELECT * FROM pull_requests WHERE run_id = $1 ORDER BY id",
        [runId],
      ),
      q<Record<string, unknown>>(
        pool,
        "SELECT * FROM execution_workspaces WHERE run_id = $1 ORDER BY id",
        [runId],
      ),
      q<Record<string, unknown>>(
        pool,
        "SELECT id, step_id, attempt_id, reason, data, created_at FROM workflow_checkpoints WHERE run_id = $1 ORDER BY id",
        [runId],
      ),
    ]);
  return { run, steps, attempts, questions, artifacts, prs, workspaces, checkpoints };
}

/** Everything the step inspector shows for one step. */
export async function loadStepDetail(runId: number, stepKey: string) {
  // Every query addresses the step by (run, key) so all of them go out together.
  const sid = "(SELECT id FROM workflow_steps WHERE run_id = $1 AND key = $2)";
  const args = [runId, stepKey];
  const [step, attempts, questions, checkpoints, artifacts, sessions, snapshots, jobs, handoffs] =
    await Promise.all([
      one<StepRow>(pool, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", args),
      q<Record<string, unknown>>(
        pool,
        `SELECT * FROM workflow_step_attempts WHERE step_id = ${sid} ORDER BY number`,
        args,
      ),
      q<Record<string, unknown>>(
        pool,
        `SELECT * FROM workflow_questions WHERE step_id = ${sid} ORDER BY id`,
        args,
      ),
      q<Record<string, unknown>>(
        pool,
        `SELECT id, run_id, step_id, attempt_id, reason, data, created_at,
                execution - 'result' AS execution
           FROM workflow_checkpoints WHERE step_id = ${sid} ORDER BY id`,
        args,
      ),
      q<Record<string, unknown>>(
        pool,
        `SELECT id, attempt_id, kind, name, length(content) AS size, data, created_at FROM workflow_artifacts WHERE step_id = ${sid} ORDER BY id`,
        args,
      ),
      q<Record<string, unknown>>(
        pool,
        `SELECT s.* FROM agent_sessions s JOIN workflow_step_attempts a ON a.id = s.attempt_id WHERE a.step_id = ${sid} ORDER BY s.id`,
        args,
      ),
      q<Record<string, unknown>>(
        pool,
        `SELECT id, hash, content, created_at FROM context_snapshots WHERE step_id = ${sid} ORDER BY id`,
        args,
      ),
      q<Record<string, unknown>>(
        pool,
        `SELECT id, status, generation, available_at, lease_owner, lease_expires_at, claims, force, last_error FROM workflow_jobs WHERE step_id = ${sid} ORDER BY id DESC LIMIT 10`,
        args,
      ),
      q<Record<string, unknown>>(
        pool,
        `SELECT h.*,m.previous_attempt_duration_ms,m.handoff_duration_ms,m.new_attempt_duration_ms,m.retry_count,m.reported_cost_usd,m.final_verification_result FROM provider_handoffs h LEFT JOIN provider_handoff_metrics m ON m.id=h.id WHERE h.step_id=${sid} ORDER BY h.id`,
        args,
      ),
    ]);
  return { step, attempts, questions, checkpoints, artifacts, sessions, snapshots, jobs, handoffs };
}

export function openQuestions(db: Db = pool, scope?: OwnerScope) {
  return q<Record<string, unknown>>(
    db,
    `SELECT q.*, s.key AS step_key, s.name AS step_name, s.type AS step_type, r.title AS run_title, r.status AS run_status, w.code AS work_item_code
       FROM workflow_questions q JOIN workflow_steps s ON s.id = q.step_id JOIN workflow_runs r ON r.id = q.run_id
       LEFT JOIN work_items w ON w.id = r.work_item_id
      WHERE q.status = 'open' AND (CASE WHEN $1::bool THEN r.owner_id IS NOT NULL WHEN $2::bool THEN r.owner_id = $3::bigint ELSE true END) ORDER BY q.created_at`,
    [!!scope?.all, !!scope, scope?.ownerId ?? null],
  );
}

export function loadOpenApprovals(db: Db = pool, scope?: OwnerScope) {
  return q<ApprovalInboxRow>(
    db,
    `SELECT s.id AS step_id, s.run_id, s.key AS step_key, s.name AS step_name, s.type AS step_type, s.updated_at,
            s.approval->'request' AS request, s.config->'on_reject'->>'reexecute' AS reexecute,
            (s.pending_input ? 'provider_handoff') AS provider_handoff,
            r.title AS run_title, r.status AS run_status, w.code AS work_item_code
       FROM workflow_steps s JOIN workflow_runs r ON r.id = s.run_id
       LEFT JOIN work_items w ON w.id = r.work_item_id
      WHERE s.status = 'WAITING_APPROVAL' AND r.status NOT IN ('CANCELED', 'COMPLETED', 'FAILED') AND (CASE WHEN $1::bool THEN r.owner_id IS NOT NULL WHEN $2::bool THEN r.owner_id = $3::bigint ELSE true END)
      ORDER BY s.updated_at`,
    [!!scope?.all, !!scope, scope?.ownerId ?? null],
  );
}

export function answeredQuestions(limit = 100, db: Db = pool, scope?: OwnerScope) {
  return q<Record<string, unknown>>(
    db,
    `SELECT q.*, s.key AS step_key, s.name AS step_name, s.status AS step_status, r.title AS run_title
       FROM workflow_questions q JOIN workflow_steps s ON s.id = q.step_id JOIN workflow_runs r ON r.id = q.run_id
      WHERE q.status = 'answered' AND (CASE WHEN $2::bool THEN r.owner_id IS NOT NULL WHEN $3::bool THEN r.owner_id = $4::bigint ELSE true END) ORDER BY q.answered_at DESC LIMIT $1`,
    [limit, !!scope?.all, !!scope, scope?.ownerId ?? null],
  );
}
