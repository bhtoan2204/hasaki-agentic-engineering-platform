import { pool, q, one } from "../../db/pool.ts";
import {
  boundsSql,
  bucketSql,
  filterParams,
  type AnalyticsFilters,
  type AnalyticsScope,
} from "./filters.ts";

/** One cohort for all engineering tabs. Repository membership never multiplies attempts. */
export const executionCte = `WITH ${boundsSql},
run_candidates AS MATERIALIZED (
 SELECT r.*, u.username, COALESCE(NULLIF(w.project,''),NULLIF(r.inputs->>'project',''),'unknown') AS project,
   w.code AS work_item_code, v.coding_steps, v.checked_steps, v.passed_steps,
   CASE WHEN v.coding_steps>0 AND v.checked_steps=v.coding_steps THEN v.passed_steps=v.coding_steps END AS verified
 FROM workflow_runs r JOIN users u ON u.id=r.owner_id LEFT JOIN work_items w ON w.id=r.work_item_id
 CROSS JOIN bounds b
 LEFT JOIN LATERAL (
   SELECT count(*)::int AS coding_steps,
     count(*) FILTER (WHERE a.metrics->'verification'->>'passed' IN ('true','false') OR a.metrics->'independent_verification'->>'verdict' IN ('PASS','FAIL'))::int AS checked_steps,
     count(*) FILTER (WHERE a.metrics->'verification'->>'passed'='true' OR a.metrics->'independent_verification'->>'verdict'='PASS')::int AS passed_steps
   FROM workflow_steps s LEFT JOIN LATERAL (
     SELECT a.metrics FROM workflow_step_attempts a WHERE a.step_id=s.id AND a.invalidated_at IS NULL ORDER BY a.id DESC LIMIT 1
   ) a ON true WHERE s.run_id=r.id AND s.type='coding_agent'
 ) v ON true
 WHERE r.created_at>=b.lo AND r.created_at<b.hi AND r.owner_id IS NOT NULL AND ($6::boolean OR r.owner_id=$5::bigint)
   AND ($9::bigint IS NULL OR r.owner_id=$9) AND ($10::text IS NULL OR r.definition_key=$10)
   AND ($11::text IS NULL OR $11=ANY(r.selected_repositories))
   AND ($12::text IS NULL OR COALESCE(NULLIF(w.project,''),NULLIF(r.inputs->>'project',''),'unknown')=$12)
   AND ($13::text IS NULL OR EXISTS(SELECT 1 FROM prod_error_groups pg WHERE pg.work_item_id=r.work_item_id AND pg.service=$13))
),
attempt_candidates AS MATERIALIZED (
 SELECT t.*, a.metrics, COALESCE(a.input->'pending' ? 'resume',false) AS is_resume, a.invalidated_at, a.context_snapshot_id, s.key AS step_key, s.type AS step_type,
        r.definition_key, r.username, r.project, r.selected_repositories, r.work_item_id, r.verified, r.status AS run_status,
        (SELECT sum(value::numeric) FROM jsonb_each_text(COALESCE(t.tool_calls,'{}'::jsonb))) AS tool_call_count,
        COALESCE((a.metrics->>'context_preparation_ms')::double precision,(cs.content->>'preparation_duration_ms')::double precision) AS context_preparation_ms
 FROM run_candidates r JOIN execution_attempt_telemetry t ON t.run_id=r.id
 JOIN workflow_step_attempts a ON a.id=t.attempt_id JOIN workflow_steps s ON s.id=t.step_id
 LEFT JOIN context_snapshots cs ON cs.id=a.context_snapshot_id
),
usage_candidates AS MATERIALIZED (
 SELECT a.attempt_id,a.run_id,a.step_id,a.step_key,a.start_time,a.definition_key,a.owner_id,a.username,a.project,a.selected_repositories,
  a.work_item_id,a.verified,a.run_status,s.k AS invocation_id,(s.v->>'start_time')::timestamptz AS invocation_time,
  COALESCE(s.v->>'provider',a.provider) AS provider,
  CASE WHEN s.v IS NOT NULL THEN s.v->>'model' ELSE a.model END AS model,
  CASE WHEN s.v IS NOT NULL THEN (s.v->'tokens'->>'input')::numeric ELSE a.input_tokens END AS input_tokens,
  CASE WHEN s.v IS NOT NULL THEN (s.v->'tokens'->>'output')::numeric ELSE a.output_tokens END AS output_tokens,
  CASE WHEN s.v IS NOT NULL THEN (s.v->'tokens'->>'cache_read')::numeric ELSE a.cache_read_tokens END AS cache_read_tokens,
  CASE WHEN s.v IS NOT NULL THEN (s.v->'tokens'->>'cache_creation')::numeric ELSE a.cache_creation_tokens END AS cache_creation_tokens,
  CASE WHEN s.v IS NOT NULL THEN (s.v->'tokens'->>'reasoning_output')::numeric ELSE a.reasoning_tokens END AS reasoning_tokens,
  CASE WHEN s.v IS NOT NULL THEN (s.v->>'reported_cost_usd')::numeric ELSE a.reported_cost_usd END AS reported_cost_usd,
  CASE WHEN s.v IS NOT NULL THEN (s.v->>'provider_execution_ms')::double precision ELSE a.provider_execution_ms END AS provider_execution_ms,
  CASE WHEN s.v IS NOT NULL THEN s.v->>'normalized_failure_category' ELSE a.normalized_failure_category END AS failure_category,
  CASE WHEN s.v IS NOT NULL THEN COALESCE((s.v->>'complete')::boolean,false) ELSE false END AS invocation_complete
 FROM attempt_candidates a LEFT JOIN LATERAL jsonb_each(COALESCE(a.provider_sessions,'{}'::jsonb)) s(k,v) ON true
),
usage AS MATERIALIZED (SELECT * FROM usage_candidates WHERE ($7::text IS NULL OR provider=$7) AND ($8::text IS NULL OR model=$8)),
attempts AS MATERIALIZED (
 SELECT a.* FROM attempt_candidates a WHERE ($7::text IS NULL AND $8::text IS NULL)
  OR EXISTS(SELECT 1 FROM usage u WHERE u.attempt_id=a.attempt_id)
),
runs AS MATERIALIZED (
 SELECT r.* FROM run_candidates r WHERE ($7::text IS NULL AND $8::text IS NULL)
  OR EXISTS(SELECT 1 FROM usage u WHERE u.run_id=r.id)
  OR ($8::text IS NULL AND r.agent_provider=$7 AND NOT EXISTS(SELECT 1 FROM attempt_candidates a WHERE a.run_id=r.id))
)`;

