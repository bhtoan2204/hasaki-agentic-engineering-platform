-- Pull request delivery lifecycle (separate from run completion): the exact verified publication SHA, the remote head and
-- CI/review observations bound to it, sync cursor/backoff, repair rounds and notification dedup. Existing rows stay
-- UNTRACKED; the lifecycle only starts when prLifecycle.mode is not "off".
ALTER TABLE pull_requests
  ADD COLUMN published_sha TEXT,
  ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'UNTRACKED' CHECK (lifecycle IN (
    'UNTRACKED', 'OPEN', 'CI_PENDING', 'CI_FAILED', 'CHANGES_REQUESTED', 'REPAIRING', 'CONFLICT',
    'READY_FOR_HUMAN_MERGE', 'BLOCKED', 'MERGED', 'CLOSED'
  )),
  ADD COLUMN lifecycle_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN remote_head_sha TEXT,
  ADD COLUMN observation JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN synced_at TIMESTAMPTZ,
  ADD COLUMN next_sync_at TIMESTAMPTZ,
  ADD COLUMN sync_failures INT NOT NULL DEFAULT 0,
  ADD COLUMN processed_comments TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN repair_count INT NOT NULL DEFAULT 0,
  ADD COLUMN lifecycle_paused BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN notified JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN ready_at TIMESTAMPTZ;
CREATE INDEX pull_requests_lifecycle_due ON pull_requests (next_sync_at)
  WHERE created AND lifecycle NOT IN ('MERGED', 'CLOSED');
