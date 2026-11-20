/**
 * Provider × step-type performance from measured attempt telemetry (execution_attempt_telemetry). Observational only:
 * groups below `minSamples` attempts are reported but never ranked, cost-unknown attempts are counted as such (never as
 * $0), and the "best" provider per step type is named only when every compared group has enough samples. Routing
 * changes still go through the existing controlled recommendations + optimization policies (eval/optimization.ts).
 */
import { pool, q, type Db } from "../db/pool.ts";

export async function providerPerformance(
  o: { days?: number; ownerId?: number | null; minSamples?: number } = {},
  db: Db = pool,
) {
  const days = Math.min(365, Math.max(1, Math.round(o.days ?? 30)));
  const minSamples = Math.max(10, o.minSamples ?? 20);
  const rows = await q<{
    provider: string;
    step_type: string;
    attempts: number;
    completed: number;
    failed: number;
    cost_unknown: number;
    completed_cost: string | number | null;
    completed_with_cost: number;
    p50_ms: number | null;
    p95_ms: number | null;
    with_repairs: number;
    verified: number;
    verified_pass: number;
    reviews: number;
    review_pass: number;
    handoffs: number;
  }>(
    db,
    `SELECT coalesce(t.provider, 'unknown') AS provider, s.type AS step_type,
            count(*)::int AS attempts,
            count(*) FILTER (WHERE t.status = 'COMPLETED')::int AS completed,
            count(*) FILTER (WHERE t.status = 'FAILED')::int AS failed,
            count(*) FILTER (WHERE t.reported_cost_usd IS NULL)::int AS cost_unknown,
            sum(t.reported_cost_usd) FILTER (WHERE t.status = 'COMPLETED') AS completed_cost,
            count(*) FILTER (WHERE t.status = 'COMPLETED' AND t.reported_cost_usd IS NOT NULL)::int AS completed_with_cost,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY t.wall_duration_ms) AS p50_ms,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY t.wall_duration_ms) AS p95_ms,
            count(*) FILTER (WHERE coalesce((a.metrics->'verification'->>'repairs')::int, 0) > 0)::int AS with_repairs,
            count(*) FILTER (WHERE a.metrics->'verification' ? 'passed')::int AS verified,
            count(*) FILTER (WHERE (a.metrics->'verification'->>'passed')::boolean IS TRUE)::int AS verified_pass,
            count(*) FILTER (WHERE a.output->>'verdict' IS NOT NULL)::int AS reviews,
            count(*) FILTER (WHERE a.output->>'verdict' = 'PASS')::int AS review_pass,
            count(h.id)::int AS handoffs
       FROM execution_attempt_telemetry t
       JOIN workflow_step_attempts a ON a.id = t.attempt_id
       JOIN workflow_steps s ON s.id = t.step_id
       JOIN workflow_runs r ON r.id = t.run_id
       LEFT JOIN provider_handoffs h ON h.source_attempt_id = t.attempt_id
      WHERE s.type IN ('agent', 'coding_agent') AND t.start_time > now() - make_interval(days => $1)
        AND ($2::bigint IS NULL OR r.owner_id = $2)
        AND NOT EXISTS (SELECT 1 FROM evaluation_runs e WHERE e.workflow_run_id = r.id)
      GROUP BY 1, 2 ORDER BY 2, 1`,
    [days, o.ownerId ?? null],
  );
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const groups = rows.map((r) => ({
    provider: r.provider,
    step_type: r.step_type,
    attempts: r.attempts,
    sample_ok: r.attempts >= minSamples,
    success_rate: pct(r.completed, r.attempts),
    failure_rate: pct(r.failed, r.attempts),
    handoff_rate: pct(r.handoffs, r.attempts),
    repair_loop_rate: pct(r.with_repairs, r.attempts),
    verification_pass_rate: pct(r.verified_pass, r.verified),
    review_pass_rate: pct(r.review_pass, r.reviews),
    unknown_cost_rate: pct(r.cost_unknown, r.attempts),
    cost_per_successful_completion: r.completed_with_cost
      ? Math.round((Number(r.completed_cost) / r.completed_with_cost) * 1e4) / 1e4
      : null,
    p50_ms: r.p50_ms != null ? Math.round(Number(r.p50_ms)) : null,
    p95_ms: r.p95_ms != null ? Math.round(Number(r.p95_ms)) : null,
  }));
  // A "leader" per step type only when ≥2 providers each have enough samples; never across step types.
  const leaders = [...new Set(groups.map((g) => g.step_type))].map((type) => {
    const g = groups.filter((x) => x.step_type === type);
    const eligible = g.filter((x) => x.sample_ok && x.success_rate != null);
    if (eligible.length < 2 || eligible.length !== g.length)
      return {
        step_type: type,
        leader: null,
        reason: `needs ≥${minSamples} attempts for every provider of this step type`,
      };
    const best = [...eligible].sort(
      (a, b) =>
        b.success_rate! - a.success_rate! ||
        (a.cost_per_successful_completion ?? Infinity) -
          (b.cost_per_successful_completion ?? Infinity),
    )[0];
    return {
      step_type: type,
      leader: best.provider,
      reason:
        "highest attempt success rate, then lower cost per success (observational: tasks differ)",
    };
  });
  return {
    window_days: days,
    min_samples: minSamples,
    groups,
    leaders,
    note: "Attempt-level, observational. Route only through controlled recommendations; cost_per_successful_completion excludes unknown-cost attempts (see unknown_cost_rate).",
  };
}

