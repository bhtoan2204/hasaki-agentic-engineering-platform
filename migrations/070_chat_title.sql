-- Conversation title provenance: avoid overwriting manual renames; generate at most once by default.
ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS title_source TEXT NOT NULL DEFAULT 'none'
    CHECK (title_source IN ('none', 'fallback', 'generated', 'manual'));

-- Existing non-empty titles (legacy first-message slice) stay as-is and are not regenerated.
UPDATE chat_conversations
   SET title_source = 'fallback'
 WHERE title_source = 'none' AND length(trim(title)) > 0;
