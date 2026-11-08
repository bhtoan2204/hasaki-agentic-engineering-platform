-- Telegram identity, durable capabilities and delivery. No workflow state is duplicated here.
CREATE TABLE telegram_bindings (
 user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 bot_key text NOT NULL,
 telegram_user_id text NOT NULL UNIQUE,
 chat_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(bot_key,chat_id)
);
CREATE TABLE telegram_preferences (
 user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 approvals boolean NOT NULL DEFAULT true,
 questions boolean NOT NULL DEFAULT true,
 failures boolean NOT NULL DEFAULT true,
 completions boolean NOT NULL DEFAULT true,
 interactive boolean NOT NULL DEFAULT true,
 locale text NOT NULL DEFAULT 'vi' CHECK(locale IN ('vi','en'))
);
CREATE TABLE telegram_bind_tokens (
 token_hash text PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_key text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE telegram_actions (
 action_id text PRIMARY KEY,
 bot_key text NOT NULL,
 user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 telegram_user_id text NOT NULL,
 chat_id text NOT NULL,
 run_id bigint NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
 step_id bigint NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
 question_id bigint REFERENCES workflow_questions(id) ON DELETE CASCADE,
 attempt_id bigint REFERENCES workflow_step_attempts(id) ON DELETE CASCADE,
 step_generation integer NOT NULL,
 context_hash text NOT NULL,
 requires_confirmation boolean NOT NULL DEFAULT false,
 action_type text NOT NULL CHECK(action_type IN ('approve','confirm_approve','confirm_answer','reject','answer','reply','cancel')),
 option_value text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','consumed','canceled','expired')),
 locale text NOT NULL CHECK(locale IN ('vi','en')),
 message_id bigint,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 created_at timestamptz NOT NULL DEFAULT now(),
 consumed_at timestamptz
);
CREATE INDEX telegram_actions_pending ON telegram_actions(bot_key,expires_at) WHERE status='pending';
CREATE TABLE telegram_conversations (
 action_id text PRIMARY KEY REFERENCES telegram_actions(action_id) ON DELETE CASCADE,
 prompt_message_id bigint,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','canceled')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes'
);
CREATE TABLE telegram_consumers (
 bot_key text PRIMARY KEY,
 owner_id text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('polling','webhook')),
 epoch bigint NOT NULL DEFAULT 1,
 lease_until timestamptz NOT NULL,
 update_offset bigint NOT NULL DEFAULT 0
);
CREATE TABLE telegram_updates (
 bot_key text NOT NULL,
 update_id bigint NOT NULL,
 payload jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 processed_at timestamptz,
 processing_token text,
 processing_until timestamptz,
 failures integer NOT NULL DEFAULT 0,
 next_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(bot_key,update_id)
);
CREATE INDEX telegram_updates_pending ON telegram_updates(bot_key,update_id) WHERE processed_at IS NULL;
CREATE TABLE telegram_outbox (
 id bigserial PRIMARY KEY,
 bot_key text NOT NULL,
 dedupe_key text NOT NULL,
 user_id bigint REFERENCES users(id) ON DELETE CASCADE,
 method text NOT NULL CHECK(method IN ('sendMessage','editMessageText','editMessageReplyMarkup','answerCallbackQuery')),
 payload jsonb NOT NULL,
 action_ids text[] NOT NULL DEFAULT '{}',
 conversation_action_id text REFERENCES telegram_actions(action_id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','dead')),
 attempts integer NOT NULL DEFAULT 0,
 next_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(bot_key,dedupe_key)
);
CREATE INDEX telegram_outbox_pending ON telegram_outbox(bot_key,next_at,id) WHERE status='pending';
CREATE TABLE telegram_rate_limits (
 bot_key text NOT NULL,
 subject text NOT NULL,
 minute timestamptz NOT NULL,
 hits integer NOT NULL DEFAULT 1,
 PRIMARY KEY(bot_key,subject,minute)
);
