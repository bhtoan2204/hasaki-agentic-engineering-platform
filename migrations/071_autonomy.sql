-- Risk-aware autonomy: admin-managed policies (global / owner / repository), the effective policy frozen on each run,
-- and autonomy decisions recorded in the existing execution decision log. No row = MANUAL (legacy behaviour).
CREATE TABLE autonomy_policies (
  id BIGSERIAL PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'owner', 'repository')),
  scope_ref TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'MANUAL' CHECK (mode IN ('MANUAL', 'SUPERVISED', 'AUTONOMOUS', 'AUTOPILOT')),
  shadow BOOLEAN NOT NULL DEFAULT true,
  gates TEXT[] NOT NULL DEFAULT '{}',
  max_diff_lines INT NOT NULL DEFAULT 400 CHECK (max_diff_lines > 0),
  revision INT NOT NULL DEFAULT 1,
  revoked_at TIMESTAMPTZ,
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope_kind = 'global') = (scope_ref = '')),
  UNIQUE (scope_kind, scope_ref)
);

ALTER TABLE workflow_runs ADD COLUMN autonomy JSONB;

ALTER TABLE execution_decisions DROP CONSTRAINT execution_decisions_kind_check;
ALTER TABLE execution_decisions ADD CONSTRAINT execution_decisions_kind_check CHECK (kind IN (
  'replay', 'recovery', 'resume', 'restore', 'reconcile',
  'verification_reuse', 'context_reuse', 'review_reuse', 'checkpoint', 'autonomy'
));
ALTER TABLE execution_decisions DROP CONSTRAINT execution_decisions_action_check;
ALTER TABLE execution_decisions ADD CONSTRAINT execution_decisions_action_check CHECK (action IN (
  'REUSE', 'RESUME', 'RESTORE', 'VERIFY_ONLY', 'REEXECUTE', 'FORCE_REEXECUTE', 'RECONCILE',
  'SAFE_RETRY', 'REQUIRES_RECONCILIATION', 'HANDOFF', 'RECORD',
  'ALLOW', 'DENY', 'REQUIRE_HUMAN', 'COLLECT_EVIDENCE', 'REPLAN'
));
CREATE INDEX execution_decisions_autonomy_idx ON execution_decisions (run_id, step_id) WHERE kind = 'autonomy';
