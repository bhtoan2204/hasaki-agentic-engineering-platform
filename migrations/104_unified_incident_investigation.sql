-- Unified Incident Investigation (src/incidents/unified.ts): one investigation workspace per production incident and
-- owner (the access scope), linking the existing workflows' runs — runtime RCA (production-incident-investigation),
-- Production Bug Hunts and Bug Investigation fixes. Evidence is NOT copied here: it is read by reference from the runs'
-- own records (bug_hunt_findings, step outputs). RCA conclusions are immutable versions; fix tasks are unique per cause.
CREATE TABLE incident_investigations (
 id bigserial PRIMARY KEY,
 fingerprint text NOT NULL REFERENCES prod_error_groups(fingerprint) ON DELETE CASCADE,
 owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (fingerprint, owner_id)
);

CREATE TABLE incident_investigation_runs (
 investigation_id bigint NOT NULL REFERENCES incident_investigations(id) ON DELETE CASCADE,
 run_id bigint NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('runtime','bug_hunt','fix')),
 -- How the link was made: started from the workbench, or discovered from the run's own inputs/records.
 link_source text NOT NULL,
 linked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (investigation_id, run_id)
);
CREATE INDEX incident_investigation_runs_run ON incident_investigation_runs (run_id);

CREATE TABLE incident_rca_versions (
 id bigserial PRIMARY KEY,
 investigation_id bigint NOT NULL REFERENCES incident_investigations(id) ON DELETE CASCADE,
 version integer NOT NULL,
 status text NOT NULL CHECK (status IN ('CONFIRMED','PROBABLE','UNKNOWN','CONFLICTED','BLOCKED')),
 -- Hash of the evidence references, their verdicts and validity: the same inputs never produce a second version.
 inputs_hash text NOT NULL,
 report jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (investigation_id, version),
 UNIQUE (investigation_id, inputs_hash)
);
CREATE FUNCTION incident_rca_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'incident RCA versions are immutable: create a new version';
END $$;
CREATE TRIGGER incident_rca_versions_immutable BEFORE UPDATE ON incident_rca_versions
  FOR EACH ROW EXECUTE FUNCTION incident_rca_immutable();

CREATE TABLE incident_fix_tasks (
 id bigserial PRIMARY KEY,
 investigation_id bigint NOT NULL REFERENCES incident_investigations(id) ON DELETE CASCADE,
 -- The reconciled cause (normalized code location): one fix task per cause, whichever workflow found it.
 cause_key text NOT NULL,
 source jsonb NOT NULL,
 run_id bigint REFERENCES workflow_runs(id) ON DELETE SET NULL,
 work_item_id bigint REFERENCES work_items(id) ON DELETE SET NULL,
 created_by bigint REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (investigation_id, cause_key)
);
