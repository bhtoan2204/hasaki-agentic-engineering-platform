-- Replay candidates belong to the current structural generation. The old attempt stays historical.
ALTER TABLE workflow_steps
  ADD COLUMN replay_source_attempt_id BIGINT REFERENCES workflow_step_attempts(id) ON DELETE SET NULL,
  ADD COLUMN replay_forced BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE workflow_step_attempts
  ADD COLUMN execution_fingerprint JSONB,
  ADD COLUMN reused_from_attempt_id BIGINT REFERENCES workflow_step_attempts(id) ON DELETE SET NULL;
