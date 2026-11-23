-- Causal Engineering Memory (src/memory/causal.ts): structured, versioned records of verified (and failed) engineering
-- outcomes — incident → symptoms → root cause → change → verification → outcome. Owner-private; sharing goes through
-- the existing knowledge proposal review (knowledge_proposals), never directly. Evidence states are explicit.
CREATE TABLE causal_memories (
 id bigserial PRIMARY KEY,
 owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 -- Dedupe identity: repositories + normalized error signature/root cause.
 memory_key text NOT NULL,
 version integer NOT NULL DEFAULT 1,
 status text NOT NULL CHECK (status IN ('verified','proposed','hypothesis','rejected','outdated')),
 -- Negative knowledge: an approach that failed (kept as caution, never as a rule).
 negative boolean NOT NULL DEFAULT false,
 confidence text NOT NULL CHECK (confidence IN ('high','medium','low')),
 title text NOT NULL,
 incident text NOT NULL DEFAULT '',
 symptoms jsonb NOT NULL DEFAULT '[]',
 root_cause text NOT NULL DEFAULT '',
 root_cause_evidence jsonb NOT NULL DEFAULT '[]',
 fix_approach text NOT NULL DEFAULT '',
 failed_approaches jsonb NOT NULL DEFAULT '[]',
 regression_tests jsonb NOT NULL DEFAULT '[]',
 verification jsonb NOT NULL DEFAULT '{}',
 outcome text NOT NULL DEFAULT '',
 services text[] NOT NULL DEFAULT '{}',
 repositories text[] NOT NULL DEFAULT '{}',
 files text[] NOT NULL DEFAULT '{}',
 symbols text[] NOT NULL DEFAULT '{}',
 error_signatures text[] NOT NULL DEFAULT '{}',
 pull_requests jsonb NOT NULL DEFAULT '[]',
 commits jsonb NOT NULL DEFAULT '{}',
 -- Validity boundary: where/when the finding applies (repository base commit, files); invalidated when they change.
 validity jsonb NOT NULL DEFAULT '{}',
 contradicts bigint[] NOT NULL DEFAULT '{}',
 provenance jsonb NOT NULL DEFAULT '{}',
 run_id bigint REFERENCES workflow_runs(id) ON DELETE SET NULL,
 fix_proof_id bigint REFERENCES fix_proofs(id) ON DELETE SET NULL,
 knowledge_proposal_id bigint,
 knowledge_key text,
 invalidated_at timestamptz,
 invalidation_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (owner_id, memory_key, negative)
);
CREATE INDEX causal_memories_owner ON causal_memories (owner_id, status, updated_at DESC);
CREATE INDEX causal_memories_signatures ON causal_memories USING gin (error_signatures);
CREATE INDEX causal_memories_files ON causal_memories USING gin (files);

CREATE TABLE causal_memory_versions (
 id bigserial PRIMARY KEY,
 memory_id bigint NOT NULL REFERENCES causal_memories(id) ON DELETE CASCADE,
 version integer NOT NULL,
 snapshot jsonb NOT NULL,
 change text NOT NULL,
 actor_id bigint REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (memory_id, version)
);
