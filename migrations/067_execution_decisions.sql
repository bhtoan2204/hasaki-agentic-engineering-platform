-- One row per replay, recovery or reuse decision, planned or applied, so the run view, trace and insights can show
-- what each step did and what it saved. Savings are estimates taken from the source attempt's reported telemetry.
CREATE TABLE execution_decisions (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id BIGINT REFERENCES workflow_steps(id) ON DELETE CASCADE,
  attempt_id BIGINT REFERENCES workflow_step_attempts(id) ON DELETE SET NULL,
  generation INT,
  kind TEXT NOT NULL CHECK (kind IN (
    'replay', 'recovery', 'resume', 'restore', 'reconcile',
    'verification_reuse', 'context_reuse', 'review_reuse', 'checkpoint'
  )),
  action TEXT NOT NULL CHECK (action IN (
    'REUSE', 'RESUME', 'RESTORE', 'VERIFY_ONLY', 'REEXECUTE', 'FORCE_REEXECUTE', 'RECONCILE',
    'SAFE_RETRY', 'REQUIRES_RECONCILIATION', 'HANDOFF', 'RECORD'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('planned', 'applied', 'rejected', 'failed')),
  reason TEXT NOT NULL DEFAULT '',
  source_attempt_id BIGINT REFERENCES workflow_step_attempts(id) ON DELETE SET NULL,
  latency_ms DOUBLE PRECISION,
  checkpoint_bytes BIGINT,
  saved_invocations DOUBLE PRECISION,
  saved_tokens DOUBLE PRECISION,
  saved_cost_usd DOUBLE PRECISION,
  saved_ms DOUBLE PRECISION,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX execution_decisions_run_idx ON execution_decisions (run_id, created_at);
CREATE INDEX execution_decisions_kind_idx ON execution_decisions (kind, created_at);
