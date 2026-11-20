-- Production error scans become durable jobs (ADR 0004). A scan row is the job: queued by the TypeScript API or
-- schedule, claimed by exactly one engine (`engine`) through a lease with a fencing token, and published only while
-- that token is current. Replaces the process-local `running` flag, schedule slot and progress object, which let
-- two platform instances scan at once and left crashed scans "running" forever.
ALTER TABLE prod_error_scans
  ADD COLUMN status text NOT NULL DEFAULT 'succeeded'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  ADD COLUMN engine text NOT NULL DEFAULT 'typescript' CHECK (engine IN ('typescript', 'go')),
  ADD COLUMN requested_by bigint REFERENCES users(id) ON DELETE SET NULL,
  -- Window (absolute epoch seconds), preset and namespaces fixed at enqueue: a retry scans the same window.
  ADD COLUMN request jsonb NOT NULL DEFAULT '{}',
  -- 'schedule:<local date> <HH:MM>' for scheduled scans: one scan per slot across all instances.
  ADD COLUMN dedupe_key text UNIQUE,
  ADD COLUMN attempts int NOT NULL DEFAULT 0,
  ADD COLUMN max_attempts int NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN fencing_token bigint NOT NULL DEFAULT 0,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false,
  -- {phase, pct, searchPct, splunkState, scanned, matched, startedAt}: what the page shows on every instance.
  ADD COLUMN progress jsonb,
  -- Groups were published (stage 'published'): a retry after a crash only finalizes, it never collects again.
  ADD COLUMN stage text NOT NULL DEFAULT 'collect' CHECK (stage IN ('collect', 'published')),
  ADD COLUMN queued_at timestamptz NOT NULL DEFAULT now();

-- Scans interrupted before this migration never finished: they are failed, not running.
UPDATE prod_error_scans SET status = CASE WHEN ok THEN 'succeeded' ELSE 'failed' END,
  ok = COALESCE(ok, false), finished_at = COALESCE(finished_at, started_at),
  error = CASE WHEN ok IS NULL THEN 'interrupted before durable scans' ELSE error END;

-- One active scan across every instance and engine (the previous in-process guarantee, now global).
CREATE UNIQUE INDEX prod_error_scans_one_active ON prod_error_scans ((true)) WHERE status IN ('queued', 'running');
-- Claims and lease recovery read only active rows.
CREATE INDEX prod_error_scans_claimable ON prod_error_scans (engine, available_at) WHERE status IN ('queued', 'running');
