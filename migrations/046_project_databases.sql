-- Read-only QC databases per project, queried by agents through the platform tool bridge (MCP call_tool:
-- database.list / database.schema / database.query). Admin-managed shared configuration.
-- The password is never stored here: it is in shared_secrets (kind 'database:<key>'), encrypted with AUTH_SECRET.
-- Who may query: a run whose repository scope (already limited to the owner's own repository access) contains one
-- of `repositories`, or a repository mapped to `project`. Nothing else widens it.
CREATE TABLE project_databases (
  id              BIGSERIAL PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  project         TEXT NOT NULL DEFAULT '',
  repositories    TEXT[] NOT NULL DEFAULT '{}',
  environment     TEXT NOT NULL DEFAULT 'qc' CHECK (environment IN ('qc', 'dev', 'staging')),
  engine          TEXT NOT NULL DEFAULT 'mysql' CHECK (engine IN ('mysql')),
  host            TEXT NOT NULL,
  port            INT NOT NULL DEFAULT 3306 CHECK (port BETWEEN 1 AND 65535),
  database_name   TEXT NOT NULL,
  username        TEXT NOT NULL,
  ssl             BOOLEAN NOT NULL DEFAULT false,
  description     TEXT NOT NULL DEFAULT '',
  max_rows        INT NOT NULL DEFAULT 200 CHECK (max_rows BETWEEN 1 AND 1000),
  timeout_ms      INT NOT NULL DEFAULT 15000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (project <> '' OR cardinality(repositories) > 0)
);

CREATE TRIGGER project_databases_cache AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON project_databases
  FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
