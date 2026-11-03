-- 'manual' once a developer edits the description in the UI: re-imports from Hasaki Work / Jira then never overwrite it.
ALTER TABLE work_items ADD COLUMN description_source TEXT NOT NULL DEFAULT 'import' CHECK (description_source IN ('import', 'manual'));
