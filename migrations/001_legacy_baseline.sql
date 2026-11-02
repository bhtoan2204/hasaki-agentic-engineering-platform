-- Baseline: the schema created by the pre-workflow migrate() (commit 8c23002). Idempotent on existing installs.
CREATE TABLE IF NOT EXISTS tasks (
  code        TEXT PRIMARY KEY,
  work_id     BIGINT,                  -- Hasaki Work task id (data.id)
  name        TEXT NOT NULL,
  project     TEXT NOT NULL DEFAULT '',
  payload     JSONB NOT NULL,          -- the task "data" object
  status      TEXT NOT NULL,           -- queued | running | waiting_answer | review | idle | failed
  session_id  TEXT,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
  id         BIGSERIAL PRIMARY KEY,
  task_code  TEXT NOT NULL REFERENCES tasks(code) ON DELETE CASCADE,
  kind       TEXT NOT NULL,            -- status | agent | tool | user | system
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_code, id);
CREATE TABLE IF NOT EXISTS questions (
  id          BIGSERIAL PRIMARY KEY,
  task_code   TEXT NOT NULL REFERENCES tasks(code) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  context     TEXT NOT NULL DEFAULT '',
  options     JSONB NOT NULL DEFAULT '[]',
  answer      TEXT,
  answered_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS prs (
  id         BIGSERIAL PRIMARY KEY,
  task_code  TEXT NOT NULL REFERENCES tasks(code) ON DELETE CASCADE,
  repo       TEXT NOT NULL,
  branch     TEXT NOT NULL,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  decisions  JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_code, repo)
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Tasks seen in the Hasaki Work list; picked = imported into the platform.
CREATE TABLE IF NOT EXISTS inbox (
  work_id    BIGINT PRIMARY KEY,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  project    TEXT NOT NULL DEFAULT '',
  raw        JSONB NOT NULL,
  picked     BOOLEAN NOT NULL DEFAULT false,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
