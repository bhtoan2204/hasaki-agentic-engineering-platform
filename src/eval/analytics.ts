import { pool, q } from "../db/pool.ts";
import { CacheAside } from "../cache/index.ts";
import { audit, wantsSupport, type Actor } from "../authz/access.ts";
import { parseAnalyticsFilters } from "../api/analytics/filters.ts";
import { HttpError } from "../http/error.ts";

const cache = new CacheAside<any>(
  "agent.evaluation.analytics",
  [
    "evaluation_runs",
    "eval_results",
    "workflow_step_attempts",
    "workflow_runs",
    "provider_handoffs",
  ],
  30000,
  100,
);
export function evaluationFilters(actor: Actor, url: URL) {
  const f = parseAnalyticsFilters(url.searchParams),
    all = wantsSupport(actor, url.searchParams.get("scope"));
  const bounded = (key: string) => {
    const v = url.searchParams.get(key) || null;
    if (v && v.length > 160) throw new HttpError(400, `Invalid ${key}`);
    return v;
  };
  return {
    ...f,
    all,
    owner: actor.id,
    category: bounded("category"),
    difficulty: bounded("difficulty"),
    variant: bounded("context_variant"),
    cohort: bounded("cohort"),
  };
}
export type EvaluationFilters = ReturnType<typeof evaluationFilters>;
function params(f: EvaluationFilters) {
  return [
    f.from,
    f.to,
    f.timezone,
    f.owner,
    f.all,
    f.provider,
    f.model,
    f.category,
    f.difficulty,
    f.variant,
    f.cohort,
    f.user,
    f.workflow,
    f.repository,
    f.project,
    f.service,
  ];
}
const base = `WITH p AS (SELECT $1::text AS lo,$2::text AS hi,$3::text AS tz,$4::bigint AS owner,$5::boolean AS team,$6::text AS provider,$7::text AS model,$8::text AS category,$9::text AS difficulty,$10::text AS variant,$11::text AS cohort,$12::bigint AS usr,$13::text AS workflow,$14::text AS repository,$15::text AS project,$16::text AS service),
samples AS MATERIALIZED (SELECT s.* FROM evaluation_analytics_samples s CROSS JOIN p
 WHERE (p.team OR s.owner_id=p.owner) AND (p.usr IS NULL OR s.owner_id=p.usr)
 AND s.created_at>=CASE WHEN length(p.lo)=10 THEN p.lo::timestamp AT TIME ZONE p.tz ELSE p.lo::timestamptz END
 AND s.created_at<CASE WHEN length(p.hi)=10 THEN p.hi::timestamp AT TIME ZONE p.tz ELSE p.hi::timestamptz END
 AND(p.provider IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.configuration->'provider_sequence') v WHERE v->>'provider'=p.provider) OR s.configuration->>'provider'=p.provider)
 AND(p.model IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.configuration->'provider_sequence') v WHERE v->>'model'=p.model) OR s.configuration->>'model'=p.model OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.observed_models) observed WHERE observed->>'model'=p.model))
 AND(p.category IS NULL OR s.category=p.category) AND(p.difficulty IS NULL OR s.difficulty=p.difficulty)
 AND(p.variant IS NULL OR s.context_variant=p.variant) AND(p.cohort IS NULL OR s.constraints_hash=p.cohort)
 AND(p.workflow IS NULL OR s.definition_key=p.workflow) AND(p.repository IS NULL OR p.repository=ANY(s.selected_repositories))
 AND(p.project IS NULL OR p.project=(SELECT inputs->>'project' FROM workflow_runs WHERE id=s.workflow_run_id))
 AND(p.service IS NULL OR EXISTS(SELECT 1 FROM workflow_runs r JOIN prod_error_groups g ON g.work_item_id=r.work_item_id WHERE r.id=s.workflow_run_id AND g.service=p.service)))`;
