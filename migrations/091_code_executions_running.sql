-- CodeAct (ADR 0008): finding executions left `running` by a worker that died (reconciled as interrupted before each
-- new execution) must not scan the whole table.
CREATE INDEX code_executions_running ON code_executions (created_at) WHERE status = 'running';
