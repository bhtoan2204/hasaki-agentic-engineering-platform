-- Iterative production investigation: one decision per round (continue / stop, with the round telemetry). The round
-- state itself is an immutable workflow artifact (kind investigation_round); no new table is needed.
ALTER TABLE execution_decisions DROP CONSTRAINT execution_decisions_kind_check;
ALTER TABLE execution_decisions ADD CONSTRAINT execution_decisions_kind_check CHECK (kind IN (
  'replay', 'recovery', 'resume', 'restore', 'reconcile',
  'verification_reuse', 'context_reuse', 'review_reuse', 'checkpoint', 'autonomy', 'investigation'
));
CREATE INDEX workflow_artifacts_investigation_round ON workflow_artifacts (run_id, id) WHERE kind = 'investigation_round';
