-- Workflow-driven platform core: work items, versioned workflow definitions, runs, steps, attempts,
-- durable jobs, checkpoints, questions, artifacts, context snapshots, sessions, workspaces, pull requests.
-- Additive only: legacy tables are untouched and backfilled into the new model.

-- ---------------------------------------------------------------- work items
CREATE TABLE work_items (
  id                BIGSERIAL PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,                 -- branch name convention (Hasaki task code / REQ-n / JIRA-1)
  source            TEXT NOT NULL CHECK (source IN ('manual', 'hasaki_work', 'jira', 'legacy')),
  external_key      TEXT,
  external_id       TEXT,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  project           TEXT NOT NULL DEFAULT '',
  payload           JSONB NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'archived')),
  automation_policy JSONB,                                -- null = never execute without an explicit user action
  legacy_task_code  TEXT REFERENCES tasks(code) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX work_items_external ON work_items(source, external_key) WHERE external_key IS NOT NULL;

-- ---------------------------------------------------------------- definitions
CREATE TABLE workflow_definitions (
  id             BIGSERIAL PRIMARY KEY,
  key            TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9_-]*$'),
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  draft_spec     JSONB,                                   -- editable; frozen into a version on publish
  latest_version INT NOT NULL DEFAULT 0,
  is_template    BOOLEAN NOT NULL DEFAULT false,
  archived       BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_definition_versions (
  id            BIGSERIAL PRIMARY KEY,
  definition_id BIGINT NOT NULL REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
  version       INT NOT NULL CHECK (version > 0),
  spec          JSONB NOT NULL,
  spec_hash     TEXT NOT NULL,
  change_note   TEXT NOT NULL DEFAULT '',
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (definition_id, version)
);

-- ---------------------------------------------------------------- runs & steps
CREATE TABLE workflow_runs (
  id                     BIGSERIAL PRIMARY KEY,
  definition_version_id  BIGINT NOT NULL REFERENCES workflow_definition_versions(id) ON DELETE RESTRICT,
  definition_key         TEXT NOT NULL,
  work_item_id           BIGINT REFERENCES work_items(id) ON DELETE SET NULL,
  title                  TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'PAUSED', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELED')),
  inputs                 JSONB NOT NULL DEFAULT '{}',
  graph                  JSONB NOT NULL,                  -- resolved execution graph, pinned at start
  allowed_repositories   TEXT[] NOT NULL DEFAULT '{}',
  selected_repositories  TEXT[] NOT NULL DEFAULT '{}',
  branch                 TEXT NOT NULL,
  error                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at             TIMESTAMPTZ,
  finished_at            TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (selected_repositories <@ allowed_repositories)
);
CREATE INDEX workflow_runs_work_item ON workflow_runs(work_item_id, id DESC);
CREATE INDEX workflow_runs_status ON workflow_runs(status);

CREATE TABLE workflow_steps (
  id                 BIGSERIAL PRIMARY KEY,
  run_id             BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  key                TEXT NOT NULL,
  type               TEXT NOT NULL CHECK (type IN ('agent', 'coding_agent', 'human_input', 'human_approval', 'integration', 'command', 'condition', 'git_pull_request')),
  name               TEXT NOT NULL,
  position           INT NOT NULL,
  depends_on         TEXT[] NOT NULL DEFAULT '{}',
  config             JSONB NOT NULL DEFAULT '{}',
  run_if             JSONB,
  requires_approval  BOOLEAN NOT NULL DEFAULT false,
  max_attempts       INT NOT NULL DEFAULT 1 CHECK (max_attempts > 0),
  retry_backoff_s    INT NOT NULL DEFAULT 5,
  status             TEXT NOT NULL CHECK (status IN ('PENDING', 'READY', 'RUNNING', 'WAITING_INPUT', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELED', 'SKIPPED')),
  generation         INT NOT NULL DEFAULT 1,              -- bumped on every invalidation / re-execution
  attempt_count      INT NOT NULL DEFAULT 0,              -- attempts within the current generation
  current_attempt_id BIGINT,
  output             JSONB,
  pending_input      JSONB,                               -- answers / feedback / overrides for the next attempt
  approval           JSONB,
  error              TEXT,
  ready_at           TIMESTAMPTZ,
  started_at         TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, key)
);
CREATE INDEX workflow_steps_status ON workflow_steps(status);

CREATE TABLE context_snapshots (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id    BIGINT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  content    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX context_snapshots_step ON context_snapshots(step_id, id);
CREATE FUNCTION context_snapshots_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'context_snapshots are immutable'; END $$;
CREATE TRIGGER context_snapshots_no_update BEFORE UPDATE ON context_snapshots
  FOR EACH ROW EXECUTE FUNCTION context_snapshots_immutable();

CREATE TABLE workflow_jobs (
  id               BIGSERIAL PRIMARY KEY,
  run_id           BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id          BIGINT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  generation       INT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'canceled')),
  available_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner      TEXT,
  lease_expires_at TIMESTAMPTZ,
  fencing_token    BIGINT NOT NULL DEFAULT 0,
  claims           INT NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workflow_jobs_queued ON workflow_jobs(available_at, id) WHERE status = 'queued';
CREATE INDEX workflow_jobs_leases ON workflow_jobs(lease_expires_at) WHERE status = 'running';
-- at most one live job per step
CREATE UNIQUE INDEX workflow_jobs_one_live ON workflow_jobs(step_id) WHERE status IN ('queued', 'running');

CREATE TABLE workflow_step_attempts (
  id                  BIGSERIAL PRIMARY KEY,
  step_id             BIGINT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  run_id              BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  number              INT NOT NULL,                       -- 1..n across all generations of the step
  generation          INT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'WAITING_INPUT', 'WAITING_APPROVAL', 'CANCELED', 'STALE')),
  job_id              BIGINT REFERENCES workflow_jobs(id) ON DELETE SET NULL,
  fencing_token       BIGINT,
  worker              TEXT,
  input               JSONB NOT NULL DEFAULT '{}',
  output              JSONB,
  context_snapshot_id BIGINT REFERENCES context_snapshots(id),
  agent_session_id    TEXT,
  workspace           JSONB,
  error               JSONB,
  invalidated_at      TIMESTAMPTZ,
  resolved_at         TIMESTAMPTZ,                        -- a WAITING_* attempt whose wait was answered
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  UNIQUE (step_id, number)
);
CREATE INDEX workflow_step_attempts_run ON workflow_step_attempts(run_id, id);
ALTER TABLE workflow_steps ADD CONSTRAINT workflow_steps_current_attempt
  FOREIGN KEY (current_attempt_id) REFERENCES workflow_step_attempts(id) ON DELETE SET NULL;

