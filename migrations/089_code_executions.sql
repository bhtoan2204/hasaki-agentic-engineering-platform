-- CodeAct (P1-A, ADR 0008): one row per sandboxed program execution and one per nested tool call it made through the
-- parent broker. Calls keep fingerprints and a redacted, capped result (the evidence behind `codeact:<id>:<seq>`
-- refs); the program text itself is stored only as a hash.
CREATE TABLE code_executions (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  surface TEXT NOT NULL CHECK (surface IN ('workflow', 'chat')),
  run_id BIGINT REFERENCES workflow_runs(id) ON DELETE CASCADE,
  attempt_id BIGINT REFERENCES workflow_step_attempts(id) ON DELETE CASCADE,
  conversation_id BIGINT REFERENCES chat_conversations(id) ON DELETE CASCADE,
  turn_id BIGINT REFERENCES chat_turns(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
  error_category TEXT,
  code_sha256 TEXT NOT NULL,
  calls INT NOT NULL DEFAULT 0,
  result_bytes BIGINT NOT NULL DEFAULT 0,
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX code_executions_run ON code_executions (run_id, id) WHERE run_id IS NOT NULL;
CREATE INDEX code_executions_conversation ON code_executions (conversation_id, id)
  WHERE conversation_id IS NOT NULL;

CREATE TABLE code_execution_calls (
  id BIGSERIAL PRIMARY KEY,
  execution_id BIGINT NOT NULL REFERENCES code_executions(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  tool TEXT NOT NULL,
  read_only BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'denied', 'timeout')),
  error_category TEXT,
  duration_ms INT NOT NULL,
  input_sha256 TEXT NOT NULL,
  output_sha256 TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (execution_id, seq)
);
