-- Run branches are shared across runs: the commit a removed worktree had checked out, so its changes stay readable.
ALTER TABLE execution_workspaces ADD COLUMN removed_head text;
