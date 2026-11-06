-- Process sessions fence duplicate installations without changing run ownership.
CREATE TABLE platform_instances (
  instance_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  display_name TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- NULL owners need an explicit administrator decision: historical local files cannot safely be adopted.
CREATE OR REPLACE FUNCTION workflow_jobs_enforce_instance() RETURNS trigger AS $$
DECLARE pinned TEXT;
BEGIN
  IF NEW.status = 'running' AND OLD.status IS DISTINCT FROM 'running' THEN
    SELECT worker_instance INTO pinned FROM workflow_runs WHERE id = NEW.run_id;
    IF pinned IS NULL OR split_part(coalesce(NEW.lease_owner, ''), ':', 1) <> pinned THEN RETURN NULL; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