const usageFields = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "reasoning_tokens",
  "reported_cost_usd",
];
const usageAggregate = usageFields
  .map((k) => `sum(${k}) AS ${k}, count(*) FILTER(WHERE ${k} IS NULL)::int AS missing_${k}`)
  .join(",\n");
const pagination = (f: AnalyticsFilters) =>
  `LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`;
const moneyRatios = `sum(reported_cost_usd) FILTER(WHERE run_status='COMPLETED')/NULLIF(count(DISTINCT run_id) FILTER(WHERE run_status='COMPLETED'),0) AS cost_per_successful_run,
 sum(reported_cost_usd) FILTER(WHERE run_status='COMPLETED' AND verified)/NULLIF(count(DISTINCT work_item_id) FILTER(WHERE run_status='COMPLETED' AND verified),0) AS cost_per_verified_task`;

export async function usageAnalytics(f: AnalyticsFilters, scope: AnalyticsScope) {
  const params = filterParams(f, scope);
  // Repository attribution is full membership, not an invented allocation. A multi-repo run appears in each bucket.
  const groups = {
    provider: "provider",
    model: "COALESCE(provider,'unknown')||' / '||COALESCE(model,'unknown')",
    user: "username",
    workflow: "definition_key",
    project: "project",
    repository: "repo.name",
  };
  const repoJoin =
    f.groupBy === "repository"
      ? "LEFT JOIN LATERAL unnest(CASE WHEN cardinality(selected_repositories)>0 THEN selected_repositories ELSE ARRAY['unknown'] END) repo(name) ON true"
      : "";
  const [summary, trend, breakdown, details] = await Promise.all([
    one(
      pool,
      `${executionCte} SELECT count(*)::int AS invocations,count(DISTINCT attempt_id)::int AS attempts,${usageAggregate},${moneyRatios},(SELECT count(*)::int FROM (SELECT ${groups[f.groupBy]} FROM usage ${repoJoin} GROUP BY 1) g) AS breakdown_total FROM usage`,
      params,
    ),
    q(
      pool,
      `${executionCte} SELECT ${bucketSql("start_time")} AS bucket,${usageAggregate},count(*)::int AS invocations FROM usage GROUP BY 1 ORDER BY 1`,
      params,
    ),
    q(
      pool,
      `${executionCte} SELECT ${groups[f.groupBy]} AS dimension,${usageAggregate},count(*)::int AS invocations,count(DISTINCT run_id)::int AS runs,
      count(*) OVER()::int AS total_rows FROM usage ${repoJoin} GROUP BY 1 ORDER BY sum(reported_cost_usd) DESC NULLS LAST,1 ${pagination(f)}`,
      params,
    ),
    q(
      pool,
      `${executionCte}, reference AS (SELECT provider,model,percentile_cont(0.5) WITHIN GROUP(ORDER BY input_tokens+output_tokens) AS median_tokens,count(input_tokens+output_tokens) AS n FROM usage GROUP BY 1,2)
      SELECT u.run_id,u.step_key,u.attempt_id,u.provider,u.model,u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_creation_tokens,u.reasoning_tokens,u.reported_cost_usd,u.start_time,
      CASE WHEN ref.n>=5 AND u.input_tokens+u.output_tokens>GREATEST(10000,ref.median_tokens*3) THEN true ELSE false END AS token_anomaly,
      count(*) OVER()::int AS total_rows FROM usage u LEFT JOIN reference ref ON ref.provider IS NOT DISTINCT FROM u.provider AND ref.model IS NOT DISTINCT FROM u.model
      ORDER BY token_anomaly DESC,u.start_time DESC,u.attempt_id DESC,u.invocation_id DESC NULLS LAST ${pagination(f)}`,
      params,
    ),
  ]);
  return {
    summary,
    trend,
    breakdown,
    details,
    cost_source: "provider_reported_estimate",
    group_by: f.groupBy,
    repository_attribution: "full_run_membership",
  };
}

