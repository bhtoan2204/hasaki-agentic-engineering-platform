-- Full agent transcript per attempt: prompts, thinking, assistant messages, tool calls and tool results.
-- Structured details (tool input, tool_use_id, cost, usage...) go to `data`; `content` stays human-readable.
ALTER TABLE workflow_events ADD COLUMN data JSONB;
CREATE INDEX workflow_events_attempt ON workflow_events(attempt_id, id) WHERE attempt_id IS NOT NULL;
