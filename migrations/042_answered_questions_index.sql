-- The open-question inbox is indexed (workflow_questions_open). The answered inbox sorts every
-- historical answer by answered_at and had no matching index.
CREATE INDEX workflow_questions_answered ON workflow_questions (answered_at DESC) WHERE status = 'answered';
