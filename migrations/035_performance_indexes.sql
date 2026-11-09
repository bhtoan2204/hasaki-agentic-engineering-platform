-- Migration 035: Performance indexes for SPA navigation and dashboard queries

-- Speeds up listRuns subquery: (SELECT count(*)::int FROM workflow_questions qq WHERE qq.run_id = r.id AND qq.status = 'open')
CREATE INDEX IF NOT EXISTS workflow_questions_run_status ON workflow_questions(run_id, status);

-- Speeds up runDetail questions lookup by run_id
CREATE INDEX IF NOT EXISTS workflow_questions_run_id ON workflow_questions(run_id, id);

-- Speeds up runDetail checkpoints lookup by run_id
CREATE INDEX IF NOT EXISTS workflow_checkpoints_run_id ON workflow_checkpoints(run_id, id);

-- Speeds up work items detail and pull request list lookups
CREATE INDEX IF NOT EXISTS pull_requests_work_item ON pull_requests(work_item_id, id);
CREATE INDEX IF NOT EXISTS pull_requests_run ON pull_requests(run_id, id);
CREATE INDEX IF NOT EXISTS pull_requests_updated ON pull_requests(updated_at DESC);

-- Speeds up steps lookup ordered by position
CREATE INDEX IF NOT EXISTS workflow_steps_run_position ON workflow_steps(run_id, position);
