-- Intelligent AUTO chat: independent mode/provider strategies, effective selections, structured failures and attempts.
-- Additive only — migration 068 is unchanged; existing rows keep their previous mode/provider/model/effort.

ALTER TABLE chat_conversations
  DROP CONSTRAINT IF EXISTS chat_conversations_mode_check;
ALTER TABLE chat_conversations
  ADD CONSTRAINT chat_conversations_mode_check
  CHECK (mode IN ('AUTO', 'ASK', 'INVESTIGATE', 'PLAN', 'DELEGATE'));

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS provider_strategy TEXT NOT NULL DEFAULT 'manual'
    CHECK (provider_strategy IN ('auto', 'manual')),
  ADD COLUMN IF NOT EXISTS fallback_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS model_strategy TEXT NOT NULL DEFAULT 'manual'
    CHECK (model_strategy IN ('auto', 'provider_default', 'manual')),
  ADD COLUMN IF NOT EXISTS effort_strategy TEXT NOT NULL DEFAULT 'manual'
    CHECK (effort_strategy IN ('auto', 'provider_default', 'manual'));

-- Existing conversations stay manual; new chats default to AUTO mode + AUTO provider (application layer).
UPDATE chat_conversations SET provider_strategy = 'manual' WHERE provider_strategy IS NULL;

ALTER TABLE chat_turns
  ADD COLUMN IF NOT EXISTS requested_mode TEXT,
  ADD COLUMN IF NOT EXISTS effective_mode TEXT,
  ADD COLUMN IF NOT EXISTS provider_strategy TEXT,
  ADD COLUMN IF NOT EXISTS requested_provider TEXT,
  ADD COLUMN IF NOT EXISTS effective_provider TEXT,
  ADD COLUMN IF NOT EXISTS requested_model TEXT,
  ADD COLUMN IF NOT EXISTS effective_model TEXT,
  ADD COLUMN IF NOT EXISTS requested_effort TEXT,
  ADD COLUMN IF NOT EXISTS effective_effort TEXT,
  ADD COLUMN IF NOT EXISTS routing JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS phase TEXT,
  ADD COLUMN IF NOT EXISTS failure JSONB,
  ADD COLUMN IF NOT EXISTS attempts JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE chat_turns SET requested_mode = mode WHERE requested_mode IS NULL;
UPDATE chat_turns SET effective_mode = mode WHERE effective_mode IS NULL;
UPDATE chat_turns SET requested_provider = provider WHERE requested_provider IS NULL;
UPDATE chat_turns SET effective_provider = provider WHERE effective_provider IS NULL;
UPDATE chat_turns SET requested_model = model WHERE requested_model IS NULL;
UPDATE chat_turns SET effective_model = model WHERE effective_model IS NULL;
UPDATE chat_turns SET requested_effort = reasoning_effort WHERE requested_effort IS NULL;
UPDATE chat_turns SET effective_effort = reasoning_effort WHERE effective_effort IS NULL;
