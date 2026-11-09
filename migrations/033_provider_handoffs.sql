ALTER TABLE workflow_step_attempts ADD COLUMN executor_stopped_at timestamptz;
CREATE UNIQUE INDEX handoff_artifact_identity ON workflow_artifacts(attempt_id,name) WHERE kind='provider_handoff';
CREATE TABLE provider_handoffs (
 id bigserial PRIMARY KEY,
 run_id bigint NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
 step_id bigint NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
 source_attempt_id bigint NOT NULL UNIQUE REFERENCES workflow_step_attempts(id) ON DELETE CASCADE,
 target_attempt_id bigint UNIQUE REFERENCES workflow_step_attempts(id),
 generation integer NOT NULL,
 original_provider text NOT NULL,
 target_provider text,
 reason text NOT NULL,
 failure_category text,
 status text NOT NULL CHECK(status IN ('STOPPING','READY','RESUMED','BLOCKED')),
 package jsonb,
 workspace_fingerprint text,
 requested_by bigint REFERENCES users(id),
 resumed_by bigint REFERENCES users(id),
 automatic boolean NOT NULL DEFAULT false,
 blocked_reason text,
 next_check_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 ready_at timestamptz,
 resumed_at timestamptz
);
CREATE INDEX provider_handoffs_pending ON provider_handoffs(next_check_at,id) WHERE status='READY' AND automatic;
CREATE VIEW provider_handoff_metrics AS
SELECT h.id,h.run_id,h.step_id,r.owner_id,h.source_attempt_id,h.target_attempt_id,h.original_provider,h.target_provider,
 h.reason,h.failure_category,h.status,h.automatic,h.created_at,h.ready_at,h.resumed_at,
 extract(epoch FROM (s.finished_at-s.started_at))*1000 AS previous_attempt_duration_ms,
 extract(epoch FROM (h.resumed_at-h.created_at))*1000 AS handoff_duration_ms,
 extract(epoch FROM (t.finished_at-t.started_at))*1000 AS new_attempt_duration_ms,
 GREATEST(0,t.number-1) AS retry_count,
 usage.input_tokens,usage.output_tokens,usage.cache_read_tokens,usage.cache_creation_tokens,usage.reasoning_tokens,usage.reported_cost_usd,usage.cost_availability,
 final.verification_result AS final_verification_result,t.status AS continuation_status,
 usage.attempts AS continuation_attempts,usage.provider_execution_ms AS continuation_provider_execution_ms
FROM provider_handoffs h JOIN workflow_runs r ON r.id=h.run_id
JOIN workflow_step_attempts s ON s.id=h.source_attempt_id
LEFT JOIN workflow_step_attempts t ON t.id=h.target_attempt_id
LEFT JOIN LATERAL (
 SELECT sum(m.input_tokens)::double precision AS input_tokens,sum(m.output_tokens)::double precision AS output_tokens,
 sum(m.cache_read_tokens)::double precision AS cache_read_tokens,sum(m.cache_creation_tokens)::double precision AS cache_creation_tokens,
 sum(m.reasoning_tokens)::double precision AS reasoning_tokens,sum(m.reported_cost_usd)::double precision AS reported_cost_usd,
 sum(m.provider_execution_ms)::double precision AS provider_execution_ms,count(*)::int AS attempts,
 CASE WHEN count(m.reported_cost_usd)=0 THEN 'unavailable' WHEN count(m.reported_cost_usd)<count(*) OR bool_or(m.cost_availability='partial') THEN 'partial' ELSE 'reported' END AS cost_availability
 FROM workflow_step_attempts a JOIN execution_attempt_telemetry m ON m.attempt_id=a.id
 WHERE a.step_id=h.step_id AND a.generation=h.generation AND a.number>=t.number
 AND a.number<COALESCE((SELECT a2.number FROM provider_handoffs h2 JOIN workflow_step_attempts a2 ON a2.id=h2.target_attempt_id WHERE h2.step_id=h.step_id AND h2.id>h.id ORDER BY h2.id LIMIT 1),2147483647)
) usage ON true
LEFT JOIN LATERAL (
 SELECT m.verification_result FROM workflow_step_attempts a JOIN execution_attempt_telemetry m ON m.attempt_id=a.id
 WHERE a.step_id=h.step_id AND a.generation=h.generation AND a.number>=t.number ORDER BY a.number DESC LIMIT 1
) final ON true;
