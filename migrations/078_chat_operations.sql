-- Chat operations: a mutating integration call the model proposed and the owner must confirm before the platform runs
-- it. Additive. `unknown` = the outcome could not be determined (timeout): it blocks a repeat like a success does.
CREATE TABLE chat_operations (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  turn_id BIGINT REFERENCES chat_turns(id) ON DELETE SET NULL,
  tool TEXT NOT NULL,
  arguments JSON NOT NULL, -- json, not jsonb: the payload is replayed exactly as proposed (key order kept)
  target JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executing', 'succeeded', 'failed', 'unknown', 'rejected', 'expired', 'duplicate')),
  result JSONB,
  error TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chat_operations_conversation_idx ON chat_operations (conversation_id, id);
-- The same call by the same owner runs at most once (until a definite failure).
CREATE UNIQUE INDEX chat_operations_once_idx ON chat_operations (owner_id, idempotency_key)
  WHERE status IN ('executing', 'succeeded', 'unknown');
CREATE UNIQUE INDEX chat_operations_pending_idx ON chat_operations (conversation_id, idempotency_key)
  WHERE status = 'pending';

ALTER TABLE knowledge_proposals DROP CONSTRAINT IF EXISTS knowledge_proposals_source_kind_check;
ALTER TABLE knowledge_proposals ADD CONSTRAINT knowledge_proposals_source_kind_check
  CHECK (source_kind IN ('workflow', 'skill_evolution', 'repository_import', 'manual', 'failure_pattern', 'chat'));
