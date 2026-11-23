-- Engineering Radar (src/radar): deterministic detection over data the platform already collected (production error
-- observations, workflow step failures, PR CI state). Findings are deduplicated by fingerprint and feed the existing
-- Intake Queue as source 'radar'; no new scheduler, workflow or external query path.
ALTER TABLE intake_policies DROP CONSTRAINT IF EXISTS intake_policies_source_check;
ALTER TABLE intake_policies ADD CONSTRAINT intake_policies_source_check CHECK (source IN ('hasaki_work','prod_errors','radar'));
ALTER TABLE intake_items DROP CONSTRAINT IF EXISTS intake_items_source_check;
ALTER TABLE intake_items ADD CONSTRAINT intake_items_source_check CHECK (source IN ('hasaki_work','prod_errors','radar'));

CREATE TABLE radar_findings (
 id bigserial PRIMARY KEY,
 -- Correlation identity: kind family + service + environment + normalized signature (never volatile ids).
 fingerprint text NOT NULL UNIQUE,
 kinds text[] NOT NULL,
 service text NOT NULL DEFAULT '',
 environment text NOT NULL DEFAULT '',
 signature text NOT NULL DEFAULT '',
 severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
 confidence text NOT NULL CHECK (confidence IN ('low','medium','high')),
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','suppressed')),
 -- Statistics behind the detection (baseline, observed value, z-score...), the newest detection only.
 stats jsonb NOT NULL DEFAULT '{}',
 -- Bounded evidence references with their own timestamps (source records, never copied payloads).
 evidence jsonb NOT NULL DEFAULT '[]',
 related jsonb NOT NULL DEFAULT '[]',
 prod_fingerprint text REFERENCES prod_error_groups(fingerprint) ON DELETE SET NULL,
 proposed_workflow text,
 next_action text NOT NULL DEFAULT '',
 occurrences integer NOT NULL DEFAULT 1,
 first_detected_at timestamptz NOT NULL DEFAULT now(),
 last_detected_at timestamptz NOT NULL DEFAULT now(),
 last_signal_at timestamptz,
 resolved_at timestamptz,
 notified_severity text,
 work_item_id bigint REFERENCES work_items(id) ON DELETE SET NULL,
 intake_item_id bigint REFERENCES intake_items(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX radar_findings_open ON radar_findings (status, last_detected_at DESC);

-- One row per detection pass: what it read, found and cost (measurement and recovery).
CREATE TABLE radar_scans (
 id bigserial PRIMARY KEY,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 series integer NOT NULL DEFAULT 0,
 queries integer NOT NULL DEFAULT 0,
 detected integer NOT NULL DEFAULT 0,
 created integer NOT NULL DEFAULT 0,
 updated integer NOT NULL DEFAULT 0,
 resolved integer NOT NULL DEFAULT 0,
 ingested integer NOT NULL DEFAULT 0,
 duration_ms integer,
 error text
);

-- Last deployed version (image) seen per production error series, to correlate change points with deployments.
CREATE TABLE radar_series_state (
 prod_fingerprint text PRIMARY KEY REFERENCES prod_error_groups(fingerprint) ON DELETE CASCADE,
 version text,
 previous_version text,
 version_changed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
