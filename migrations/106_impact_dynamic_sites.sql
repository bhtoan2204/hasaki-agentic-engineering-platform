-- Cross-repository impact (src/impact): per repository and contract kind, how many contract call sites build their
-- key at runtime (variable, configuration placeholder, concatenation, formatting). Such sites cannot be joined, so a
-- counterpart repository with unresolved sites of the changed kind makes an analysis partial, never "no impact".
ALTER TABLE impact_index_state ADD COLUMN dynamic_sites jsonb NOT NULL DEFAULT '{}';
