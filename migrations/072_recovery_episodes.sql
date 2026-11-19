-- One recovery episode per (run, step, failure signature): restart-safe counters that a new attempt or generation does
-- not reset, the strategies tried, the evidence fingerprint seen last and when the next automatic try is due.
CREATE TABLE recovery_episodes (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id BIGINT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'escalated', 'stopped')),
  occurrences INT NOT NULL DEFAULT 0,
  auto_recoveries INT NOT NULL DEFAULT 0,
  strategies JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_generation INT,
  last_attempt_id BIGINT REFERENCES workflow_step_attempts(id) ON DELETE SET NULL,
  last_fingerprint TEXT,
  next_eligible_at TIMESTAMPTZ,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT NOT NULL DEFAULT '',
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_id, signature)
);
CREATE INDEX recovery_episodes_run_idx ON recovery_episodes (run_id, updated_at);

ALTER TABLE execution_decisions DROP CONSTRAINT execution_decisions_action_check;
ALTER TABLE execution_decisions ADD CONSTRAINT execution_decisions_action_check CHECK (action IN (
  'REUSE', 'RESUME', 'RESTORE', 'VERIFY_ONLY', 'REEXECUTE', 'FORCE_REEXECUTE', 'RECONCILE',
  'SAFE_RETRY', 'REQUIRES_RECONCILIATION', 'HANDOFF', 'RECORD',
  'ALLOW', 'DENY', 'REQUIRE_HUMAN', 'COLLECT_EVIDENCE', 'REPLAN',
  'RETRY_BACKOFF', 'REPAIR', 'WAIT', 'STOP'
));
