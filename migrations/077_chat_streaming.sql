-- Chat streaming: the answer being generated (checkpointed while a turn runs, cleared when it ends) and the turn's
-- reasoning/activity trace as reported by the provider and the platform's tools. Additive; existing rows default empty.
ALTER TABLE chat_turns
  ADD COLUMN draft TEXT NOT NULL DEFAULT '',
  ADD COLUMN trace JSONB NOT NULL DEFAULT '[]'::jsonb;
