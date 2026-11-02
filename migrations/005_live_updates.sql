-- Live UI updates: every workflow event (status change, transcript line, note) is announced on the
-- `workflow_events` channel; the server relays it to browsers over SSE. No polling of the database needed.
CREATE FUNCTION notify_workflow_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('workflow_events', json_build_object('run_id', NEW.run_id, 'step_id', NEW.step_id, 'attempt_id', NEW.attempt_id, 'id', NEW.id, 'kind', NEW.kind)::text);
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_events_notify AFTER INSERT ON workflow_events FOR EACH ROW EXECUTE FUNCTION notify_workflow_event();

-- Step mode: a job forced by the user may run while its run is PAUSED ("run this step now").
ALTER TABLE workflow_jobs ADD COLUMN force BOOLEAN NOT NULL DEFAULT false;
