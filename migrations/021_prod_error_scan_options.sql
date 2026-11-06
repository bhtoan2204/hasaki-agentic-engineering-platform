-- Production error scans can target some projects (namespaces) and any time window (last N hours, today, yesterday,
-- custom), compared with a baseline window. The page shows the groups of the latest successful scan.
ALTER TABLE prod_error_scans
  ADD COLUMN IF NOT EXISTS preset TEXT,
  ADD COLUMN IF NOT EXISTS namespaces TEXT[],
  ADD COLUMN IF NOT EXISTS window_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS window_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS baseline_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS baseline_end TIMESTAMPTZ;
ALTER TABLE prod_error_groups ADD COLUMN IF NOT EXISTS last_scan_id BIGINT;
CREATE INDEX IF NOT EXISTS prod_error_groups_last_scan ON prod_error_groups (last_scan_id);
