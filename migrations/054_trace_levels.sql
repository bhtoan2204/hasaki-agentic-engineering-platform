-- Execution Trace Explorer: structured debug logs reuse workflow_events (kind 'log'). Additive only, no rewrite or
-- backfill. span/parent/duration/provider/event live in data.trace (JSONB); only the level is a column so DEBUG
-- retention and level filters stay cheap. NULL level means INFO-equivalent (every pre-existing event).
ALTER TABLE workflow_events
  ADD COLUMN level TEXT CHECK (level IS NULL OR level IN ('DEBUG', 'INFO', 'WARN', 'ERROR'));
CREATE INDEX workflow_events_trace_logs ON workflow_events(run_id, id) WHERE level IS NOT NULL;
