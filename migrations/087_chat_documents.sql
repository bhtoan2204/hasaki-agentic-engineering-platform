-- Documents in chat attachments (same table, same ownership): PDF, DOCX, XLSX, Markdown, text, JSON, CSV. The type is
-- read from the bytes (src/chat/documents.ts); `extraction` caches the located text, secret-like values redacted.
ALTER TABLE chat_attachments DROP CONSTRAINT chat_attachments_media_type_check;
ALTER TABLE chat_attachments ADD CONSTRAINT chat_attachments_media_type_check CHECK (media_type IN (
  'image/png', 'image/jpeg', 'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/markdown', 'text/plain', 'application/json', 'text/csv'));
ALTER TABLE chat_attachments DROP CONSTRAINT chat_attachments_bytes_check;
ALTER TABLE chat_attachments ADD CONSTRAINT chat_attachments_bytes_check CHECK (bytes > 0 AND bytes <= 10485760);
ALTER TABLE chat_attachments
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'image' CHECK (kind IN ('image', 'document')),
  ADD COLUMN filename TEXT NOT NULL DEFAULT '' CHECK (length(filename) <= 255),
  ADD COLUMN extraction JSONB;
