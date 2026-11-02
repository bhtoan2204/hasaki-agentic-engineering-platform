-- Optional final "Task Result Report" step (driven by Hasaki Work task_ai.ai_suggest.report).
ALTER TABLE workflow_steps DROP CONSTRAINT workflow_steps_type_check;
ALTER TABLE workflow_steps ADD CONSTRAINT workflow_steps_type_check CHECK (type IN (
  'agent', 'coding_agent', 'human_input', 'human_approval', 'integration', 'command', 'condition', 'git_pull_request', 'task_result_report'));
