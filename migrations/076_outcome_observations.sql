-- Append-only outcome observations with provenance. The run outcome ladder (workflow_runs.outcome) stays the derived
-- summary; these rows are the evidence it and the learning loop are built from: one row per distinct observed fact,
-- deduplicated by an immutable source reference, corrections append a row that supersedes an earlier one (never delete).
CREATE TABLE outcome_observations (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'run_completed', 'run_failed', 'run_canceled', 'tests_passed', 'tests_failed', 'review_passed', 'review_failed',
    'pr_opened', 'pr_ci_failed', 'pr_changes_requested', 'pr_ready', 'pr_merged', 'pr_closed',
    'regression_reported', 'rollback_reported', 'human_feedback'
  )),
  -- platform: derived from the run's own records; provider: read from the Git host; manual: entered by a person.
  source_type TEXT NOT NULL CHECK (source_type IN ('platform', 'provider', 'manual')),
  source_ref TEXT NOT NULL,
  run_id BIGINT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  work_item_id BIGINT REFERENCES work_items(id) ON DELETE SET NULL,
  owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  repo TEXT,
  commit_sha TEXT,
  policy_versions JSONB,
  verified BOOLEAN NOT NULL DEFAULT false,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL,
  recorded_by TEXT NOT NULL DEFAULT 'platform',
  supersedes BIGINT REFERENCES outcome_observations(id) ON DELETE SET NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_ref)
);
CREATE INDEX outcome_observations_run ON outcome_observations (run_id, kind);
CREATE INDEX outcome_observations_work_item ON outcome_observations (work_item_id, observed_at);
CREATE INDEX outcome_observations_owner ON outcome_observations (owner_id, observed_at DESC);
