-- Evaluation-driven routing (src/routing): decisions made from measured production outcomes are recorded next to the
-- benchmark-recommendation decisions, with their own source. Opt-in per owner; absent preference = current defaults.
ALTER TABLE agent_optimization_decisions ALTER COLUMN recommendation_id DROP NOT NULL;
ALTER TABLE agent_optimization_decisions ALTER COLUMN policy_id DROP NOT NULL;
ALTER TABLE agent_optimization_decisions ADD COLUMN source text NOT NULL DEFAULT 'recommendation'
  CHECK (source IN ('recommendation','adaptive_routing'));
ALTER TABLE agent_optimization_decisions ADD CONSTRAINT agent_optimization_decisions_source_refs
  CHECK (source <> 'recommendation' OR (recommendation_id IS NOT NULL AND policy_id IS NOT NULL));

CREATE TABLE adaptive_routing_preferences (
 owner_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false,
 preference text NOT NULL DEFAULT 'balanced' CHECK (preference IN ('quality_first','balanced','cost_first')),
 min_samples integer NOT NULL DEFAULT 10 CHECK (min_samples >= 3),
 updated_at timestamptz NOT NULL DEFAULT now()
);
