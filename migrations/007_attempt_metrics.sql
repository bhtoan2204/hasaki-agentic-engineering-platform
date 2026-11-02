-- Per-attempt observability: tokens, cost, turns, tool usage, skills loaded, integration calls, subagents, failures.
ALTER TABLE workflow_step_attempts ADD COLUMN metrics JSONB;
