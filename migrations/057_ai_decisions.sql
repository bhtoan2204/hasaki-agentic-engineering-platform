-- Recommendations only; existing workflow state and attempt fencing remain authoritative.
CREATE TABLE ai_decisions (
  id bigserial PRIMARY KEY,
  fingerprint text NOT NULL,
  run_id bigint NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id bigint REFERENCES workflow_steps(id) ON DELETE CASCADE,
  result jsonb NOT NULL,
  decision_type text NOT NULL,
  input_context jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_decisions_run ON ai_decisions(run_id, created_at);
CREATE INDEX ai_decisions_fingerprint ON ai_decisions(fingerprint, id DESC);