export async function performanceAnalytics(f: AnalyticsFilters, scope: AnalyticsScope) {
  const params = filterParams(f, scope);
  const [summary, comparison, failures, details] = await Promise.all([
    one(
      pool,
      `${executionCte} SELECT
      (SELECT count(*)::int FROM runs) AS runs,
      (SELECT count(DISTINCT (provider,model))::int FROM usage) AS comparison_total,
      (SELECT count(*)::int FROM runs WHERE status='COMPLETED') AS completed_runs,
      (SELECT count(*)::int FROM runs WHERE verified AND status='COMPLETED') AS verified_runs,
      (SELECT count(*)::int FROM runs WHERE checked_steps=coding_steps AND coding_steps>0) AS evaluated_runs,
      (SELECT count(DISTINCT work_item_id)::int FROM runs WHERE verified AND status='COMPLETED') AS verified_tasks,
      (SELECT percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM(finished_at-started_at))*1000) FROM runs WHERE finished_at IS NOT NULL) AS workflow_p95_ms,
      count(*)::int AS attempts,count(*) FILTER(WHERE number>1 AND NOT is_resume)::int AS retried_attempts,
      (SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY provider_execution_ms) FROM usage) AS execution_p50_ms,
      (SELECT percentile_cont(0.95) WITHIN GROUP(ORDER BY provider_execution_ms) FROM usage) AS execution_p95_ms,
      avg(queue_duration_ms) AS queue_ms,avg(human_wait_ms) AS human_wait_ms,avg(tool_execution_ms) AS tool_ms,
      sum(tool_failures) AS tool_failures,sum(tool_call_count) AS tool_calls,
      count(*) FILTER(WHERE provider_execution_ms IS NULL)::int AS missing_execution,
      count(*) FILTER(WHERE queue_duration_ms IS NULL)::int AS missing_queue,
      count(*) FILTER(WHERE human_wait_ms IS NULL)::int AS missing_human,
      count(*) FILTER(WHERE tool_execution_ms IS NULL)::int AS missing_tools
      FROM attempts`,
      params,
    ),
    q(
      pool,
      `${executionCte} SELECT provider,model,count(*)::int AS invocations,count(DISTINCT run_id)::int AS runs,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY provider_execution_ms) AS execution_p50_ms,
      percentile_cont(0.95) WITHIN GROUP(ORDER BY provider_execution_ms) AS execution_p95_ms,
      count(*) FILTER(WHERE failure_category IS NOT NULL)::int AS failures,
      count(DISTINCT run_id) FILTER(WHERE run_status='COMPLETED')::int AS completed_runs,
      count(DISTINCT run_id) FILTER(WHERE run_status='COMPLETED' AND verified)::int AS verified_runs,
      count(*) OVER()::int AS total_rows FROM usage GROUP BY 1,2 ORDER BY count(*) DESC,1,2 ${pagination(f)}`,
      params,
    ),
    q(
      pool,
      `${executionCte} SELECT COALESCE(normalized_failure_category,'UNKNOWN') AS category,count(*)::int AS attempts FROM attempts WHERE normalized_failure_category IS NOT NULL OR status IN ('FAILED','CANCELED') GROUP BY 1 ORDER BY 2 DESC`,
      params,
    ),
    q(
      pool,
      `${executionCte} SELECT attempt_id,run_id,step_key,provider,model,status,provider_execution_ms,wall_duration_ms,queue_duration_ms,human_wait_ms,tool_execution_ms,normalized_failure_category,
       count(*) OVER()::int AS total_rows FROM attempts ORDER BY start_time DESC,attempt_id DESC ${pagination(f)}`,
      params,
    ),
  ]);
  return { summary, comparison, failures, details };
}

