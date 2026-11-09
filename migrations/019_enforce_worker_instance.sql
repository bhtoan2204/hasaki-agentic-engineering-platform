-- Enforce run pinning (018) in the database itself, so a platform instance still running older code (which does not
-- filter by worker_instance) cannot take another machine's job: it would run it without that machine's worktrees and
-- fail with "not an accessible worktree". Lease owners are "<instance>:<pid>:<nonce>:<lane>"; a claim (queued →
-- running) by any other instance is silently skipped (the UPDATE affects no row, so the claimer sees "no job").
CREATE OR REPLACE FUNCTION workflow_jobs_enforce_instance() RETURNS trigger AS $$
DECLARE
  pinned TEXT;
BEGIN
  IF NEW.status = 'running' AND OLD.status IS DISTINCT FROM 'running' THEN
    SELECT worker_instance INTO pinned FROM workflow_runs WHERE id = NEW.run_id;
    IF pinned IS NOT NULL AND split_part(coalesce(NEW.lease_owner, ''), ':', 1) <> pinned THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_jobs_enforce_instance ON workflow_jobs;
CREATE TRIGGER workflow_jobs_enforce_instance BEFORE UPDATE ON workflow_jobs
  FOR EACH ROW EXECUTE FUNCTION workflow_jobs_enforce_instance();
