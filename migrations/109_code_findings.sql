-- Code assessment findings managed across scans (src/workflow/codeFindings.ts). A codebase-assessment run's assess
-- output stays the source of record; completed scans are ingested into these tables idempotently (one
-- code_finding_scans row per ingested run), so existing assessments are carried over without rewriting them.
-- Findings are deduplicated per owner by fingerprint (repo, category, file, symbol); a later scan updates the finding and
-- adds a sighting instead of creating a duplicate.
CREATE TABLE code_findings (
  id bigserial PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  repo text NOT NULL DEFAULT '',
  related_repos text[] NOT NULL DEFAULT '{}',
  kind text NOT NULL,
  severity text NOT NULL,
  title text NOT NULL,
  issue text NOT NULL DEFAULT '',
  file text NOT NULL DEFAULT '',
  line integer,
  symbol text NOT NULL DEFAULT '',
  evidence text NOT NULL DEFAULT '',
  implementable boolean NOT NULL DEFAULT false,
  why_not text NOT NULL DEFAULT '',
  code_evidence jsonb,
  -- Lifecycle a person sets; a scan that no longer reports a finding never resolves it.
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  status_note text NOT NULL DEFAULT '',
  status_changed_by bigint REFERENCES users(id) ON DELETE SET NULL,
  status_changed_at timestamptz,
  resolved_at timestamptz,
  reopened_at timestamptz,
  reopened_count integer NOT NULL DEFAULT 0,
  occurrences integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  first_scan_run_id bigint REFERENCES workflow_runs(id) ON DELETE SET NULL,
  last_scan_run_id bigint REFERENCES workflow_runs(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, fingerprint)
);
CREATE INDEX code_findings_owner_seen ON code_findings (owner_id, last_seen_at DESC);

-- Every scan that reported a finding, with what that scan said (evidence is kept per scan, never overwritten).
CREATE TABLE code_finding_sightings (
  finding_id bigint NOT NULL REFERENCES code_findings(id) ON DELETE CASCADE,
  scan_run_id bigint NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  -- The finding's id inside that scan's output (inputs.finding.id of fix runs started before this table existed).
  finding_key text NOT NULL DEFAULT '',
  seen_at timestamptz NOT NULL,
  severity text NOT NULL,
  issue text NOT NULL DEFAULT '',
  evidence text NOT NULL DEFAULT '',
  line integer,
  code_evidence jsonb,
  PRIMARY KEY (finding_id, scan_run_id)
);
CREATE INDEX code_finding_sightings_scan ON code_finding_sightings (scan_run_id);

-- Scans already ingested (also those that found nothing), so ingestion runs once per scan.
CREATE TABLE code_finding_scans (
  scan_run_id bigint PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  findings integer NOT NULL DEFAULT 0,
  ingested_at timestamptz NOT NULL DEFAULT now()
);
