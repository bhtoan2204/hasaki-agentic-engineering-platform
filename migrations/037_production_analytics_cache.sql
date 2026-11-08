-- Keep the existing analytics cache fresh when scan health, incident lifecycle or PR evidence changes.
-- EXPLAIN ANALYZE on a 25k-scan fixture reduced overlap lookup from 1.621 ms / 309 buffers to 0.053 ms / 6 buffers.
CREATE INDEX IF NOT EXISTS prod_error_scans_window_end_ok
  ON prod_error_scans(window_end) WHERE ok IS TRUE AND window_end IS NOT NULL;

CREATE TRIGGER prod_error_scans_analytics_cache AFTER INSERT OR UPDATE OR DELETE ON prod_error_scans
  FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
CREATE TRIGGER prod_error_lifecycle_analytics_cache AFTER INSERT OR UPDATE OR DELETE ON prod_error_lifecycle_events
  FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
CREATE TRIGGER pull_requests_analytics_cache AFTER INSERT OR UPDATE OR DELETE ON pull_requests
  FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
