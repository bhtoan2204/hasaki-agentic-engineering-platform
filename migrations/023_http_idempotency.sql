-- Idempotency-Key for create-type POSTs (start run, create/import work item, add evidence, prod-error scan …):
-- a repeated request with the same key (double click, network retry, tab resubmit) gets the first response back
-- instead of creating a second run. Rows older than a day are pruned by the server.
CREATE TABLE http_idempotency (
  actor_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key          TEXT NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  route        TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status       INT,                 -- NULL while the first request is still running
  response     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, key)
);
CREATE INDEX http_idempotency_created ON http_idempotency(created_at);
