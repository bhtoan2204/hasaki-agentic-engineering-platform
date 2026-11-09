-- Continuous quality improvement (additive; existing history untouched).
-- Verified outcome ladder per run: only states the platform can prove (see src/learning/outcomes.ts).
ALTER TABLE workflow_runs
  ADD COLUMN outcome jsonb,
  ADD COLUMN outcome_at timestamptz,
  -- Versions of the execution policies this run used (prompt, review, scope, context, outcome rules).
  ADD COLUMN policy_versions jsonb;
CREATE INDEX IF NOT EXISTS workflow_runs_outcome_at ON workflow_runs(outcome_at) WHERE outcome IS NOT NULL;

-- PR lifecycle synced from the provider: a merged PR is proof of merge, nothing else is.
ALTER TABLE pull_requests
  ADD COLUMN state text CHECK (state IS NULL OR state IN ('OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED')),
  ADD COLUMN merged_at timestamptz,
  ADD COLUMN merge_commit text,
  ADD COLUMN state_checked_at timestamptz;

-- Improvement proposals derived from repeated failure patterns go through the same human review queue.
ALTER TABLE knowledge_proposals DROP CONSTRAINT IF EXISTS knowledge_proposals_source_kind_check;
ALTER TABLE knowledge_proposals ADD CONSTRAINT knowledge_proposals_source_kind_check
  CHECK (source_kind IN ('workflow', 'skill_evolution', 'repository_import', 'manual', 'failure_pattern'));

-- Regression benchmark candidates from completed tasks: sanitized, pinned, and pending human review.
CREATE TABLE regression_case_candidates (
  id            bigserial PRIMARY KEY,
  run_id        bigint REFERENCES workflow_runs(id) ON DELETE SET NULL,
  work_item_id  bigint REFERENCES work_items(id) ON DELETE SET NULL,
  owner_id      bigint REFERENCES users(id),
  repository    text NOT NULL,
  base_commit   text NOT NULL CHECK (base_commit ~ '^[a-f0-9]{40}$'),
  fix_commit    text NOT NULL CHECK (fix_commit ~ '^[a-f0-9]{40}$'),
  requirement   text NOT NULL,
  acceptance    jsonb NOT NULL,
  safety        jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_comment text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, repository)
);
