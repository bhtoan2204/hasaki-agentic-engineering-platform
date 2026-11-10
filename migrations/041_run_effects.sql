-- Durable post-commit work for a terminal run. The row is inserted in the same transaction as the
-- status change. A crash after COMMIT leaves it; workers claim it and delete it only after the
-- effect succeeds. Learning and memory stay idempotent and are never applied inside the run lock.
CREATE TABLE workflow_run_effects (
  run_id        BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('summary', 'outcome', 'memory', 'learning')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_until TIMESTAMPTZ,
  PRIMARY KEY (run_id, kind)
);

CREATE INDEX workflow_run_effects_pending ON workflow_run_effects (created_at, run_id);
