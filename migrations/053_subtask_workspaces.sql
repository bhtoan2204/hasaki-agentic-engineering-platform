-- A concurrent coding subtask needs its own worktree. The run-level row (subtask_id NULL) stays the
-- integration target. Partial uniques keep one run workspace per repo and one workspace per subtask.
ALTER TABLE execution_workspaces ADD COLUMN subtask_id text;
ALTER TABLE execution_workspaces DROP CONSTRAINT execution_workspaces_run_id_repo_key;
CREATE UNIQUE INDEX execution_workspaces_run_repo
  ON execution_workspaces (run_id, repo) WHERE subtask_id IS NULL;
CREATE UNIQUE INDEX execution_workspaces_run_repo_subtask
  ON execution_workspaces (run_id, repo, subtask_id) WHERE subtask_id IS NOT NULL;
