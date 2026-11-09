/**
 * Provider × step-type performance from measured attempt telemetry (execution_attempt_telemetry). Observational only:
 * groups below `minSamples` attempts are reported but never ranked, cost-unknown attempts are counted as such (never as
 * $0), and the "best" provider per step type is named only when every compared group has enough samples. Routing
 * changes still go through the existing controlled recommendations + optimization policies (eval/optimization.ts).
 */
import { pool, q, type Db } from "../db/pool.ts";

export async function providerPerformance(o: { days?: number; ownerId?: number | null; minSamples?: number } = {}, db: Db = pool) {
  const days = Math.min(365, Math.max(1, Math.round(o.days ?? 30)));
  const minSamples = Math.max(10, o.minSamples ?? 20);
  const rows = await q<any>(
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
    cost_per_successful_completion: r.completed_with_cost ? Math.round((Number(r.completed_cost) / r.completed_with_cost) * 1e4) / 1e4 : null,
    p50_ms: r.p50_ms != null ? Math.round(Number(r.p50_ms)) : null,
    p95_ms: r.p95_ms != null ? Math.round(Number(r.p95_ms)) : null,
  }));
  // A "leader" per step type only when ≥2 providers each have enough samples; never across step types.
  const leaders = [...new Set(groups.map((g) => g.step_type))].map((type) => {
    const g = groups.filter((x) => x.step_type === type);
    const eligible = g.filter((x) => x.sample_ok && x.success_rate != null);
    if (eligible.length < 2 || eligible.length !== g.length) return { step_type: type, leader: null, reason: `needs ≥${minSamples} attempts for every provider of this step type` };
    const best = [...eligible].sort((a, b) => (b.success_rate! - a.success_rate!) || ((a.cost_per_successful_completion ?? Infinity) - (b.cost_per_successful_completion ?? Infinity)))[0];
    return { step_type: type, leader: best.provider, reason: "highest attempt success rate, then lower cost per success (observational: tasks differ)" };
  });
  return { window_days: days, min_samples: minSamples, groups, leaders, note: "Attempt-level, observational. Route only through controlled recommendations; cost_per_successful_completion excludes unknown-cost attempts (see unknown_cost_rate)." };
}
