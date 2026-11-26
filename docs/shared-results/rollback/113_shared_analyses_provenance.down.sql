-- Rollback of migrations/113_shared_analyses_provenance.sql (run by hand; never by the migrator).
-- Drops the "observed at analysis time" column and the two indexes. Nothing else depends on them; with the feature flags
-- off nothing reads them. Deleting the migration record lets the migrator apply 113 again.
BEGIN;
DROP INDEX IF EXISTS shared_analyses_expiry;
DROP INDEX IF EXISTS shared_analyses_subject;
ALTER TABLE shared_analyses DROP COLUMN IF EXISTS observed;
DELETE FROM schema_migrations WHERE version = 113;
COMMIT;
