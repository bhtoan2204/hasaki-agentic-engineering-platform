-- OpenAI Codex (CLI) becomes a third agent provider. Existing rows and the default stay on Claude.
-- 015 created the CHECK constraints inline, so they carry Postgres' generated names; replace them by name.
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_agent_provider_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_agent_provider_check
  CHECK (agent_provider IN ('claude', 'cursor', 'codex'));
ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_provider_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_provider_check
  CHECK (provider IN ('claude', 'cursor', 'codex'));
