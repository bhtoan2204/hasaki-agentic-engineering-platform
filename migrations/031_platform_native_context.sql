-- Provider-neutral, durable context. All access is authorized through the run's immutable owner.
CREATE TABLE agent_context_packs (
 id bigserial PRIMARY KEY,
 attempt_id bigint NOT NULL UNIQUE REFERENCES workflow_step_attempts(id) ON DELETE CASCADE,
 run_id bigint NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
 step_id bigint NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
 owner_id bigint NOT NULL REFERENCES users(id),
 snapshot_id bigint NOT NULL REFERENCES context_snapshots(id),
 content_hash text NOT NULL,
 content jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION agent_context_pack_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'agent context packs are immutable'; END $$;
CREATE TRIGGER agent_context_pack_no_update BEFORE UPDATE ON agent_context_packs FOR EACH ROW EXECUTE FUNCTION agent_context_pack_immutable();
CREATE INDEX agent_context_packs_run ON agent_context_packs(run_id,id DESC);

CREATE TABLE agent_context_tool_calls (
 id bigserial PRIMARY KEY,
 attempt_id bigint NOT NULL REFERENCES workflow_step_attempts(id) ON DELETE CASCADE,
 run_id bigint NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
 step_id bigint NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
 owner_id bigint NOT NULL REFERENCES users(id),
 worker_instance text NOT NULL,
 pack_id bigint REFERENCES agent_context_packs(id),
 tool text NOT NULL,
 read_only boolean NOT NULL,
 status text NOT NULL CHECK(status IN ('ok','error','denied','timeout')),
 duration_ms double precision NOT NULL,
 input_hash text NOT NULL,
 evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_context_calls_attempt ON agent_context_tool_calls(attempt_id,id);

CREATE TABLE agent_context_continuity (
 attempt_id bigint PRIMARY KEY REFERENCES workflow_step_attempts(id) ON DELETE CASCADE,
 pack_id bigint NOT NULL REFERENCES agent_context_packs(id),
 content jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
