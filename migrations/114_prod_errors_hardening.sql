-- Production error scan hardening (docs/prod-errors-hardening/PLAN.md, phase 1).

-- A scan that got data from some sources but not all stays ok = true; these say which source is missing or cut.
-- sources: {"splunk": {"status": "ok|failed|skipped", "error": "…", "truncated": bool, "rows": n, "partial_reasons": […]},
--           "signoz": {"status": "…", "slow": "ok|failed|off", …}}
ALTER TABLE prod_error_scans
  ADD COLUMN partial boolean NOT NULL DEFAULT false,
  ADD COLUMN sources jsonb NOT NULL DEFAULT '{}';

-- The level last announced for a group (a rise announces it again) and the ignore window (TTL, rate when ignored).
ALTER TABLE prod_error_groups
  ADD COLUMN notified_severity text CHECK (notified_severity IS NULL OR notified_severity IN ('low', 'medium', 'high', 'critical')),
  ADD COLUMN notified_at timestamptz,
  ADD COLUMN ignored_until timestamptz,
  ADD COLUMN ignored_at timestamptz,
  ADD COLUMN ignored_rate numeric;

-- Groups already announced keep their level as announced: deploying this must not announce them all again.
UPDATE prod_error_groups SET notified_severity = severity, notified_at = updated_at WHERE notified_day IS NOT NULL;
