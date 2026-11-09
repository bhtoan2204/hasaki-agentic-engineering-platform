-- Cross-process invalidation for the in-process caches (src/cache): any write to a cached table announces the table
-- on `cache_invalidate`. pg_notify is transactional (delivered on COMMIT, nothing on ROLLBACK) and identical
-- notifications of one transaction are folded into one. Statement-level: one notify per statement, not per row.
CREATE FUNCTION notify_cache_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('cache_invalidate', TG_TABLE_NAME);
  RETURN NULL;
END $$;

CREATE TRIGGER knowledge_items_cache AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON knowledge_items FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
CREATE TRIGGER knowledge_versions_cache AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON knowledge_versions FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
CREATE TRIGGER repositories_cache AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON repositories FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
CREATE TRIGGER workflow_definitions_cache AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON workflow_definitions FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
CREATE TRIGGER workflow_definition_versions_cache AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON workflow_definition_versions FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
