-- Context Delivery Manifest: what a provider session has already received (per entry hash), so a resumed session gets
-- only new or changed context. Append-only; the latest row per (provider, session) is the session's state. Additive.
CREATE TABLE agent_context_deliveries (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  attempt_id BIGINT REFERENCES workflow_step_attempts(id) ON DELETE CASCADE,
  system_hash TEXT NOT NULL,
  decisions_hash TEXT NOT NULL,
  entries JSONB NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('full', 'delta')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_context_deliveries_session_idx ON agent_context_deliveries (provider, session_id, id DESC);
