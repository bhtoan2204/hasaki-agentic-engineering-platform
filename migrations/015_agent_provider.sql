-- Which agent implementation a run uses. Chosen once at creation; retries, resume and repair keep it.
-- Existing rows stay on Claude. Session ids are namespaced so a Claude session is never resumed by Cursor.
ALTER TABLE workflow_runs ADD COLUMN agent_provider TEXT NOT NULL DEFAULT 'claude'
  CHECK (agent_provider IN ('claude', 'cursor'));
ALTER TABLE agent_sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'
  CHECK (provider IN ('claude', 'cursor'));
CREATE INDEX agent_sessions_provider ON agent_sessions(attempt_id, provider, id DESC);
