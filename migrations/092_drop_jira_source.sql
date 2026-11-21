-- Jira was removed (no import, no tool, no credentials); no work item ever came from it on this installation.
ALTER TABLE work_items DROP CONSTRAINT work_items_source_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_source_check CHECK (source IN ('manual', 'hasaki_work'));