/** 95% Wilson interval of a success proportion: robust for small samples, never more confident than the data. */
export function wilson(successes: number, n: number, z = 1.96) {
  if (!n) return { low: 0, high: 1 };
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (c - r) / d), high: Math.min(1, (c + r) / d) };
}

export interface OutcomeGroup {
  definition_key: string;
  risk: "high" | "normal";
  provider: string;
  n: number;
  successes: number;
  unknown: number;
}

/**
 * Pure recommendation rule: within one workflow and risk class, a provider is recommended only when every compared
 * provider has ≥ minSamples known outcomes and its Wilson lower bound beats every other provider's upper bound.
 * Otherwise the existing default stays. Always a shadow proposal for an operator, never applied here.
 */
export function recommendFromOutcomes(groups: OutcomeGroup[], minSamples = 10) {
  const keys = [...new Set(groups.map((g) => `${g.definition_key}\u0000${g.risk}`))];
  return keys.map((k) => {
    const [definition_key, risk] = k.split("\u0000");
    const g = groups.filter((x) => x.definition_key === definition_key && x.risk === risk);
    const scored = g.map((x) => ({ ...x, ...wilson(x.successes, x.n) }));
    const base = { definition_key, risk, status: "shadow" as const, groups: scored };
    if (scored.length < 2)
      return { ...base, provider: null, reason: "only one provider observed: keep the default" };
    if (scored.some((x) => x.n < minSamples))
      return {
        ...base,
        provider: null,
        reason: `needs ≥${minSamples} verified outcomes per provider: keep the default`,
      };
    const [best, ...rest] = [...scored].sort((a, b) => b.low - a.low);
    if (rest.some((x) => x.high >= best.low))
      return {
        ...base,
        provider: null,
        reason: "intervals overlap: no provider is clearly better",
      };
    return {
      ...base,
      provider: best.provider,
      reason: `verified success lower bound ${(best.low * 100).toFixed(0)}% beats every other provider's upper bound`,
    };
  });
}

/**
 * Verified outcomes per workflow, risk class and provider. One outcome per work item (its latest finished run), so
 * repairs and re-runs are not counted as independent tasks. Success = run completed AND tests passed on the final
 * heads AND no later regression/rollback report; a run without test evidence is unknown (censored), not a failure.
 */
export async function outcomeRecommendations(
  o: { days?: number; minSamples?: number; ownerId?: number | null } = {},
  db: Db = pool,
) {
  const days = Math.min(365, Math.max(1, Math.round(o.days ?? 90)));
  const rows = await q<OutcomeGroup>(
    db,
    `WITH latest AS (
       SELECT DISTINCT ON (coalesce(r.work_item_id::text, 'run' || r.id)) r.id, r.definition_key, coalesce(r.agent_provider, 'claude') AS provider,
              CASE WHEN r.profile_decision->'complexity'->>'class' = 'HIGH_RISK' THEN 'high' ELSE 'normal' END AS risk
         FROM workflow_runs r
        WHERE r.status IN ('COMPLETED','FAILED','CANCELED') AND r.finished_at > now() - make_interval(days => $1)
          AND ($2::bigint IS NULL OR r.owner_id = $2)
          AND NOT EXISTS (SELECT 1 FROM evaluation_runs e WHERE e.workflow_run_id = r.id)
        ORDER BY coalesce(r.work_item_id::text, 'run' || r.id), r.id DESC),
     judged AS (
       SELECT l.*,
              EXISTS (SELECT 1 FROM outcome_observations o WHERE o.run_id = l.id AND o.kind IN ('tests_passed','tests_failed','run_failed','run_canceled')) AS known,
              EXISTS (SELECT 1 FROM outcome_observations o WHERE o.run_id = l.id AND o.kind = 'run_completed')
                AND EXISTS (SELECT 1 FROM outcome_observations o WHERE o.run_id = l.id AND o.kind = 'tests_passed'
                              AND NOT EXISTS (SELECT 1 FROM outcome_observations n WHERE n.supersedes = o.id))
                AND NOT EXISTS (SELECT 1 FROM outcome_observations o WHERE o.run_id = l.id AND o.kind IN ('regression_reported','rollback_reported')) AS success
         FROM latest l)
     SELECT definition_key, risk, provider, count(*) FILTER (WHERE known)::int AS n,
            count(*) FILTER (WHERE known AND success)::int AS successes, count(*) FILTER (WHERE NOT known)::int AS unknown
       FROM judged GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
    [days, o.ownerId ?? null],
  );
  return {
    window_days: days,
    recommendations: recommendFromOutcomes(rows, Math.max(5, o.minSamples ?? 10)),
    note: "Shadow only: an operator applies a change through the existing optimization policies; the default stays otherwise. Cost is not part of this ranking (unknown cost is never $0).",
  };
}
