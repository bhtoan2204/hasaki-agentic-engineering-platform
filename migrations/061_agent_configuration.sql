-- Inherited routing is captured once, before any agent step can be scheduled.
-- NULL identifies historical runs whose original defaults cannot be reconstructed automatically.
ALTER TABLE workflow_runs ADD COLUMN agent_configuration JSONB;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_agent_configuration_version
  CHECK (agent_configuration IS NULL OR
    (jsonb_typeof(agent_configuration) = 'object' AND agent_configuration->>'version' = '1'));
CREATE FUNCTION preserve_run_agent_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.agent_configuration IS NOT NULL AND NEW.agent_configuration IS DISTINCT FROM OLD.agent_configuration THEN
    RAISE EXCEPTION 'Run agent configuration is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_runs_agent_configuration_immutable
  BEFORE UPDATE OF agent_configuration ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION preserve_run_agent_configuration();
