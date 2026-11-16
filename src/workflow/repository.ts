import { pool, q, one, type Db } from "../db/pool.ts";
import type { JobRow, RunRow, StepRow } from "./types.ts";
export type { JobRow };

export interface RunListFilter {
  workItemId?: number;
  status?: string;
  limit?: number;
  ownerId?: number;
  all?: boolean;
}

export const workflowRepository = {
  async findStepType(stepId: number, db: Db = pool): Promise<string | undefined> {
    const row = await one<{ type: string }>(db, "SELECT type FROM workflow_steps WHERE id = $1", [
      stepId,
    ]);
    return row?.type;
  },

  claimNextJob(
    workerId: string,
    leaseSeconds: number,
    onlyTypes: string[] | null,
    instanceId: string,
    instanceSession: string,
    db: Db = pool,
  ): Promise<JobRow | undefined> {
    return one<JobRow>(
      db,
      `UPDATE workflow_jobs j
          SET status = 'running', lease_owner = $1, lease_expires_at = now() + make_interval(secs => $2),
              fencing_token = j.fencing_token + 1, claims = j.claims + 1, updated_at = now()
        WHERE j.id = (
          SELECT j2.id FROM workflow_jobs j2 JOIN workflow_runs r ON r.id = j2.run_id JOIN workflow_steps s ON s.id = j2.step_id
           WHERE j2.status = 'queued' AND j2.available_at <= now()
             AND (r.status NOT IN ('PAUSED', 'CANCELED', 'PENDING') OR (r.status = 'PAUSED' AND j2.force))
             AND ($3::text[] IS NULL OR s.type = ANY($3))
             AND r.worker_instance = $4
             AND NOT EXISTS (SELECT 1 FROM platform_instances i WHERE i.instance_id = $4 AND (i.session_id <> $5 OR i.stopped_at IS NOT NULL))
           ORDER BY j2.available_at, j2.id
           FOR UPDATE OF j2 SKIP LOCKED LIMIT 1)
        RETURNING j.*`,
      [workerId, leaseSeconds, onlyTypes ?? null, instanceId, instanceSession],
    );
  },

  getSchedulerStatusRunning(db: Db = pool) {
    return q(
      db,
      `SELECT j.id AS job_id, j.run_id, r.title AS run_title, s.key AS step_key, s.name AS step_name, s.type AS step_type, j.lease_owner,
              a.started_at, extract(epoch FROM now() - a.started_at)::int AS running_seconds
         FROM workflow_jobs j JOIN workflow_steps s ON s.id = j.step_id JOIN workflow_runs r ON r.id = j.run_id
         LEFT JOIN workflow_step_attempts a ON a.job_id = j.id AND a.status = 'RUNNING'
        WHERE j.status = 'running' ORDER BY j.id`,
    );
  },

  getSchedulerStatusQueued(db: Db = pool) {
    return q(
      db,
      `SELECT j.id AS job_id, j.run_id, s.key AS step_key, s.type AS step_type, j.available_at, r.worker_instance
         FROM workflow_jobs j JOIN workflow_steps s ON s.id = j.step_id JOIN workflow_runs r ON r.id = j.run_id
        WHERE j.status = 'queued' AND r.status NOT IN ('PAUSED', 'CANCELED', 'PENDING') ORDER BY j.available_at, j.id`,
    );
  },

  recordExecutorTermination(attemptId: number, fencingToken: number, db: Db = pool): Promise<void> {
    return q(
      db,
      "UPDATE workflow_step_attempts SET executor_stopped_at=COALESCE(executor_stopped_at,now()) WHERE id=$1 AND fencing_token=$2",
      [attemptId, fencingToken],
    ).then(() => {});
  },

  updateJobHeartbeat(jobId: number, leaseSeconds: number, db: Db = pool): Promise<void> {
    return q(
      db,
      "UPDATE workflow_jobs SET lease_expires_at = now() + make_interval(secs => $2), updated_at = now() WHERE id = $1 AND status = 'running'",
      [jobId, leaseSeconds],
    ).then(() => {});
  },

  finishJob(jobId: number, db: Db = pool): Promise<void> {
    return q(
      db,
      "UPDATE workflow_jobs SET status = 'completed', updated_at = now() WHERE id = $1",
      [jobId],
    ).then(() => {});
  },

  findArtifactById(id: number, db: Db = pool) {
    return one<any>(db, "SELECT * FROM workflow_artifacts WHERE id = $1", [id]);
  },

  findArtifactByIdAndRun(id: number, runId: number, kind?: string, db: Db = pool) {
    return one<any>(
      db,
      "SELECT content FROM workflow_artifacts WHERE id = $1 AND run_id = $2 AND ($3::text IS NULL OR kind = $3)",
      [id, runId, kind ?? null],
    );
  },

  async getRunOutcome(runId: number, db: Db = pool): Promise<string | undefined> {
    const row = await one<{ outcome?: string }>(
      db,
      "SELECT outcome FROM workflow_runs WHERE id = $1",
      [runId],
    );
    return row?.outcome;
  },

  updateRunBudget(runId: number, budgetUsd: number | null, db: Db = pool): Promise<void> {
    return q(db, "UPDATE workflow_runs SET budget_usd = $2, updated_at = now() WHERE id = $1", [
      runId,
      budgetUsd,
    ]).then(() => {});
  },

  getProviderHandoffMetrics(runId: number, db: Db = pool) {
    return q(db, "SELECT * FROM provider_handoff_metrics WHERE run_id = $1 ORDER BY id", [runId]);
  },

  async getRunWorkerInstance(runId: number, db: Db = pool): Promise<string | null | undefined> {
    const row = await one<{ worker_instance: string | null }>(
      db,
      "SELECT worker_instance FROM workflow_runs WHERE id = $1",
      [runId],
    );
    return row ? row.worker_instance : undefined;
  },

  async getRunExecutionMetrics(runId: number, db: Db = pool) {
    const [attempts, toolRows, [run], telemetry] = await Promise.all([
      q<any>(
        db,
        `SELECT a.id, a.agent_provider, a.agent_model, a.effective_agent, s.key AS step_key, s.type AS step_type, a.number, a.status, a.started_at, a.finished_at, a.resolved_at, a.metrics,
              (extract(epoch FROM (COALESCE(a.finished_at, now()) - a.started_at)) * 1000)::bigint AS exec_ms,
              GREATEST(0, (extract(epoch FROM (a.started_at - GREATEST(j.available_at, j.created_at))) * 1000))::bigint AS queue_ms,
              CASE WHEN a.status IN ('WAITING_INPUT', 'WAITING_APPROVAL') OR a.resolved_at IS NOT NULL
                   THEN (extract(epoch FROM (COALESCE(a.resolved_at, now()) - a.finished_at)) * 1000)::bigint ELSE 0 END AS human_ms
         FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id LEFT JOIN workflow_jobs j ON j.id = a.job_id
        WHERE a.run_id = $1 ORDER BY a.id`,
        [runId],
      ),
      q<any>(
        db,
        `SELECT t.attempt_id, t.data->>'name' AS name, (extract(epoch FROM (r.created_at - t.created_at)) * 1000)::bigint AS ms
         FROM workflow_events t JOIN workflow_events r ON r.attempt_id = t.attempt_id AND r.kind = 'tool_result' AND r.data->>'tool_use_id' = t.data->>'id'
        WHERE t.run_id = $1 AND t.kind = 'tool'`,
        [runId],
      ),
      q<any>(
        db,
        "SELECT created_at, started_at, finished_at, status, profile, profile_decision, agent_provider FROM workflow_runs WHERE id = $1",
        [runId],
      ),
      q<any>(
        db,
        "SELECT * FROM execution_attempt_telemetry WHERE run_id = $1 ORDER BY attempt_id",
        [runId],
      ),
    ]);
    return { attempts, toolRows, run, telemetry };
  },

  listRuns(filter: RunListFilter = {}, db: Db = pool) {
    const scope = filter.all
      ? "AND r.owner_id IS NOT NULL"
      : filter.ownerId
        ? "AND r.owner_id = " + Number(filter.ownerId)
        : "";
    return q(
      db,
      `SELECT r.id, r.definition_key, r.work_item_id, r.title, r.status, r.branch, r.selected_repositories, r.output_locale, r.agent_provider, r.owner_id, r.created_at, r.updated_at, r.finished_at,
              v.version AS definition_version, w.code AS work_item_code,
              (SELECT count(*)::int FROM workflow_questions qq WHERE qq.run_id = r.id AND qq.status = 'open') AS open_questions,
              (SELECT json_agg(json_build_object('key', s.key, 'status', s.status) ORDER BY s.position) FROM workflow_steps s WHERE s.run_id = r.id) AS steps
         FROM workflow_runs r JOIN workflow_definition_versions v ON v.id = r.definition_version_id
         LEFT JOIN work_items w ON w.id = r.work_item_id
        WHERE ($1::bigint IS NULL OR r.work_item_id = $1) AND ($2::text IS NULL OR r.status = $2) ${scope}
        ORDER BY r.id DESC LIMIT $3`,
      [filter.workItemId ?? null, filter.status ?? null, filter.limit ?? 100],
    );
  },

  findRunById(id: number, db: Db = pool) {
    return one<RunRow>(db, "SELECT * FROM workflow_runs WHERE id = $1", [id]);
  },

  findRunForUpdate(id: number, db: Db = pool) {
    return one<RunRow>(db, "SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE", [id]);
  },

  findRunDetail(runId: number, db: Db = pool) {
    return Promise.all([
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
        db,
        `SELECT r.*, v.version AS definition_version, w.id AS wi_id, w.code AS wi_code, w.title AS wi_title, w.source AS wi_source, w.project AS wi_project
         FROM workflow_runs r LEFT JOIN workflow_definition_versions v ON v.id = r.definition_version_id LEFT JOIN work_items w ON w.id = r.work_item_id
        WHERE r.id = $1`,
        [runId],
      ),
      q<StepRow>(db, "SELECT * FROM workflow_steps WHERE run_id = $1 ORDER BY position", [runId]),
      q<any>(
        db,
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
      q<any>(
        db,
        "SELECT q.*, s.key AS step_key FROM workflow_questions q JOIN workflow_steps s ON s.id = q.step_id WHERE q.run_id = $1 ORDER BY q.id",
        [runId],
      ),
      q<any>(
        db,
        "SELECT id, step_id, attempt_id, kind, name, length(content) AS size, data, created_at FROM workflow_artifacts WHERE run_id = $1 ORDER BY id",
        [runId],
      ),
      q<any>(db, "SELECT * FROM pull_requests WHERE run_id = $1 ORDER BY id", [runId]),
      q<any>(db, "SELECT * FROM execution_workspaces WHERE run_id = $1 ORDER BY id", [runId]),
      q<any>(
        db,
        "SELECT id, step_id, attempt_id, reason, data, created_at FROM workflow_checkpoints WHERE run_id = $1 ORDER BY id",
        [runId],
      ),
    ]);
  },

  async findOpenQuestionsCount(attemptId: number, db: Db = pool): Promise<number> {
    const row = await one<{ n: number }>(
      db,
      "SELECT count(*)::int AS n FROM workflow_questions WHERE attempt_id = $1 AND status = 'open'",
      [attemptId],
    );
    return row?.n ?? 0;
  },
};
