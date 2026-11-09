-- Migration 036: Add Google Antigravity as a first-class agent provider

-- 1. workflow_runs
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_agent_provider_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_agent_provider_check
  CHECK (agent_provider IN ('claude', 'cursor', 'codex', 'antigravity'));

-- 2. agent_sessions
ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_provider_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_provider_check
  CHECK (provider IN ('claude', 'cursor', 'codex', 'antigravity'));

-- 3. workflow_step_attempts
ALTER TABLE workflow_step_attempts DROP CONSTRAINT IF EXISTS workflow_step_attempts_agent_provider_check;
ALTER TABLE workflow_step_attempts ADD CONSTRAINT workflow_step_attempts_agent_provider_check
  CHECK (agent_provider IN ('claude', 'codex', 'cursor', 'antigravity'));

-- 4. evaluation_provider_phases
ALTER TABLE evaluation_provider_phases DROP CONSTRAINT IF EXISTS evaluation_provider_phases_provider_check;
ALTER TABLE evaluation_provider_phases ADD CONSTRAINT evaluation_provider_phases_provider_check
  CHECK (provider IN ('claude', 'codex', 'cursor', 'antigravity'));
