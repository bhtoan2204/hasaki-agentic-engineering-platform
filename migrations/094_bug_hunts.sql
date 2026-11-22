-- Production Bug Hunter: one row per hunt (a `production-bug-hunt` workflow run started from an incident) and its
-- findings. Hunts are never overwritten: every hunt keeps its own run, revisions, report and findings. The status is the
-- run's (derived on read), so there is no second state machine. Findings carry two separate verdicts: whether the code
-- defect is verified, and whether it is the incident's cause.
CREATE TABLE bug_hunts (
  id            BIGSERIAL PRIMARY KEY,
  fingerprint   TEXT NOT NULL,
  run_id        BIGINT NOT NULL UNIQUE REFERENCES workflow_runs(id) ON DELETE CASCADE,
  requested_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  repositories  TEXT[] NOT NULL,
  scope_key     TEXT NOT NULL,
  revisions     JSONB,
  report        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX bug_hunts_fingerprint ON bug_hunts (fingerprint, id DESC);

CREATE TABLE bug_hunt_findings (
  id                        BIGSERIAL PRIMARY KEY,
  hunt_id                   BIGINT NOT NULL REFERENCES bug_hunts(id) ON DELETE CASCADE,
  candidate_id              TEXT NOT NULL,
  dedupe_key                TEXT NOT NULL,
  repository                TEXT NOT NULL,
  commit                    TEXT NOT NULL,
  file_path                 TEXT NOT NULL,
  function                  TEXT NOT NULL,
  line_start                INT NOT NULL,
  line_end                  INT NOT NULL,
  category                  TEXT NOT NULL,
  file_blob                 TEXT,
  bug_verification_status   TEXT NOT NULL CHECK (bug_verification_status IN ('CONFIRMED','SUSPECTED','REJECTED','BLOCKED')),
  incident_causality_status TEXT NOT NULL CHECK (incident_causality_status IN ('CONFIRMED','PROBABLE','NOT_SUPPORTED','UNKNOWN','NOT_APPLICABLE')),
  basis                     TEXT NOT NULL,
  finding                   JSONB NOT NULL,
  hunter_attempt_id         BIGINT,
  verification_step_id      BIGINT,
  verification_attempt_id   BIGINT,
  reused_from               JSONB,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hunt_id, candidate_id),
  -- A CONFIRMED bug always names the verification step that confirmed it (or the verified finding it reuses).
  CHECK (bug_verification_status <> 'CONFIRMED' OR verification_step_id IS NOT NULL OR reused_from IS NOT NULL),
  CHECK (incident_causality_status <> 'CONFIRMED' OR bug_verification_status = 'CONFIRMED')
);
CREATE INDEX bug_hunt_findings_reuse ON bug_hunt_findings (dedupe_key, file_blob);
