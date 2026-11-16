-- One active run per (repository, branch), across every instance sharing this database. A run takes the lease before
-- its first step that touches the worktree and keeps it until it is COMPLETED, FAILED or CANCELED; a later run on the
-- same branch waits in the queue instead of building on top of, or racing, the holder.
CREATE TABLE workflow_branch_leases (
  repo        TEXT NOT NULL,
  branch      TEXT NOT NULL,
  run_id      BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo, branch)
);
CREATE INDEX workflow_branch_leases_run ON workflow_branch_leases(run_id);
