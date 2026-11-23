-- Causal memory lifecycle corrections (pre-commit audit): an invalidation cursor so every record is re-checked in turn
-- (no starvation behind the oldest rows), and removal of the never-written `contradicts` column (contradictions are
-- recorded, with their resolution state, in provenance.contradiction).
ALTER TABLE causal_memories ADD COLUMN checked_at timestamptz;
CREATE INDEX causal_memories_check ON causal_memories (checked_at NULLS FIRST) WHERE status IN ('verified','proposed');
ALTER TABLE causal_memories DROP COLUMN contradicts;
