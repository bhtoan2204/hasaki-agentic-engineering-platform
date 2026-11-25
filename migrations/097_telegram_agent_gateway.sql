-- Telegram Agent Gateway: Telegram as a transport for the existing Chat Runtime, run operations and notifications.
-- No chat, workflow or policy state is duplicated: conversations, turns, operations and runs stay in their own tables.

-- The conversation a private Telegram chat currently talks to (one per user and bot). delivered_turn_id is the
-- delivery cursor: every finished turn of the linked conversation above it is sent to Telegram exactly once.
CREATE TABLE telegram_chat_links (
 user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 bot_key text NOT NULL,
 conversation_id bigint REFERENCES chat_conversations(id) ON DELETE SET NULL,
 delivered_turn_id bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);

-- Messages the bot sent, so a reply to one of them reaches the right conversation/run and status messages can be
-- edited in place. Written by the outbox after Telegram returned the message id.
CREATE TABLE telegram_messages (
 bot_key text NOT NULL,
 chat_id text NOT NULL,
 message_id bigint NOT NULL,
 user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('turn_status','answer','operation','run_status','notice')),
 conversation_id bigint REFERENCES chat_conversations(id) ON DELETE CASCADE,
 turn_id bigint REFERENCES chat_turns(id) ON DELETE CASCADE,
 run_id bigint REFERENCES workflow_runs(id) ON DELETE CASCADE,
 last_text_hash text,
 edited_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (bot_key, chat_id, message_id)
);
CREATE INDEX telegram_messages_turn ON telegram_messages (turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX telegram_messages_run ON telegram_messages (user_id, run_id) WHERE run_id IS NOT NULL;

ALTER TABLE telegram_outbox ADD COLUMN link jsonb;

-- Buttons for chat-proposed operations and delegations. The decision itself is made by the existing services
-- (decideOperation, executeDelegation); this row only binds a button to one user, chat, message and expiry.
CREATE TABLE telegram_chat_actions (
 action_id text PRIMARY KEY,
 bot_key text NOT NULL,
 user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 telegram_user_id text NOT NULL,
 chat_id text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('operation','delegation')),
 conversation_id bigint NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
 turn_id bigint REFERENCES chat_turns(id) ON DELETE CASCADE,
 ref_id bigint,
 payload jsonb NOT NULL DEFAULT '{}',
 protected boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','armed','consumed','canceled','expired')),
 locale text NOT NULL CHECK (locale IN ('vi','en')),
 message_id bigint,
 result jsonb,
 expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
 created_at timestamptz NOT NULL DEFAULT now(),
 decided_at timestamptz
);
CREATE INDEX telegram_chat_actions_pending ON telegram_chat_actions (bot_key, expires_at) WHERE status IN ('pending','armed');
CREATE UNIQUE INDEX telegram_chat_actions_ref ON telegram_chat_actions (bot_key, kind, conversation_id, ref_id) WHERE ref_id IS NOT NULL;
ALTER TABLE telegram_outbox ADD COLUMN chat_action_ids text[] NOT NULL DEFAULT '{}';

-- Run snapshots for state-diff notifications and the editable per-run status message.
CREATE TABLE telegram_run_watch (
 user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 run_id bigint NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
 state jsonb NOT NULL DEFAULT '{}',
 watched boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (user_id, run_id)
);

-- Notification buffer: deduplicated per user, aggregated into one message per flush window, held during quiet hours.
CREATE TABLE telegram_notifications (
 id bigserial PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL,
 severity text NOT NULL CHECK (severity IN ('info','important','critical')),
 run_id bigint REFERENCES workflow_runs(id) ON DELETE CASCADE,
 dedupe_key text NOT NULL,
 text text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 UNIQUE (user_id, dedupe_key)
);
CREATE INDEX telegram_notifications_pending ON telegram_notifications (user_id, created_at) WHERE sent_at IS NULL;

ALTER TABLE telegram_preferences
 ADD COLUMN chat boolean NOT NULL DEFAULT true,
 ADD COLUMN blocked boolean NOT NULL DEFAULT true,
 ADD COLUMN recoveries boolean NOT NULL DEFAULT true,
 ADD COLUMN pull_requests boolean NOT NULL DEFAULT true,
 ADD COLUMN autonomy boolean NOT NULL DEFAULT true,
 ADD COLUMN intake boolean NOT NULL DEFAULT true,
 ADD COLUMN level text NOT NULL DEFAULT 'important' CHECK (level IN ('all','important','critical')),
 ADD COLUMN quiet_start smallint CHECK (quiet_start BETWEEN 0 AND 23),
 ADD COLUMN quiet_end smallint CHECK (quiet_end BETWEEN 0 AND 23),
 ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh';

-- Autonomy for actions proposed in chat (Telegram or web). Absent global policy = MANUAL: every action waits for the
-- owner. Resolution is most-restrictive across global, the owner, the target repositories and the target workflow; a
-- user is MANUAL until they opt in with their own owner policy. Workflow gates (approvals, verification, security)
-- keep their own policies (autonomy_policies) and are never decided here.
CREATE TABLE chat_autonomy_policies (
 id bigserial PRIMARY KEY,
 scope_kind text NOT NULL CHECK (scope_kind IN ('global','owner','repository','workflow')),
 scope_ref text NOT NULL DEFAULT '',
 mode text NOT NULL CHECK (mode IN ('MANUAL','SEMI','AUTONOMOUS')),
 paused boolean NOT NULL DEFAULT false,
 actions text[] NOT NULL DEFAULT '{}',
 workflows text[],
 max_risk text NOT NULL DEFAULT 'LOW' CHECK (max_risk IN ('LOW','MEDIUM')),
 max_cost_usd_per_day numeric CHECK (max_cost_usd_per_day IS NULL OR max_cost_usd_per_day >= 0),
 max_tokens_per_day bigint CHECK (max_tokens_per_day IS NULL OR max_tokens_per_day >= 0),
 max_concurrent_runs integer NOT NULL DEFAULT 1 CHECK (max_concurrent_runs >= 0),
 run_budget_usd numeric CHECK (run_budget_usd IS NULL OR run_budget_usd > 0),
 retry_budget integer NOT NULL DEFAULT 1 CHECK (retry_budget >= 0),
 timeout_minutes integer CHECK (timeout_minutes IS NULL OR timeout_minutes > 0),
 revision integer NOT NULL DEFAULT 1,
 updated_by text NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz
);
CREATE UNIQUE INDEX chat_autonomy_policies_scope ON chat_autonomy_policies (scope_kind, scope_ref) WHERE revoked_at IS NULL;

-- Every autonomous decision (allowed or not) and the runs it started, for audit, limits and timeouts.
CREATE TABLE chat_autonomy_decisions (
 id bigserial PRIMARY KEY,
 owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 action text NOT NULL,
 allowed boolean NOT NULL,
 risk text NOT NULL,
 mode text NOT NULL,
 reasons jsonb NOT NULL DEFAULT '[]',
 sources jsonb NOT NULL DEFAULT '[]',
 conversation_id bigint REFERENCES chat_conversations(id) ON DELETE SET NULL,
 operation_id bigint,
 run_id bigint REFERENCES workflow_runs(id) ON DELETE SET NULL,
 timeout_at timestamptz,
 timed_out_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_autonomy_decisions_owner ON chat_autonomy_decisions (owner_id, created_at DESC);
CREATE INDEX chat_autonomy_decisions_timeout ON chat_autonomy_decisions (timeout_at) WHERE timeout_at IS NOT NULL AND timed_out_at IS NULL;