const aggregates = `count(*)::int AS samples,count(DISTINCT evaluation_id)::int AS evaluations,count(DISTINCT task_id)::int AS distinct_tasks,
 count(result_id)::int AS recorded,count(*) FILTER(WHERE result_status='BLOCKED')::int AS blocked,
 count(*) FILTER(WHERE correct IS NOT NULL AND result_status<>'BLOCKED')::int AS graded,
 count(*) FILTER(WHERE correct AND hard_gates_passed)::int AS successes,
 avg((correct AND hard_gates_passed)::int) FILTER(WHERE correct IS NOT NULL AND result_status<>'BLOCKED')::double precision AS verified_success_rate,
 avg(quality_score) FILTER(WHERE result_status IN('PASS','FAIL'))::double precision AS mean_quality,
 jsonb_agg(DISTINCT observed_models) FILTER(WHERE observed_models IS NOT NULL) AS reported_model_sets,
 percentile_cont(0.5) WITHIN GROUP(ORDER BY COALESCE(completion_duration_ms,validator_duration_ms)) FILTER(WHERE result_status IN('PASS','FAIL')) AS median_ms,
 percentile_cont(0.95) WITHIN GROUP(ORDER BY COALESCE(completion_duration_ms,validator_duration_ms)) FILTER(WHERE result_status IN('PASS','FAIL')) AS p95_ms,
 sum(active_ms)::double precision AS active_execution_ms,sum(queue_ms)::double precision AS queue_ms,sum(human_ms)::double precision AS human_ms,sum(tool_ms)::double precision AS tool_ms,
 sum(input_tokens)::double precision AS input_tokens,sum(output_tokens)::double precision AS output_tokens,sum(cache_read_tokens)::double precision AS cache_read_tokens,sum(cache_creation_tokens)::double precision AS cache_creation_tokens,sum(reasoning_tokens)::double precision AS reasoning_tokens,
 sum(cost_usd)::double precision AS reported_cost_usd,count(cost_usd)::int AS cost_samples,count(input_tokens)::int AS token_samples,count(output_tokens)::int AS output_token_samples,
 sum(phase_attempts)::int AS phase_attempts,sum(cost_known)::int AS cost_attempts_known,sum(tokens_known)::int AS token_attempts_known,
 CASE WHEN count(cost_usd)=count(*) AND bool_and(cost_known=phase_attempts) THEN sum(cost_usd)/NULLIF(count(*) FILTER(WHERE correct AND hard_gates_passed),0) END::double precision AS cost_per_verified_success,
 sum(tool_calls)::double precision AS tool_calls,sum(tool_failures)::double precision AS tool_failures,
 sum(planned_switches)::int AS planned_switches,sum(recovery_handoffs)::int AS recovery_handoffs,
 avg((evidence->>'expected_passed')::double precision/NULLIF((evidence->>'expected_total')::double precision,0)) AS requirement_coverage,
 avg((evidence->>'required_passed')::double precision/NULLIF((evidence->>'required_passed')::double precision+(evidence->>'required_failed')::double precision,0)) AS acceptance_pass_rate,
 sum((evidence->>'regression_failed')::int)::int AS regression_failures,
 count(*) FILTER(WHERE evidence->>'authorized_changes'='false')::int AS invalid_modifications,
 count(*) FILTER(WHERE evidence->>'security'='false')::int AS security_violations,
 sum((evidence->>'human_interventions')::int)::int AS human_interventions,sum((evidence->>'retries')::int)::int AS retries,
 avg((evidence->'details'->>'build_passed')::boolean::int)::double precision AS build_success_rate,
 avg((evidence->'details'->>'context_relevance')::boolean::int)::double precision AS retrieval_accuracy`;
