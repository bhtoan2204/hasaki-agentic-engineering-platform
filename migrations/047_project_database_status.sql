-- Last known connection status of each project QC database, so the UI can show whether it actually works.
-- Written by the admin connection test and by agent queries (a connection-level failure marks it failed; an SQL error
-- such as an unknown column still proves the connection works).
ALTER TABLE project_databases
  ADD COLUMN last_status     TEXT CHECK (last_status IN ('ok', 'failed')),
  ADD COLUMN last_checked_at TIMESTAMPTZ,
  ADD COLUMN last_error_kind TEXT,
  ADD COLUMN last_error      TEXT,
  ADD COLUMN last_version    TEXT,
  ADD COLUMN last_account    TEXT,
  ADD COLUMN last_can_write  BOOLEAN,
  ADD COLUMN last_latency_ms INT,
  ADD COLUMN last_used_at    TIMESTAMPTZ;
