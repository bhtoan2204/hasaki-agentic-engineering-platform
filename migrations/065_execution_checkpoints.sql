-- Legacy checkpoint payloads and progress rows retain their existing shape.
ALTER TABLE workflow_checkpoints
  ADD COLUMN execution JSONB,
  ADD COLUMN execution_digest TEXT,
  ADD COLUMN workspace_artifact_id BIGINT REFERENCES workflow_artifacts(id) ON DELETE SET NULL,
  ADD CHECK ((execution IS NULL) = (execution_digest IS NULL)),
  ADD CHECK (execution IS NULL OR octet_length(execution::text) <= 262144);

CREATE UNIQUE INDEX workflow_checkpoints_executor_return
  ON workflow_checkpoints(attempt_id) WHERE reason = 'executor_returned';
CREATE INDEX workflow_checkpoints_executor_retention
  ON workflow_checkpoints(step_id, id DESC) WHERE reason = 'executor_returned';

CREATE INDEX workflow_artifacts_checkpoint_attempt
  ON workflow_artifacts(attempt_id, id DESC);
