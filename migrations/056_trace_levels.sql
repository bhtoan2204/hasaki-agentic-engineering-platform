-- Execution Trace Explorer: structured debug logs are workflow_events of kind 'trace' (kept apart from 'log', which
-- command output and provider handoffs read). Additive only, no rewrite or backfill. span/parent/duration/provider/event
-- live in data.trace (JSONB); only the level is a column so DEBUG retention and level filters stay cheap.
-- NULL level means INFO-equivalent (every pre-existing event).
ALTER TABLE workflow_events
  ADD COLUMN IF NOT EXISTS level TEXT CHECK (level IS NULL OR level IN ('DEBUG', 'INFO', 'WARN', 'ERROR'));
CREATE INDEX IF NOT EXISTS workflow_events_trace_logs ON workflow_events(run_id, id) WHERE kind = 'trace';
CREATE INDEX IF NOT EXISTS workflow_events_debug_created ON workflow_events(created_at) WHERE level = 'DEBUG';
