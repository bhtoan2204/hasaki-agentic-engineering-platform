-- Rollback of migrations/112_shared_analyses.sql (run by hand; never by the migrator).
-- Drops the shared results and their usage history. The installation id setting is kept on purpose: if 112 is applied
-- again, the same scope is reused and no key changes. With the feature flags off nothing reads these tables, so this is
-- safe at any time. Deleting the migration record lets the migrator apply 112 again.
BEGIN;
DROP TABLE IF EXISTS shared_analysis_uses;
DROP TABLE IF EXISTS shared_analyses;
DELETE FROM schema_migrations WHERE version = 112;
COMMIT;
