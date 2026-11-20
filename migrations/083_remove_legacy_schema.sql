-- Remove the pre-workflow legacy schema and database objects that no runtime code uses.
-- Backup first: pg_dump --format=custom --file=platform-before-083.dump "$DATABASE_URL"
-- Legacy history (tasks, events, questions, prs) is discarded; work items, runs, pull_requests, inbox and settings stay.

-- ---------------------------------------------------------------- legacy pre-workflow tables
ALTER TABLE work_items DROP CONSTRAINT work_items_legacy_task_code_fkey;
ALTER TABLE work_items DROP COLUMN legacy_task_code;

UPDATE work_items SET source = 'manual' WHERE source = 'legacy';
ALTER TABLE work_items DROP CONSTRAINT work_items_source_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_source_check CHECK (source IN ('manual', 'hasaki_work', 'jira'));

ALTER TABLE events DROP CONSTRAINT events_task_code_fkey;
ALTER TABLE questions DROP CONSTRAINT questions_task_code_fkey;
ALTER TABLE prs DROP CONSTRAINT prs_task_code_fkey;
DROP TABLE events;
DROP TABLE questions;
DROP TABLE prs;
DROP TABLE tasks;

-- ---------------------------------------------------------------- columns never written or read
ALTER TABLE workflow_step_attempts DROP COLUMN workspace;
ALTER TABLE agent_sessions DROP COLUMN ended_at;
ALTER TABLE platform_instances DROP COLUMN display_name;
ALTER TABLE chat_conversations DROP COLUMN budget;
ALTER TABLE telegram_updates DROP COLUMN received_at;
ALTER TABLE outcome_observations DROP COLUMN recorded_at;

DROP INDEX intake_items_queue;
ALTER TABLE intake_items DROP COLUMN priority;
CREATE INDEX intake_items_queue ON intake_items (state, next_eligible_at);

-- ---------------------------------------------------------------- indexes no query can use
DROP INDEX agent_sessions_attempt;            -- prefix of agent_sessions_provider
DROP INDEX execution_decisions_autonomy_idx;
DROP INDEX execution_decisions_kind_idx;
DROP INDEX splunk_searches_user;
DROP INDEX chat_turns_owner_idx;
DROP INDEX evaluation_comparisons_owner;
DROP INDEX knowledge_items_scope;

-- ---------------------------------------------------------------- cache_invalidate triggers no cache listens to
DROP TRIGGER evaluation_runs_cache ON evaluation_runs;
DROP TRIGGER agent_recommendations_cache ON agent_recommendations;
DROP TRIGGER agent_optimization_policies_cache ON agent_optimization_policies;
