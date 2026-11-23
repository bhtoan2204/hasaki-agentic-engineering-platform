-- Proof-of-Fix reports (agent/proofOfFix.ts): one row per proof_of_fix attempt, append-only, so retries, resumes and
-- re-executions keep every earlier report; the newest row of a run is its current verdict. Read access follows the run.
CREATE TABLE fix_proofs (
 id bigserial PRIMARY KEY,
 run_id bigint NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
 step_id bigint REFERENCES workflow_steps(id) ON DELETE SET NULL,
 attempt_id bigint REFERENCES workflow_step_attempts(id) ON DELETE SET NULL,
 generation integer,
 mode text NOT NULL CHECK (mode IN ('fix','diagnosis')),
 verdict text NOT NULL CHECK (verdict IN ('VERIFIED','PARTIAL','INCONCLUSIVE','FAILED')),
 report jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (attempt_id)
);
CREATE INDEX fix_proofs_run ON fix_proofs (run_id, id DESC);
