-- Policy-controlled intake. A policy per source (and optionally per owner) decides whether imported work items and
-- production incidents are only imported (no policy / OFF, the default), triaged without execution (SHADOW), or may
-- start runs (AUTOPILOT). intake_items is the typed envelope + durable queue; runs are still started by the engine and
-- executed by the existing scheduler. No row is created while no policy exists, so the legacy import-only path is unchanged.
CREATE TABLE intake_policies (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('hasaki_work', 'prod_errors')),
  owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK (mode IN ('OFF', 'SHADOW', 'AUTOPILOT')),
  paused BOOLEAN NOT NULL DEFAULT false,
  workflows TEXT[] NOT NULL DEFAULT '{}',
  repositories TEXT[] NOT NULL DEFAULT '{}',
  min_severity TEXT NOT NULL DEFAULT 'high' CHECK (min_severity IN ('critical', 'high', 'medium', 'low')),
  max_active_runs INT NOT NULL DEFAULT 2 CHECK (max_active_runs >= 0),
  max_active_per_repo INT NOT NULL DEFAULT 1 CHECK (max_active_per_repo >= 0),
  max_runs_per_day INT NOT NULL DEFAULT 5 CHECK (max_runs_per_day >= 0),
  max_backlog INT NOT NULL DEFAULT 50 CHECK (max_backlog >= 0),
  cooldown_minutes INT NOT NULL DEFAULT 240 CHECK (cooldown_minutes >= 0),
  stale_hours INT NOT NULL DEFAULT 72 CHECK (stale_hours > 0),
  revision INT NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX intake_policies_scope ON intake_policies (source, COALESCE(owner_id, 0));

CREATE TABLE intake_items (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('hasaki_work', 'prod_errors')),
  -- Durable source identity (external id, or a versioned incident key); never contains credentials or PII.
  source_key TEXT NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_item_id BIGINT REFERENCES work_items(id) ON DELETE SET NULL,
  incident_fingerprint TEXT,
  state TEXT NOT NULL DEFAULT 'imported' CHECK (state IN (
    'imported', 'triaged', 'eligible', 'queued', 'starting', 'running', 'deferred', 'rejected', 'superseded', 'resolved'
  )),
  -- Hash of the source content that matters for triage; a change re-triages a waiting item.
  revision TEXT NOT NULL DEFAULT '',
  severity TEXT,
  environment TEXT,
  service TEXT,
  repo_candidate TEXT,
  workflow TEXT,
  priority INT NOT NULL DEFAULT 0,
  occurrences INT NOT NULL DEFAULT 1,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  enqueued_at TIMESTAMPTZ,
  next_eligible_at TIMESTAMPTZ,
  reason TEXT NOT NULL DEFAULT '',
  decision JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_revision INT,
  run_id BIGINT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  last_run_finished_at TIMESTAMPTZ,
  permalink TEXT,
  source_closed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, owner_id, source_key)
);
CREATE INDEX intake_items_queue ON intake_items (state, next_eligible_at, priority DESC);
CREATE INDEX intake_items_owner ON intake_items (owner_id, updated_at DESC);

-- At most one run per intake item revision/policy/workflow, enforced by the database (concurrent dispatchers, restarts).
CREATE UNIQUE INDEX workflow_runs_intake_key ON workflow_runs ((inputs->>'intake_key')) WHERE inputs ? 'intake_key';
