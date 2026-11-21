-- Images attached to chat messages (pasted, dropped or chosen in the composer). Bytes live here, never in
-- chat_messages.content; access always goes through the owning conversation (src/chat/attachments.ts).
CREATE TABLE chat_attachments (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  -- NULL until the message that carries it is posted; unreferenced uploads expire (see attachments.ts).
  message_id BIGINT REFERENCES chat_messages(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 5242880),
  sha256 TEXT NOT NULL,
  content BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chat_attachments_message ON chat_attachments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX chat_attachments_unreferenced ON chat_attachments (created_at) WHERE message_id IS NULL;
