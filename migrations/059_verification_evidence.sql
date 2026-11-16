-- Migration 059: verification evidence reuse (REQ-96). Additive only; scoped per run.
CREATE TABLE IF NOT EXISTS verification_evidence (
  id          BIGSERIAL PRIMARY KEY,
  run_id      BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_key    TEXT NOT NULL,
  attempt_id  BIGINT,
  repo        TEXT NOT NULL,
  key         TEXT NOT NULL,
  parts       JSONB NOT NULL,
  status      TEXT NOT NULL,
  result      JSONB NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_evidence_key_idx ON verification_evidence (run_id, repo, key);
CREATE INDEX IF NOT EXISTS verification_evidence_scope_idx ON verification_evidence (run_id, step_key, repo, created_at DESC);
