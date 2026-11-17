-- The shipped template spec last merged into a built-in definition: the common ancestor for merging the next
-- template update with local edits. NULL falls back to the latest "built-in template" version.
ALTER TABLE workflow_definitions ADD COLUMN template_base JSONB;
