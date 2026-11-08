CREATE TABLE evaluation_provider_phases (
 id bigserial PRIMARY KEY,
 case_run_id bigint NOT NULL REFERENCES evaluation_case_runs(id) ON DELETE RESTRICT,
 ordinal int NOT NULL CHECK(ordinal BETWEEN 0 AND 2),
 step_key text NOT NULL,
 provider text NOT NULL CHECK(provider IN ('claude','codex','cursor')),
 model text,
 role text NOT NULL CHECK(role IN ('research','implementation','verification')),
 UNIQUE(case_run_id,ordinal)
);
CREATE TRIGGER evaluation_phases_immutable BEFORE UPDATE OR DELETE ON evaluation_provider_phases FOR EACH ROW EXECUTE FUNCTION benchmark_immutable();
CREATE TABLE agent_recommendations (
 id bigserial PRIMARY KEY,
 owner_id bigint NOT NULL REFERENCES users(id),
 version text NOT NULL,
 category text NOT NULL,
 cohort_hash text,
 evidence_hash text NOT NULL,
 filters jsonb NOT NULL,
 decision jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days'
);
CREATE INDEX agent_recommendations_owner ON agent_recommendations(owner_id,id DESC);
CREATE TRIGGER recommendations_immutable BEFORE UPDATE OR DELETE ON agent_recommendations FOR EACH ROW EXECUTE FUNCTION benchmark_immutable();
CREATE TABLE agent_optimization_policies (
 id bigserial PRIMARY KEY,
 owner_id bigint NOT NULL REFERENCES users(id),
 category text NOT NULL,
 step_type text NOT NULL CHECK(step_type IN ('agent','coding_agent')),
 recommendation_id bigint NOT NULL REFERENCES agent_recommendations(id),
 enabled boolean NOT NULL DEFAULT false,
 allow_unknown_cost boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,category,step_type)
);
CREATE TABLE agent_optimization_decisions (
 id bigserial PRIMARY KEY,
 run_id bigint NOT NULL REFERENCES workflow_runs(id),
 step_key text NOT NULL,
 recommendation_id bigint NOT NULL REFERENCES agent_recommendations(id),
 policy_id bigint NOT NULL REFERENCES agent_optimization_policies(id),
 provenance jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,step_key)
);
CREATE TRIGGER optimization_decisions_immutable BEFORE UPDATE OR DELETE ON agent_optimization_decisions FOR EACH ROW EXECUTE FUNCTION benchmark_immutable();
CREATE VIEW evaluation_analytics_samples AS
SELECT cr.id AS case_run_id,e.id AS evaluation_id,e.owner_id,e.created_at,e.suite_id,e.constraints_hash,e.configuration,
 w.id AS workflow_run_id,w.status AS workflow_status,w.definition_key,w.selected_repositories,
 c.task_id,c.category,c.difficulty,c.base_commit,cr.repetition,
 COALESCE((SELECT string_agg(v->>'provider',' → ' ORDER BY n) FROM jsonb_array_elements(e.configuration->'provider_sequence') WITH ORDINALITY x(v,n)),e.configuration->>'provider','fixture') AS provider_path,
 COALESCE((SELECT string_agg(COALESCE(v->>'model','default/unreported'),' → ' ORDER BY n) FROM jsonb_array_elements(e.configuration->'provider_sequence') WITH ORDINALITY x(v,n)),e.configuration->>'model','default/unreported') AS model_path,
 COALESCE(e.configuration->>'context_variant','legacy') AS context_variant,
 CASE WHEN e.configuration->>'mode'='live' AND e.configuration->>'blocked' IS NULL AND r.data->'evidence'->'details'->>'evidence_kind'='live_provider' THEN 'controlled_live'
 WHEN r.status='BLOCKED' OR e.configuration->>'mode' IN ('dry_run','live') THEN 'blocked' ELSE 'fixture_control' END AS evidence_kind,
 r.id AS result_id,r.status AS result_status,r.correct,r.hard_gates_passed,r.quality_score::double precision,
 r.failure_class,r.data->'evidence' AS evidence,
 COALESCE((r.data->'evidence'->>'duration_ms')::double precision,r.wall_s*1000) AS validator_duration_ms,
 ps.wall_ms AS phase_duration_ms,
 CASE WHEN ps.started_at IS NOT NULL AND r.id IS NOT NULL THEN extract(epoch FROM(COALESCE(va.finished_at,now())-ps.started_at))*1000 END::double precision AS completion_duration_ms,ps.active_ms,ps.queue_ms,ps.human_ms,ps.tool_ms,ps.tool_calls,ps.tool_failures,
 ps.input_tokens,ps.output_tokens,ps.cache_read_tokens,ps.cache_creation_tokens,ps.reasoning_tokens,ps.cost_usd,
 ps.attempts AS phase_attempts,ps.cost_known,ps.tokens_known,ps.observed_models,
 (SELECT count(*)::int FROM provider_handoffs h JOIN workflow_steps s ON s.id=h.step_id JOIN evaluation_provider_phases p ON p.step_key=s.key AND p.case_run_id=cr.id WHERE s.run_id=w.id) AS recovery_handoffs,
 (SELECT count(*)::int FROM evaluation_provider_phases p JOIN evaluation_provider_phases prior ON prior.case_run_id=p.case_run_id AND prior.ordinal=p.ordinal-1 WHERE p.case_run_id=cr.id AND prior.provider<>p.provider) AS planned_switches,
 (r.data->'evidence'->'details'->>'artifact_id')::bigint AS artifact_id