export async function evaluationAnalytics(actor: Actor, url: URL) {
  const f = evaluationFilters(actor, url);
  if (f.all)
    await audit(actor.id, "support.list", "agent-evaluation", "*", {
      filters: f,
    });
  const data = await cache.get(JSON.stringify(f), () => loadEvaluationAnalytics(f));
  return {
    ...data,
    filters: f,
    limitations: [
      "Fixture controls validate the harness, not provider quality.",
      "Live provider benchmarks remain blocked unless execution isolation and usage budgets are enforceable.",
      "Repeated tasks are clustered observations, not independent samples.",
      "Production comparisons are observational; missing verification is unknown.",
      "Syntax-only validation is not semantic SQL/proto compilation; build coverage may be unavailable.",
    ],
  };
}
export async function loadEvaluationAnalytics(f: EvaluationFilters) {
  const args = params(f);
  const [comparisons, context, difficulty, failures, details, production] = await Promise.all([
    q(
      pool,
      `${base} SELECT provider_path,model_path,category,context_variant,constraints_hash,evidence_kind,configuration->'provider_sequence' AS agent_plan,observed_models AS observed_model_group,${aggregates} FROM samples GROUP BY 1,2,3,4,5,6,7,8 ORDER BY category,provider_path LIMIT 500`,
      args,
    ),
    q(
      pool,
      `${base} SELECT provider_path,model_path,category,constraints_hash,context_variant,evidence_kind,configuration->'provider_sequence' AS agent_plan,observed_models AS observed_model_group,${aggregates} FROM samples GROUP BY 1,2,3,4,5,6,7,8 ORDER BY 1,5 LIMIT 500`,
      args,
    ),
    q(
      pool,
      `${base} SELECT difficulty,evidence_kind,${aggregates} FROM samples GROUP BY 1,2 ORDER BY 1`,
      args,
    ),
    q(
      pool,
      `${base} SELECT COALESCE(failure_class,'unreported') AS category,evidence_kind,count(*)::int AS samples FROM samples WHERE result_status IN ('FAIL','BLOCKED') GROUP BY 1,2 ORDER BY 3 DESC LIMIT 30`,
      args,
    ),
    q(
      pool,
      `${base} SELECT case_run_id,evaluation_id,workflow_run_id,task_id,category,difficulty,repetition,provider_path,model_path,context_variant,evidence_kind,result_status,correct,hard_gates_passed,quality_score,artifact_id,base_commit,count(*) OVER()::int AS total_rows FROM samples ORDER BY evaluation_id DESC,case_run_id LIMIT $17 OFFSET $18`,
      [...args, f.pageSize, (f.page - 1) * f.pageSize],
    ),
    observational(f),
  ]);
  return {
    comparisons,
    context,
    difficulty,
    failures,
    details,
    production,
    generated_at: new Date().toISOString(),
    pagination: {
      page: f.page,
      page_size: f.pageSize,
      total: details[0]?.total_rows ?? 0,
    },
  };
}
export async function observational(f: EvaluationFilters) {
  return q(
    pool,
    `WITH p AS(SELECT $1::text lo,$2::text hi,$3::text tz,$4::bigint owner,$5::boolean team,$6::text provider,$7::text model,$8::text category,$9::text difficulty,$10::text variant,$11::text cohort,$12::bigint usr,$13::text workflow,$14::text repository,$15::text project,$16::text service),
 a AS(SELECT t.*,s.type,s.key,r.definition_key,r.inputs->>'task_category' AS category,
 a.metrics->'verification'->>'passed' AS verification_passed,a.metrics->'independent_verification'->>'verdict' AS independent_verdict
 FROM execution_attempt_telemetry t JOIN workflow_step_attempts a ON a.id=t.attempt_id JOIN workflow_steps s ON s.id=t.step_id JOIN workflow_runs r ON r.id=t.run_id CROSS JOIN p
 WHERE t.owner_id IS NOT NULL AND(p.team OR t.owner_id=p.owner) AND(p.usr IS NULL OR t.owner_id=p.usr) AND NOT EXISTS(SELECT 1 FROM evaluation_runs e WHERE e.workflow_run_id=r.id)
 AND r.created_at>=CASE WHEN length(p.lo)=10 THEN p.lo::timestamp AT TIME ZONE p.tz ELSE p.lo::timestamptz END AND r.created_at<CASE WHEN length(p.hi)=10 THEN p.hi::timestamp AT TIME ZONE p.tz ELSE p.hi::timestamptz END
 AND(p.provider IS NULL OR t.provider=p.provider) AND(p.model IS NULL OR t.model=p.model) AND(p.category IS NULL OR r.inputs->>'task_category'=p.category)
 AND(p.workflow IS NULL OR r.definition_key=p.workflow) AND(p.repository IS NULL OR p.repository=ANY(r.selected_repositories)) AND(p.project IS NULL OR r.inputs->>'project'=p.project)
 AND(p.service IS NULL OR EXISTS(SELECT 1 FROM prod_error_groups g WHERE g.work_item_id=r.work_item_id AND g.service=p.service))
 AND p.difficulty IS NULL AND p.variant IS NULL AND p.cohort IS NULL AND s.type IN('agent','coding_agent') AND a.invalidated_at IS NULL AND a.status IN('COMPLETED','FAILED','CANCELED'))
 SELECT provider,model,COALESCE(category,'unlabeled') AS category,count(*)::int AS attempts,
 count(*) FILTER(WHERE verification_passed IN('true','false') OR independent_verdict IN('PASS','FAIL'))::int AS verified_coverage,
 avg((COALESCE(verification_passed='true',false) OR COALESCE(independent_verdict='PASS',false))::int) FILTER(WHERE verification_passed IN('true','false') OR independent_verdict IN('PASS','FAIL'))::double precision AS verified_success_rate,
 percentile_cont(0.5) WITHIN GROUP(ORDER BY provider_execution_ms) AS median_provider_ms,
 sum(reported_cost_usd)::double precision AS reported_cost_usd,count(reported_cost_usd)::int AS cost_known,
 count(*) FILTER(WHERE terminal_status='FAILED')::int AS failures FROM a GROUP BY 1,2,3 ORDER BY attempts DESC LIMIT 100`,
    params(f),
  );
}
export { base as evaluationSamplesCte, params as evaluationParams };
