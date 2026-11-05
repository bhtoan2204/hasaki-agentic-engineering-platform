-- Production error groups found by the daily Splunk scan (page "Lỗi production").
-- One row per error signature (namespace + service + caller + normalized message); counts are for `day`.
CREATE TABLE IF NOT EXISTS prod_error_groups (
  fingerprint     TEXT PRIMARY KEY,
  namespace       TEXT NOT NULL,
  service         TEXT NOT NULL,
  level           TEXT NOT NULL,
  caller          TEXT NOT NULL DEFAULT '',
  signature       TEXT NOT NULL,
  sample          TEXT NOT NULL DEFAULT '',
  detail          JSONB NOT NULL DEFAULT '{}',
  day             DATE NOT NULL,
  today_count     INT NOT NULL DEFAULT 0,
  yesterday_count INT NOT NULL DEFAULT 0,
  first_at        TIMESTAMPTZ,
  last_at         TIMESTAMPTZ,
  severity        TEXT NOT NULL DEFAULT 'low',
  score           INT NOT NULL DEFAULT 0,
  reasons         JSONB NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ignored')),
  work_item_id    BIGINT REFERENCES work_items(id) ON DELETE SET NULL,
  notified_day    DATE,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prod_error_groups_day ON prod_error_groups (day, score DESC);

CREATE TABLE IF NOT EXISTS prod_error_scans (
  id          BIGSERIAL PRIMARY KEY,
  trigger     TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  ok          BOOLEAN,
  error       TEXT,
  groups      INT,
  events      BIGINT,
  notified    INT
);
