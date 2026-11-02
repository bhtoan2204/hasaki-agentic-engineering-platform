import { pool, q } from "../db/pool.ts";

/** Observability queries over workflow_step_attempts.metrics (+ timestamps for every step type). */

export async function runMetrics(runId: number) {
  const attempts = await q(
    pool,
    `SELECT a.id, s.key AS step_key, s.type AS step_type, a.number, a.status, a.started_at, a.finished_at,
            (extract(epoch FROM (COALESCE(a.finished_at, now()) - a.started_at)) * 1000)::bigint AS wall_ms, a.metrics
       FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE a.run_id = $1 ORDER BY a.id`,
    [runId],
  );
  const totals = { attempts: attempts.length, failed: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, turns: 0, wall_ms: 0, tool_calls: 0, integration_calls: 0, skills_loaded: 0, subagents: 0, denied: 0 };
  for (const a of attempts) {
    const m = a.metrics ?? {};
    if (a.status === "FAILED") totals.failed++;
    totals.wall_ms += Number(a.wall_ms ?? 0);
    totals.cost_usd += m.cost_usd ?? 0;
    totals.input_tokens += m.tokens?.input ?? 0;
    totals.output_tokens += m.tokens?.output ?? 0;
    totals.cache_read_tokens += m.tokens?.cache_read ?? 0;
    totals.turns += m.turns ?? 0;
    totals.tool_calls += Object.values<number>(m.tool_calls ?? {}).reduce((x, y) => x + y, 0);
    totals.integration_calls += (m.integration_calls ?? []).length;
    totals.skills_loaded += (m.skills_loaded ?? []).length;
    totals.subagents += (m.subagents ?? []).length;
    totals.denied += (m.denied ?? []).length;
  }
  totals.cost_usd = Math.round(totals.cost_usd * 1e4) / 1e4;
  return { run_id: runId, totals, attempts };
}

export async function metricsSummary(days = 30) {
  const since = `now() - make_interval(days => ${Number(days) || 30})`;
  const [byWorkflow, byStepType, tools, integrations, skills, failures, denied] = await Promise.all([
    q(pool, `SELECT r.definition_key, count(DISTINCT r.id)::int AS runs,
                    count(DISTINCT r.id) FILTER (WHERE r.status = 'COMPLETED')::int AS completed,
                    count(DISTINCT r.id) FILTER (WHERE r.status = 'FAILED')::int AS failed,
                    round(COALESCE(sum((a.metrics->>'cost_usd')::numeric), 0), 4) AS cost_usd,
                    COALESCE(sum((a.metrics->'tokens'->>'input')::bigint + (a.metrics->'tokens'->>'output')::bigint), 0)::bigint AS tokens
               FROM workflow_runs r LEFT JOIN workflow_step_attempts a ON a.run_id = r.id
              WHERE r.created_at > ${since} GROUP BY 1 ORDER BY runs DESC`),
    q(pool, `SELECT s.type, count(*)::int AS attempts, count(*) FILTER (WHERE a.status = 'FAILED')::int AS failed,
                    round(avg(extract(epoch FROM (a.finished_at - a.started_at)))::numeric, 1) AS avg_seconds,
                    round(COALESCE(sum((a.metrics->>'cost_usd')::numeric), 0), 4) AS cost_usd
               FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id
              WHERE a.started_at > ${since} GROUP BY 1 ORDER BY attempts DESC`),
    q(pool, `SELECT t.key AS tool, sum(t.value::int)::int AS calls, count(DISTINCT a.id)::int AS attempts
               FROM workflow_step_attempts a, jsonb_each_text(COALESCE(a.metrics->'tool_calls', '{}'::jsonb)) t
              WHERE a.started_at > ${since} GROUP BY 1 ORDER BY calls DESC`),
    q(pool, `SELECT c->>'name' AS name, count(*)::int AS calls, count(*) FILTER (WHERE (c->>'ok')::boolean IS NOT TRUE)::int AS failed,
                    round(avg((c->>'ms')::numeric))::int AS avg_ms
               FROM workflow_step_attempts a, jsonb_array_elements(COALESCE(a.metrics->'integration_calls', '[]'::jsonb)) c
              WHERE a.started_at > ${since} GROUP BY 1 ORDER BY calls DESC`),
    q(pool, `SELECT k AS key, count(*)::int AS loads
               FROM workflow_step_attempts a, jsonb_array_elements_text(COALESCE(a.metrics->'skills_loaded', '[]'::jsonb)) k
              WHERE a.started_at > ${since} GROUP BY 1 ORDER BY loads DESC LIMIT 50`),
    q(pool, `SELECT a.run_id, s.key AS step_key, s.type, a.number, a.finished_at, left(COALESCE(a.error->>'message', ''), 300) AS error
               FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id
              WHERE a.status = 'FAILED' AND a.started_at > ${since} ORDER BY a.id DESC LIMIT 25`),
    q(pool, `SELECT d->>'tool' AS tool, left(d->>'reason', 160) AS reason, count(*)::int AS times
               FROM workflow_step_attempts a, jsonb_array_elements(COALESCE(a.metrics->'denied', '[]'::jsonb)) d
              WHERE a.started_at > ${since} GROUP BY 1, 2 ORDER BY times DESC LIMIT 25`),
  ]);
  return { days, by_workflow: byWorkflow, by_step_type: byStepType, tools, integrations, skills, failures, denied };
}
