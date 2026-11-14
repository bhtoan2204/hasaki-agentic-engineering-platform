-- Additive compatibility artifact. Applied only by normal deployment/test-owned migration flows.
ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_profile_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_profile_check CHECK (profile IN ('MICRO', 'FAST', 'STANDARD', 'DEEP'));
