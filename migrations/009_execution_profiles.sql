-- Adaptive execution: the profile a run was resolved with (FAST / STANDARD / DEEP) and why.
ALTER TABLE workflow_runs ADD COLUMN profile TEXT NOT NULL DEFAULT 'STANDARD' CHECK (profile IN ('FAST', 'STANDARD', 'DEEP'));
ALTER TABLE workflow_runs ADD COLUMN profile_decision JSONB;

-- Version-aware cache of Go test results on the base branch, keyed by repository and base commit SHA.
-- Survives restarts; a new base commit is a new key (never reused stale).
CREATE TABLE test_baselines (
  repo_key   TEXT NOT NULL,       -- git common dir of the repository
  base_sha   TEXT NOT NULL,
  package    TEXT NOT NULL,
  report     JSONB NOT NULL,      -- {status, tests[], buildErrors[]}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_key, base_sha, package)
);
