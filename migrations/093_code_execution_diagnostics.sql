-- CodeAct failure diagnostics: a sanitized diagnosis per execution (failure category and phase, the nested calls that
-- failed with their categories, recording failures). Never program text, tool arguments or tool payloads. Nullable and
-- additive: rows written before this migration keep NULL; error_category keeps its coarse meaning.
ALTER TABLE code_executions ADD COLUMN diagnostics JSONB;
