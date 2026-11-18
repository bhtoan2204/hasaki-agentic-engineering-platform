-- Interactive Agent Chat: owner-scoped conversations, durable turns and messages, tool-call evidence and a replayable
-- event log. Workflow tables are unchanged; delegation links a conversation to the work item / run it created.
CREATE TABLE chat_conversations (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'ASK' CHECK (mode IN ('ASK', 'INVESTIGATE', 'PLAN', 'DELEGATE')),
  provider TEXT,
  model TEXT,
  reasoning_effort TEXT,
  repositories TEXT[] NOT NULL DEFAULT '{}',
  work_item_id BIGINT REFERENCES work_items(id) ON DELETE SET NULL,
  run_id BIGINT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  summary TEXT NOT NULL DEFAULT '',
  summary_through BIGINT NOT NULL DEFAULT 0,
  budget JSONB NOT NULL DEFAULT '{}'::jsonb,
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chat_conversations_owner_idx ON chat_conversations (owner_id, archived, updated_at DESC);

CREATE TABLE chat_turns (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_message_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'canceled')),
  mode TEXT NOT NULL,
  route TEXT,
  provider TEXT,
  model TEXT,
  reasoning_effort TEXT,
  worker_instance TEXT,
  regenerates BIGINT REFERENCES chat_turns(id) ON DELETE SET NULL,
  error TEXT,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, client_message_id)
);
-- One active turn per conversation: concurrent submissions cannot interleave history.
CREATE UNIQUE INDEX chat_turns_active_idx ON chat_turns (conversation_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX chat_turns_owner_idx ON chat_turns (owner_id, created_at DESC);

CREATE TABLE chat_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  turn_id BIGINT REFERENCES chat_turns(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  superseded BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_conversation_idx ON chat_messages (conversation_id, id);
-- At most one live assistant answer per turn; regeneration supersedes the old turn's answer.
CREATE UNIQUE INDEX chat_messages_turn_role_idx ON chat_messages (turn_id, role) WHERE turn_id IS NOT NULL;

CREATE TABLE chat_tool_calls (
  id BIGSERIAL PRIMARY KEY,
  turn_id BIGINT NOT NULL REFERENCES chat_turns(id) ON DELETE CASCADE,
  conversation_id BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  tool TEXT NOT NULL,
  arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error', 'denied', 'timeout')),
  result JSONB,
  -- Repositories the result was derived from: re-display is refused once the owner loses access.
  repositories TEXT[] NOT NULL DEFAULT '{}',
  evidence_ref TEXT,
  duration_ms DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (turn_id, seq)
);
CREATE INDEX chat_tool_calls_conversation_idx ON chat_tool_calls (conversation_id, id);

-- Replay log for the chat stream (SSE ids). Small bounded payloads, never one row per token.
CREATE TABLE chat_events (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  turn_id BIGINT REFERENCES chat_turns(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chat_events_conversation_idx ON chat_events (conversation_id, id);

CREATE OR REPLACE FUNCTION chat_events_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('chat_events', json_build_object(
    'id', NEW.id, 'conversation_id', NEW.conversation_id, 'owner_id', NEW.owner_id,
    'turn_id', NEW.turn_id, 'kind', NEW.kind)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER chat_events_notify AFTER INSERT ON chat_events
  FOR EACH ROW EXECUTE FUNCTION chat_events_notify();

CREATE TABLE chat_delegations (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preview_hash TEXT NOT NULL,
  work_item_id BIGINT REFERENCES work_items(id) ON DELETE SET NULL,
  run_id BIGINT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  package JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, preview_hash)
);
