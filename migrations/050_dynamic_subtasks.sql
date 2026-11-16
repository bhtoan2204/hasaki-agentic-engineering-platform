-- Dynamic subtask DAG: additive only. Subtasks are ordinary workflow_steps rows so the
-- scheduler, leases, fencing, retry and cancel paths keep working unchanged.
ALTER TABLE workflow_steps ADD COLUMN parent_step_key text;
ALTER TABLE workflow_steps ADD COLUMN subtask_id text;
ALTER TABLE workflow_steps ADD COLUMN graph_revision int;
CREATE UNIQUE INDEX workflow_steps_subtask_unique ON workflow_steps(run_id, subtask_id) WHERE subtask_id IS NOT NULL;

CREATE TABLE workflow_graph_revisions (
  id              BIGSERIAL PRIMARY KEY,
  run_id          BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  revision        INT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('decomposition', 'replan')),
  reason          TEXT NOT NULL,
  actor           TEXT NOT NULL,
  plan            JSONB NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, revision)
);
CREATE FUNCTION workflow_graph_revisions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'workflow_graph_revisions are immutable'; END $$;
CREATE TRIGGER workflow_graph_revisions_no_update BEFORE UPDATE OR DELETE ON workflow_graph_revisions
  FOR EACH ROW EXECUTE FUNCTION workflow_graph_revisions_immutable();
