-- Preserve observations; existing scans only retained the latest row for each fingerprint.
CREATE TABLE prod_error_observations (
  scan_id bigint NOT NULL REFERENCES prod_error_scans(id) ON DELETE CASCADE,
  fingerprint text NOT NULL REFERENCES prod_error_groups(fingerprint) ON DELETE CASCADE,
  event_count int NOT NULL CHECK(event_count >= 0),
  baseline_count int NOT NULL CHECK(baseline_count >= 0),
  first_at timestamptz, last_at timestamptz, severity text NOT NULL,
  hourly jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY(scan_id, fingerprint)
);
-- Only the last actually retained successful scan can be recovered. No synthetic hourly data.
INSERT INTO prod_error_observations(scan_id,fingerprint,event_count,baseline_count,first_at,last_at,severity)
 SELECT g.last_scan_id,g.fingerprint,g.today_count,g.yesterday_count,g.first_at,g.last_at,g.severity
 FROM prod_error_groups g JOIN prod_error_scans s ON s.id=g.last_scan_id WHERE s.ok;
ALTER TABLE prod_error_groups
 ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'open' CHECK(lifecycle_status IN ('open','acknowledged','resolved')),
 ADD COLUMN acknowledged_at timestamptz,
 ADD COLUMN resolved_at timestamptz;
CREATE TABLE prod_error_lifecycle_events (
 id bigserial PRIMARY KEY,
 fingerprint text NOT NULL REFERENCES prod_error_groups(fingerprint) ON DELETE CASCADE,
 action text NOT NULL CHECK(action IN ('acknowledge','resolve','reopen')),
 actor_id bigint NOT NULL REFERENCES users(id),
 evidence text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Range-scoped analytics traverses owned run cohorts; the old owner/id index cannot constrain created_at.
CREATE INDEX workflow_runs_owner_created ON workflow_runs(owner_id,created_at DESC,id);
-- Observation details and lifecycle drill-downs use these exact leading keys.
CREATE INDEX prod_error_observations_fingerprint ON prod_error_observations(fingerprint,scan_id DESC);
CREATE INDEX prod_error_lifecycle_fingerprint ON prod_error_lifecycle_events(fingerprint,id DESC);
CREATE TRIGGER prod_error_observations_cache AFTER INSERT OR UPDATE OR DELETE ON prod_error_observations FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
CREATE TRIGGER prod_error_groups_cache AFTER INSERT OR UPDATE OR DELETE ON prod_error_groups FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
