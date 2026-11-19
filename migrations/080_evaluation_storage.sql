-- Central evaluation storage. Additive and backward compatible:
--  * private/team visibility on existing evaluation records (default private; legacy eval_results without an owner keep
--    their previous visibility to everyone);
--  * evaluation_reports: the header of a report produced outside the benchmark framework (autonomy suite, performance
--    baseline, bench, benchmark/comparison exports) with its version, configuration, commit and provenance. Its per-case
--    rows live in the existing eval_results table (report_id). content_hash makes saving and importing idempotent.
ALTER TABLE evaluation_runs
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team'));
ALTER TABLE eval_results
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team'));

CREATE TABLE evaluation_reports (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team')),
  kind TEXT NOT NULL CHECK (kind IN ('autonomy', 'performance', 'bench', 'benchmark')),
  suite TEXT NOT NULL,
  suite_version TEXT,
  manifest_hash TEXT,
  commit_sha TEXT,
  provider TEXT,
  model TEXT,
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  gate JSONB,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('cli', 'import', 'api')),
  generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, content_hash)
);
CREATE INDEX evaluation_reports_kind_idx ON evaluation_reports (kind, created_at DESC);
CREATE INDEX evaluation_reports_team_idx ON evaluation_reports (created_at DESC) WHERE visibility = 'team';

ALTER TABLE eval_results ADD COLUMN report_id BIGINT REFERENCES evaluation_reports(id) ON DELETE CASCADE;
CREATE INDEX eval_results_report_idx ON eval_results (report_id) WHERE report_id IS NOT NULL;
