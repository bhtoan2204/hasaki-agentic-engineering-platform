-- Lookups that are not covered by the primary key or an existing index.
-- Resume reads the latest checkpoint of an attempt; progress notes read that attempt's rows in id order.
CREATE INDEX IF NOT EXISTS workflow_checkpoints_attempt ON workflow_checkpoints (attempt_id, id DESC);
-- Lease recovery and the scheduler join a running attempt back to its job.
CREATE INDEX IF NOT EXISTS workflow_step_attempts_job ON workflow_step_attempts (job_id);
