-- Several platform instances (one per developer machine) may share one database. A run's steps need that machine's
-- repositories, worktrees and agent login, so a run is pinned to the instance that created (or last restarted) it and
-- only that instance's workers claim its jobs. NULL (runs from before this column) = any instance may claim.
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS worker_instance TEXT;
