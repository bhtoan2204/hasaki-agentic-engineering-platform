-- Chat continuation: the unfinished request of a conversation (goal, completed actions, blockers, pending operations),
-- derived by the platform from the turn's tool calls, operations and failure. Additive; NULL = nothing unfinished.
ALTER TABLE chat_conversations ADD COLUMN continuation JSONB;
