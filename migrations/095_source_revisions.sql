-- Source revision consistency: the base commit each repository of a run was pinned to by its first source-dependent
-- agent step ({repo: {branch, commit, checkout_head, remote_commit, fetched, pinned_at, step}}). Later steps compare
-- against it and new run worktrees start from it, so Analyze, Plan and Implement see one revision. NULL for runs
-- created before this migration (they keep the previous behaviour).
ALTER TABLE workflow_runs ADD COLUMN source_revisions JSONB;

ALTER TABLE execution_decisions DROP CONSTRAINT execution_decisions_kind_check;
ALTER TABLE execution_decisions ADD CONSTRAINT execution_decisions_kind_check CHECK (kind IN (
  'replay', 'recovery', 'resume', 'restore', 'reconcile',
  'verification_reuse', 'context_reuse', 'review_reuse', 'checkpoint', 'autonomy', 'investigation',
  'source_revision'
));
