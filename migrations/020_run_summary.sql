-- Snapshot of "what this run did" (src/report/runSummary.ts), stored when the run finishes so the work item page can
-- show it even after the run's worktrees are cleaned up. Rebuilt on demand when missing or outdated.
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS summary JSONB;
