-- Chat operations: pre-authorized execution (no per-call confirmation) and platform-checked outcome verification
-- (read-back evidence containing the operation's identifier). Additive.
ALTER TABLE chat_operations
  ADD COLUMN auto BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN verification JSONB;
