-- Cost budgets (USD, provider-reported cost). NULL = no budget at this level (falls back to the global default).
ALTER TABLE work_items ADD COLUMN budget_usd numeric CHECK (budget_usd IS NULL OR budget_usd > 0);
ALTER TABLE workflow_runs ADD COLUMN budget_usd numeric CHECK (budget_usd IS NULL OR budget_usd > 0);
-- Budget alerts are workflow_events of kind 'budget'; one per (run, scope, level) keeps them idempotent.
CREATE INDEX IF NOT EXISTS workflow_events_budget ON workflow_events(run_id) WHERE kind = 'budget';
