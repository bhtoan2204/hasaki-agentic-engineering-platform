-- Only agent steps inherit the run's agent provider: integration, command, human and report attempts used no agent
-- unless they recorded one, so they must not count as agent attempts without a reported cost.
CREATE OR REPLACE VIEW execution_attempt_telemetry AS
SELECT a.id AS attempt_id, a.run_id, a.step_id, a.number,
       COALESCE(a.agent_provider, a.metrics->>'provider', CASE WHEN s.type IN ('agent','coding_agent') THEN r.agent_provider END) AS provider,
       CASE WHEN cardinality(ps.models) > 1 THEN NULL ELSE COALESCE(ps.models[1], NULLIF(a.metrics->>'model', '')) END AS model, COALESCE(a.effective_agent->>'execution_profile', r.profile) AS execution_profile,
       r.owner_id, r.worker_instance, a.worker,
       a.started_at AS start_time, COALESCE(a.resolved_at, lifecycle.canceled_at, a.finished_at) AS end_time,
       a.telemetry_queue_duration_ms AS queue_duration_ms,
       CASE WHEN a.metrics ? 'provider_sessions' THEN ps.duration ELSE NULL END AS provider_execution_ms,
       tools.ms AS tool_execution_ms,
       CASE WHEN a.telemetry_wait_started_at IS NOT NULL
            THEN GREATEST(0, extract(epoch FROM (COALESCE(a.telemetry_wait_ended_at, lifecycle.canceled_at, now()) - a.telemetry_wait_started_at)) * 1000)
            WHEN a.status IN ('WAITING_INPUT','WAITING_APPROVAL') OR a.resolved_at IS NOT NULL THEN NULL ELSE 0 END::double precision AS human_wait_ms,
       GREATEST(0, extract(epoch FROM ((CASE WHEN a.status IN ('WAITING_INPUT','WAITING_APPROVAL') AND a.resolved_at IS NULL THEN COALESCE(lifecycle.canceled_at, now()) ELSE COALESCE(a.resolved_at, a.finished_at, now()) END) - a.started_at)) * 1000)::double precision AS wall_duration_ms,
       CASE WHEN a.metrics ? 'provider_sessions' THEN ps.input_tokens ELSE (a.metrics->'tokens'->>'input')::double precision END AS input_tokens,
       CASE WHEN a.metrics ? 'provider_sessions' THEN ps.output_tokens ELSE (a.metrics->'tokens'->>'output')::double precision END AS output_tokens,
       CASE WHEN a.metrics ? 'provider_sessions' THEN ps.cache_read_tokens ELSE (a.metrics->'tokens'->>'cache_read')::double precision END AS cache_read_tokens,
       CASE WHEN a.metrics ? 'provider_sessions' THEN ps.cache_creation_tokens ELSE (a.metrics->'tokens'->>'cache_creation')::double precision END AS cache_creation_tokens,
       CASE WHEN a.metrics ? 'provider_sessions' THEN ps.reasoning_tokens ELSE (a.metrics->'tokens'->>'reasoning_output')::double precision END AS reasoning_tokens,
       CASE WHEN a.metrics ? 'provider_sessions' THEN ps.cost ELSE (a.metrics->>'cost_usd')::double precision END AS reported_cost_usd,
       CASE WHEN (CASE WHEN a.metrics ? 'provider_sessions' THEN ps.cost ELSE (a.metrics->>'cost_usd')::double precision END) IS NULL THEN 'unavailable' ELSE 'provider_reported' END AS cost_source,
       CASE WHEN (CASE WHEN a.metrics ? 'provider_sessions' THEN ps.cost ELSE (a.metrics->>'cost_usd')::double precision END) IS NULL THEN 'unavailable' WHEN ps.missing_cost > 0 THEN 'partial' ELSE 'reported' END AS cost_availability,
       a.metrics->'tool_calls' AS tool_calls, (a.metrics->>'tool_errors')::int AS tool_failures,
       GREATEST(0, a.number - 1) AS retries,
       CASE WHEN lifecycle.canceled_at IS NOT NULL THEN 'CANCELED' ELSE a.status END AS status,
       CASE WHEN lifecycle.canceled_at IS NOT NULL THEN 'CANCELED' WHEN a.status IN ('RUNNING','WAITING_INPUT','WAITING_APPROVAL') THEN NULL ELSE a.status END AS terminal_status,
       CASE WHEN a.status = 'CANCELED' OR lifecycle.canceled_at IS NOT NULL THEN 'CANCELED' ELSE COALESCE(NULLIF(a.metrics->>'normalized_failure_category', 'UNKNOWN'),
         (SELECT value->>'normalized_failure_category' FROM jsonb_each(COALESCE(a.metrics->'provider_sessions', '{}'::jsonb)) WHERE value->>'normalized_failure_category' IS NOT NULL ORDER BY value->>'start_time' DESC LIMIT 1),
         CASE WHEN a.status = 'FAILED' THEN 'UNKNOWN' END) END AS normalized_failure_category,
       jsonb_build_object('queue_duration_ms', 'measured', 'provider_execution_ms', CASE WHEN a.metrics ? 'provider_sessions' THEN 'measured' ELSE 'unavailable' END,
         'tool_execution_ms', 'measured_event_intervals', 'wall_duration_ms', 'measured', 'human_wait_ms', 'measured',
         'tokens', 'provider_reported_or_unavailable', 'reported_cost_usd', 'provider_reported_estimate_or_unavailable') AS provenance,
       a.metrics->'verification' AS verification_result,
       a.metrics->'provider_sessions' AS provider_sessions,
       ps.missing_cost AS sessions_missing_cost, ps.sessions AS provider_invocations
