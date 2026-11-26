-- Shared results, step 4 (docs/shared-results/PLAN.md): facts recorded at analysis time, and the indexes the validity
-- rules read. Additive. Rollback: docs/shared-results/rollback/113_shared_analyses_provenance.down.sql.

-- What was true when the analysis ran, to show next to what is true now without analysing again. For a production error:
-- {"occurrences": {"today_count", "yesterday_count", "last_at", "day"}} from the error group at publish time.
ALTER TABLE shared_analyses ADD COLUMN observed jsonb;

-- Marking older versions of the same subject stale when a newer key replaces them: same kind and repositories.
CREATE INDEX shared_analyses_subject ON shared_analyses (kind, scope_repos) WHERE status = 'valid';
-- The TTL sweep reads only valid rows that have an end.
CREATE INDEX shared_analyses_expiry ON shared_analyses (valid_until) WHERE status = 'valid' AND valid_until IS NOT NULL;
