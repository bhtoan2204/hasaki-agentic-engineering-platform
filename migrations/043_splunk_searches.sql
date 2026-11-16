-- Production incident investigation: every Splunk search is an audit record AND the durable evidence store.
-- Rows hold only sanitized, normalized events (credentials/PII redacted before insert). A repeated query of the
-- same run and window is answered from here (dedup), so an interrupted investigation resumes without re-searching.
-- Manual mode: a row is created as 'manual_pending' when Splunk is not reachable; the user pastes the results.
CREATE TABLE splunk_searches (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  run_id       BIGINT REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_key     TEXT,
  query        TEXT NOT NULL,
  query_hash   TEXT NOT NULL,
  earliest     TIMESTAMPTZ NOT NULL,
  latest       TIMESTAMPTZ NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('oneshot', 'job', 'export', 'manual')),
  status       TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'manual_pending')),
  auth         TEXT NOT NULL DEFAULT 'session' CHECK (auth IN ('session', 'token', 'shared_token', 'manual')),
  sid          TEXT,
  result_count INT,
  truncated    BOOLEAN NOT NULL DEFAULT false,
  duration_ms  INT,
  error        TEXT,
  events       JSONB NOT NULL DEFAULT '[]',
  messages     JSONB NOT NULL DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);

CREATE INDEX splunk_searches_run ON splunk_searches (run_id, query_hash) WHERE run_id IS NOT NULL;
CREATE INDEX splunk_searches_user ON splunk_searches (user_id, created_at DESC);
