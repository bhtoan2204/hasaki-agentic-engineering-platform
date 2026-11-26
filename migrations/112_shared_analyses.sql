-- Shared results (docs/shared-results/PLAN.md, step 2): analyses of production errors and code assessments that one
-- member has run, kept so other members with the right access can reuse them. Additive: two new tables and one setting;
-- nothing existing is changed. Rollback: docs/shared-results/rollback/112_shared_analyses.down.sql.

-- The scope every key carries. One installation is one organisation (there is no tenant table); who may READ a result is
-- decided by access rules at lookup time, never by the key. Kept on rollback so keys stay stable if this is re-applied.
INSERT INTO settings (key, value) VALUES ('shared_results.installation_id', gen_random_uuid()::text)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE shared_analyses (
  id               bigserial PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('prod_error.runtime_rca', 'prod_error.bug_hunt', 'code_assessment')),
  -- sha256 hex of the canonical key parts (src/sharing/key.ts); the parts themselves are kept readable in key_parts.
  key              text NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
  -- A force re-run is a new version of the same key; the previous valid version is superseded once the new one is published.
  version          integer NOT NULL CHECK (version >= 1),
  status           text NOT NULL CHECK (status IN ('running', 'valid', 'stale', 'failed', 'superseded')),
  key_parts        jsonb NOT NULL,
  -- Repositories a reader must be able to read (access is evaluated at lookup, per reader).
  scope_repos      text[] NOT NULL DEFAULT '{}',
  -- Production errors: the group fingerprint (prod_error_groups.fingerprint). Code assessments have none.
  error_key        text CHECK (error_key IS NULL OR error_key ~ '^[0-9a-f]{20}$'),
  -- The scrubbed snapshot a reader gets (never the source run). Empty while running and when the analysis failed.
  result           jsonb,
  source_run_id    bigint REFERENCES workflow_runs(id) ON DELETE SET NULL,
  created_by       bigint REFERENCES users(id) ON DELETE SET NULL,
  trigger          text NOT NULL CHECK (trigger IN ('manual', 'force', 'backfill', 'schedule')),
  provider         text,
  model            text,
  definition_version integer,
  rubric_hash      text,
  tokens_in        bigint CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out       bigint CHECK (tokens_out IS NULL OR tokens_out >= 0),
  cost_usd         numeric CHECK (cost_usd IS NULL OR cost_usd >= 0),
  duration_ms      bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  valid_until      timestamptz,
  stale_reason     text,
  failure          jsonb,
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at    timestamptz,
  reuse_count      integer NOT NULL DEFAULT 0 CHECK (reuse_count >= 0),
  last_reused_at   timestamptz,
  UNIQUE (kind, key, version),
  CONSTRAINT shared_analyses_error_key_kind CHECK ((kind LIKE 'prod_error.%') = (error_key IS NOT NULL)),
  CONSTRAINT shared_analyses_result_present CHECK (status NOT IN ('valid', 'stale', 'superseded') OR result IS NOT NULL)
);

-- Lookup: the current (highest) version of a key, one index probe.
CREATE INDEX shared_analyses_lookup ON shared_analyses (kind, key, version DESC);
-- Single-flight in the database: at most one running analysis per key, whichever instance starts it.
CREATE UNIQUE INDEX shared_analyses_one_running ON shared_analyses (kind, key) WHERE status = 'running';
-- Everything known about one production error, whatever the analysis.
CREATE INDEX shared_analyses_error ON shared_analyses (error_key, kind) WHERE error_key IS NOT NULL;
-- Reaping rows whose run ended without publishing, and retry scheduling.
CREATE INDEX shared_analyses_running_run ON shared_analyses (source_run_id) WHERE status = 'running';

-- Provenance of every use of a shared result: who asked, when, and what they got.
CREATE TABLE shared_analysis_uses (
  id           bigserial PRIMARY KEY,
  analysis_id  bigint NOT NULL REFERENCES shared_analyses(id) ON DELETE CASCADE,
  user_id      bigint REFERENCES users(id) ON DELETE SET NULL,
  outcome      text NOT NULL CHECK (outcome IN ('hit', 'wait', 'miss', 'forced')),
  tokens_saved bigint CHECK (tokens_saved IS NULL OR tokens_saved >= 0),
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shared_analysis_uses_analysis ON shared_analysis_uses (analysis_id, at DESC);