export async function workflowAnalytics(f: AnalyticsFilters, scope: AnalyticsScope) {
  const params = filterParams(f, scope);
  const [workflows, steps, trend, evidence, details] = await Promise.all([
    q(
      pool,
      `${executionCte} SELECT definition_key AS workflow,count(*)::int AS runs,count(*) FILTER(WHERE status='COMPLETED')::int AS completed_runs,
      count(*) FILTER(WHERE verified AND status='COMPLETED')::int AS verified_runs,
      avg(extract(epoch FROM(finished_at-started_at))*1000) AS workflow_ms,
      count(*) OVER()::int AS total_rows FROM runs GROUP BY 1 ORDER BY count(*) DESC,1 ${pagination(f)}`,
      params,
    ),
    q(
      pool,
      `${executionCte} SELECT definition_key AS workflow,step_key,count(*)::int AS attempts,
      count(*) FILTER(WHERE number>1 AND NOT is_resume)::int AS retries,
      count(*) FILTER(WHERE status IN ('WAITING_INPUT','WAITING_APPROVAL') OR human_wait_ms>0)::int AS blocked,
      avg(provider_execution_ms) AS execution_ms,avg(context_preparation_ms) AS context_preparation_ms,
      count(context_preparation_ms)::int AS measured_context,
      avg(human_wait_ms) FILTER(WHERE step_type='human_approval' OR status='WAITING_APPROVAL') AS approval_wait_ms,
      avg(human_wait_ms) AS human_wait_ms,count(*) OVER()::int AS total_rows
      FROM attempts GROUP BY 1,2 ORDER BY avg(provider_execution_ms) DESC NULLS LAST,1,2 ${pagination(f)}`,
      params,
    ),
    q(
      pool,
      `${executionCte} SELECT ${bucketSql("r.finished_at")} AS bucket,count(*)::int AS completed_runs,
      count(*) FILTER(WHERE r.verified)::int AS verified_runs
      FROM runs r CROSS JOIN bounds b WHERE r.status='COMPLETED' AND r.finished_at>=b.lo AND r.finished_at<b.hi GROUP BY 1 ORDER BY 1`,
      params,
    ),
    one(
      pool,
      `${executionCte} SELECT
      (SELECT count(*)::int FROM runs) AS runs,
      (SELECT count(DISTINCT definition_key)::int FROM runs) AS workflows,
      (SELECT count(DISTINCT (definition_key,step_key))::int FROM attempts) AS step_groups,
      (SELECT avg((er.data->'evidence'->>'repository_correct')::boolean::int) FROM eval_results er JOIN evaluation_case_runs cr ON cr.id=er.case_run_id
        JOIN evaluation_runs e ON e.id=cr.evaluation_id JOIN runs r ON r.id=e.workflow_run_id
        WHERE er.owner_id=r.owner_id AND er.data->'evidence'->>'repository_correct' IN ('true','false')) AS repository_accuracy,
      (SELECT count(*)::int FROM eval_results er JOIN evaluation_case_runs cr ON cr.id=er.case_run_id JOIN evaluation_runs e ON e.id=cr.evaluation_id JOIN runs r ON r.id=e.workflow_run_id
        WHERE er.owner_id=r.owner_id AND er.data->'evidence'->>'repository_correct' IN ('true','false')) AS labeled_repositories,
      (SELECT sum(switches)::int FROM (SELECT count(*) FILTER(WHERE previous IS NOT NULL AND provider<>previous) AS switches
        FROM (SELECT run_id,provider,lag(provider) OVER(PARTITION BY run_id ORDER BY invocation_time,attempt_id,invocation_id) AS previous FROM usage WHERE invocation_time IS NOT NULL) x GROUP BY run_id) x) AS agent_switches,
      count(*) FILTER(WHERE context_preparation_ms IS NULL)::int AS missing_context FROM attempts`,
      params,
    ),
    q(
      pool,
      `${executionCte} SELECT id AS run_id,title,definition_key AS workflow,status,verified,work_item_id,created_at,
      count(*) OVER()::int AS total_rows FROM runs ORDER BY created_at DESC,id DESC ${pagination(f)}`,
      params,
    ),
  ]);
  // Include failures even on days with no completed runs.
  const verificationTrend = await q(
    pool,
    `${executionCte} SELECT ${bucketSql("start_time")} AS bucket,count(*) FILTER(WHERE metrics->'verification'->>'passed'='false' OR metrics->'independent_verification'->>'verdict'='FAIL')::int AS failures,
    count(*) FILTER(WHERE metrics->'verification'->>'passed' IN ('true','false') OR metrics->'independent_verification'->>'verdict' IN ('PASS','FAIL'))::int AS evaluated FROM attempts GROUP BY 1 ORDER BY 1`,
    params,
  );
  const hotspots = await one(
    pool,
    `${executionCte}, step_stats AS (
    SELECT definition_key||' / '||step_key AS dimension,
      count(*) FILTER(WHERE number>1 AND NOT is_resume)::int AS retries,
      count(*) FILTER(WHERE human_wait_ms>0 OR status IN ('WAITING_INPUT','WAITING_APPROVAL'))::int AS blocked,
      avg(human_wait_ms) FILTER(WHERE step_type='human_approval' OR status='WAITING_APPROVAL') AS approval_ms
    FROM attempts GROUP BY definition_key,step_key)
    SELECT (SELECT COALESCE(jsonb_agg(x),'[]') FROM (SELECT * FROM step_stats WHERE retries>0 ORDER BY retries DESC,dimension LIMIT 10) x) AS retries,
      (SELECT COALESCE(jsonb_agg(x),'[]') FROM (SELECT * FROM step_stats WHERE blocked>0 ORDER BY blocked DESC,dimension LIMIT 10) x) AS blocked,
      (SELECT COALESCE(jsonb_agg(x),'[]') FROM (SELECT * FROM step_stats WHERE approval_ms>0 ORDER BY approval_ms DESC,dimension LIMIT 10) x) AS approvals`,
    params,
  );
  return {
    workflows,
    steps,
    trend,
    verification_trend: verificationTrend,
    evidence,
    details,
    hotspots,
  };
}