FROM workflow_step_attempts a
JOIN workflow_runs r ON r.id = a.run_id
JOIN workflow_steps s ON s.id = a.step_id
LEFT JOIN LATERAL (SELECT CASE WHEN a.status IN ('WAITING_INPUT','WAITING_APPROVAL') AND r.status = 'CANCELED' THEN r.finished_at END AS canceled_at) lifecycle ON true
LEFT JOIN LATERAL (
 SELECT sum((v->>'provider_execution_ms')::double precision) AS duration,
        sum((v->>'reported_cost_usd')::double precision) AS cost,
        count(*) FILTER (WHERE v->>'reported_cost_usd' IS NULL)::int AS missing_cost,
        count(*)::int AS sessions,
        array_agg(DISTINCT NULLIF(v->>'model', '')) FILTER (WHERE v->>'model' IS NOT NULL) AS models,
        sum((v->'tokens'->>'input')::double precision) AS input_tokens,
        sum((v->'tokens'->>'output')::double precision) AS output_tokens,
        sum((v->'tokens'->>'cache_read')::double precision) AS cache_read_tokens,
        sum((v->'tokens'->>'cache_creation')::double precision) AS cache_creation_tokens,
        sum((v->'tokens'->>'reasoning_output')::double precision) AS reasoning_tokens
 FROM jsonb_each(COALESCE(a.metrics->'provider_sessions', '{}'::jsonb)) AS sessions(k,v)
) ps ON true
LEFT JOIN LATERAL (
 SELECT sum(extract(epoch FROM (upper(span) - lower(span))) * 1000)::double precision AS ms
 FROM unnest((
   SELECT range_agg(tstzrange(t.created_at, x.ended_at, '[)'))
   FROM workflow_events t
   JOIN LATERAL (SELECT min(e.created_at) AS ended_at FROM workflow_events e
     WHERE e.attempt_id = a.id AND e.kind = 'tool_result' AND e.data->>'tool_use_id' = t.data->>'id' AND e.created_at >= t.created_at) x ON x.ended_at IS NOT NULL
   WHERE t.attempt_id = a.id AND t.kind = 'tool'
 )) AS intervals(span)
) tools ON true;