CREATE TABLE workflow_checkpoints (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id    BIGINT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  attempt_id BIGINT NOT NULL REFERENCES workflow_step_attempts(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,                               -- waiting_input | waiting_approval | progress
  data       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workflow_checkpoints_step ON workflow_checkpoints(step_id, id DESC);

CREATE TABLE workflow_questions (
  id               BIGSERIAL PRIMARY KEY,
  run_id           BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id          BIGINT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  attempt_id       BIGINT REFERENCES workflow_step_attempts(id) ON DELETE CASCADE,
  question         TEXT NOT NULL,
  context          TEXT NOT NULL DEFAULT '',
  options          JSONB NOT NULL DEFAULT '[]',
  suggested_answer TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'dismissed')),
  answer           TEXT,
  answered_by      TEXT,
  answered_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'answered') = (answer IS NOT NULL))
);
CREATE INDEX workflow_questions_open ON workflow_questions(created_at) WHERE status = 'open';
CREATE INDEX workflow_questions_step ON workflow_questions(step_id, id);

CREATE TABLE workflow_artifacts (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id    BIGINT REFERENCES workflow_steps(id) ON DELETE CASCADE,
  attempt_id BIGINT REFERENCES workflow_step_attempts(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                               -- log | report | diff | findings | ...
  name       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  data       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workflow_artifacts_run ON workflow_artifacts(run_id, id);

CREATE TABLE workflow_events (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id    BIGINT REFERENCES workflow_steps(id) ON DELETE CASCADE,
  attempt_id BIGINT REFERENCES workflow_step_attempts(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                               -- status | agent | tool | user | system
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workflow_events_run ON workflow_events(run_id, id);

CREATE TABLE agent_sessions (
  id          BIGSERIAL PRIMARY KEY,
  attempt_id  BIGINT NOT NULL REFERENCES workflow_step_attempts(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT '',
  resumable   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ
);
CREATE INDEX agent_sessions_attempt ON agent_sessions(attempt_id);

CREATE TABLE execution_workspaces (
  id           BIGSERIAL PRIMARY KEY,
  run_id       BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  repo         TEXT NOT NULL,
  branch       TEXT NOT NULL,
  path         TEXT NOT NULL,
  created_from TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, repo)
);

CREATE TABLE pull_requests (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL DEFAULT 'bitbucket',
  repo          TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  decisions     JSONB NOT NULL DEFAULT '[]',
  draft         BOOLEAN NOT NULL DEFAULT false,
  created       BOOLEAN NOT NULL DEFAULT false,         -- false = only a "create PR" link (no credentials)
  work_item_id  BIGINT REFERENCES work_items(id) ON DELETE SET NULL,
  run_id        BIGINT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  step_id       BIGINT REFERENCES workflow_steps(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, repo, source_branch, target_branch)
);

-- ---------------------------------------------------------------- backfill from legacy tables
INSERT INTO work_items (code, source, external_key, external_id, title, description, project, payload, legacy_task_code, created_at, updated_at)
SELECT t.code,
       CASE WHEN t.work_id IS NOT NULL THEN 'hasaki_work' ELSE 'legacy' END,
       t.code, t.work_id::text, t.name, COALESCE(t.payload->>'note', ''), t.project, t.payload, t.code,
       t.created_at, t.updated_at
  FROM tasks t
ON CONFLICT DO NOTHING;

INSERT INTO pull_requests (provider, repo, source_branch, target_branch, url, title, summary, decisions, created, work_item_id, created_at, updated_at)
SELECT 'bitbucket', p.repo, p.branch, 'release/prod', p.url, p.title, p.summary, p.decisions,
       p.url NOT LIKE '%/pull-requests/new?%', w.id, p.created_at, p.created_at
  FROM prs p LEFT JOIN work_items w ON w.legacy_task_code = p.task_code
ON CONFLICT DO NOTHING;