FROM evaluation_case_runs cr JOIN evaluation_runs e ON e.id=cr.evaluation_id JOIN benchmark_cases c ON c.id=cr.case_id
JOIN workflow_runs w ON w.id=e.workflow_run_id LEFT JOIN eval_results r ON r.case_run_id=cr.id
LEFT JOIN workflow_steps vs ON vs.run_id=w.id AND vs.key=cr.workflow_step_key LEFT JOIN workflow_step_attempts va ON va.id=vs.current_attempt_id
LEFT JOIN LATERAL (
 SELECT min(t.start_time) AS started_at,extract(epoch FROM(max(t.end_time)-min(t.start_time)))*1000 AS wall_ms,
 sum(t.provider_execution_ms) AS active_ms,sum(t.queue_duration_ms) AS queue_ms,sum(t.human_wait_ms) AS human_ms,sum(t.tool_execution_ms) AS tool_ms,
 sum(COALESCE((SELECT sum(value::numeric) FROM jsonb_each_text(COALESCE(t.tool_calls,'{}'::jsonb))),(SELECT count(*) FROM agent_context_tool_calls calls WHERE calls.attempt_id=t.attempt_id)))::double precision AS tool_calls,
 sum(t.tool_failures)::double precision AS tool_failures,sum(t.input_tokens)::double precision AS input_tokens,sum(t.output_tokens)::double precision AS output_tokens,
 sum(t.cache_read_tokens)::double precision AS cache_read_tokens,sum(t.cache_creation_tokens)::double precision AS cache_creation_tokens,
 sum(t.reasoning_tokens)::double precision AS reasoning_tokens,sum(t.reported_cost_usd)::double precision AS cost_usd,
 jsonb_agg(DISTINCT jsonb_build_object('provider',t.provider,'model',t.model)) FILTER(WHERE t.model IS NOT NULL AND e.configuration->>'mode'='live') AS observed_models,
 count(*)::int AS attempts,count(t.reported_cost_usd) FILTER(WHERE t.cost_availability='reported')::int AS cost_known,
 count(t.input_tokens) FILTER(WHERE NOT EXISTS(SELECT 1 FROM jsonb_each(COALESCE(t.provider_sessions,'{}'::jsonb)) x WHERE x.value->'tokens'->>'input' IS NULL))::int AS tokens_known
 FROM evaluation_provider_phases p JOIN workflow_steps s ON s.run_id=w.id AND s.key=p.step_key JOIN execution_attempt_telemetry t ON t.step_id=s.id
 WHERE p.case_run_id=cr.id
) ps ON true;
CREATE TRIGGER evaluation_runs_cache AFTER INSERT OR UPDATE OR DELETE ON evaluation_runs FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
CREATE TRIGGER evaluation_results_cache AFTER INSERT OR UPDATE OR DELETE ON eval_results FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
CREATE TRIGGER agent_recommendations_cache AFTER INSERT ON agent_recommendations FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
CREATE TRIGGER agent_optimization_policies_cache AFTER INSERT OR UPDATE OR DELETE ON agent_optimization_policies FOR EACH STATEMENT EXECUTE FUNCTION notify_cache_invalidate();
