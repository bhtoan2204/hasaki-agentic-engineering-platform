-- Language of user-facing agent and platform prose for this run.
-- NULL means the run predates the field: do not backfill. Generation falls back to Vietnamese in code;
-- the UI must show that the choice was not recorded, and must not rewrite stored output.
ALTER TABLE workflow_runs ADD COLUMN output_locale TEXT CHECK (output_locale IN ('vi', 'en'));
