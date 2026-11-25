-- Workflow-to-workflow delegation (src/workflow/delegation.ts): a step of a running workflow asks the platform, in its
-- submitted output, to run another workflow. Each request is one durable row; the child is an ordinary run (same owner,
-- repositories within the parent's, its own approval gates, review and budget) linked by inputs.delegation.id.
-- Spawning, waiting and aggregation are driven by these rows on the scheduler's reconcile tick (crash-safe, idempotent).
CREATE TABLE workflow_delegations (
 id bigserial PRIMARY KEY,
 parent_run_id bigint NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
 parent_step_id bigint NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
 parent_attempt_id bigint REFERENCES workflow_step_attempts(id) ON DELETE SET NULL,
 -- The top of the delegation tree: duplicates are refused across the whole tree, not only per parent.
 root_run_id bigint NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
 depth integer NOT NULL CHECK (depth >= 1),
 dedupe_key text NOT NULL,
 workflow_key text NOT NULL,
 -- propose: child created PENDING, a human starts it; blocking: the parent step waits for the result;
 -- parallel: the parent continues, the parent RUN completes only after the child; detached: nobody waits.
 mode text NOT NULL CHECK (mode IN ('propose','blocking','parallel','detached')),
 request jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued'
   CHECK (status IN ('queued','proposed','started','completed','failed','canceled')),
 child_run_id bigint REFERENCES workflow_runs(id) ON DELETE SET NULL,
 spawn_attempts integer NOT NULL DEFAULT 0,
 error text,
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (root_run_id, dedupe_key)
);
CREATE INDEX workflow_delegations_parent ON workflow_delegations (parent_run_id);
CREATE INDEX workflow_delegations_child ON workflow_delegations (child_run_id);
CREATE INDEX workflow_delegations_open ON workflow_delegations (status) WHERE status IN ('queued','proposed','started');
