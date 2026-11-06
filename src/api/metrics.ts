import { pool, q, one } from "../db/pool.ts";

/** Observability queries over workflow_step_attempts.metrics (+ timestamps for every step type). */

/**
 * Per-run latency breakdown. Everything is measured from PostgreSQL timestamps unless stated:
 *   queue_ms  job available → attempt started (worker contention, retry backoff excluded)
 *   exec_ms   attempt started → attempt finished or started waiting (machine time)
 *   human_ms  waiting for an answer/approval (finished → resolved)
 *   claude_ms SDK-reported session duration; tool_ms paired tool_use → tool_result event timestamps
 *   cost_usd  SDK estimate (not a bill)
 */
export async function runMetrics(runId: number) {
  const attempts = await q(
    pool,
    `SELECT a.id, s.key AS step_key, s.type AS step_type, a.number, a.status, a.started_at, a.finished_at, a.resolved_at, a.metrics,
            (extract(epoch FROM (COALESCE(a.finished_at, now()) - a.started_at)) * 1000)::bigint AS exec_ms,
            GREATEST(0, (extract(epoch FROM (a.started_at - GREATEST(j.available_at, j.created_at))) * 1000))::bigint AS queue_ms,
            CASE WHEN a.status IN ('WAITING_INPUT', 'WAITING_APPROVAL') OR a.resolved_at IS NOT NULL
                 THEN (extract(epoch FROM (COALESCE(a.resolved_at, now()) - a.finished_at)) * 1000)::bigint ELSE 0 END AS human_ms
       FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id LEFT JOIN workflow_jobs j ON j.id = a.job_id
      WHERE a.run_id = $1 ORDER BY a.id`,
    [runId],
  );
  // Tool execution time from paired events (measured at event-write granularity).
  const toolRows = await q(
    pool,
    `SELECT t.attempt_id, t.data->>'name' AS name, (extract(epoch FROM (r.created_at - t.created_at)) * 1000)::bigint AS ms
       FROM workflow_events t JOIN workflow_events r ON r.attempt_id = t.attempt_id AND r.kind = 'tool_result' AND r.data->>'tool_use_id' = t.data->>'id'
      WHERE t.run_id = $1 AND t.kind = 'tool'`,
    [runId],
  );
  const toolMs = new Map<number, number>();
  const byTool: Record<string, { calls: number; ms: number }> = {};
  for (const t of toolRows) {
    toolMs.set(t.attempt_id, (toolMs.get(t.attempt_id) ?? 0) + Number(t.ms));
    (byTool[t.name] ??= { calls: 0, ms: 0 }).calls++;
    byTool[t.name].ms += Number(t.ms);
  }
  const run = (await q(pool, "SELECT created_at, started_at, finished_at, status, profile, profile_decision, agent_provider FROM workflow_runs WHERE id = $1", [runId]))[0];
  const totals = { attempts: attempts.length, retries: 0, failed: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, turns: 0, exec_ms: 0, queue_ms: 0, human_ms: 0, claude_ms: 0, tool_ms: 0, command_ms: 0, tool_calls: 0, integration_calls: 0, skills_loaded: 0, subagents: 0, denied: 0, claude_sessions: 0, cost_unknown: 0 };
  const perStep: Record<string, { type: string; attempts: number; exec_ms: number; queue_ms: number; human_ms: number; claude_ms: number; turns: number }> = {};
  for (const a of attempts) {
    const m = a.metrics ?? {};
    a.tool_ms = toolMs.get(a.id) ?? 0;
    if (a.status === "FAILED") totals.failed++;
    totals.exec_ms += Number(a.exec_ms);
    totals.queue_ms += Number(a.queue_ms ?? 0);
    totals.human_ms += Number(a.human_ms ?? 0);
    totals.claude_ms += m.duration_ms ?? 0;
    totals.tool_ms += a.tool_ms;
    if (a.step_type === "command") totals.command_ms += Number(a.exec_ms);
    totals.cost_usd += m.cost_usd ?? 0;
    // Codex (ChatGPT plan) and Cursor report no price: count those attempts instead of pretending they cost $0.
    if (m.sessions && m.cost_usd == null) totals.cost_unknown++;
    totals.input_tokens += m.tokens?.input ?? 0;
    totals.output_tokens += m.tokens?.output ?? 0;
    totals.cache_read_tokens += m.tokens?.cache_read ?? 0;
    totals.turns += m.turns ?? 0;
    totals.claude_sessions += m.sessions ?? 0;
    totals.tool_calls += Object.values<number>(m.tool_calls ?? {}).reduce((x, y) => x + y, 0);
    totals.integration_calls += (m.integration_calls ?? []).length;
    totals.skills_loaded += (m.skills_loaded ?? []).length;
    totals.subagents += (m.subagents ?? []).length;
    totals.denied += (m.denied ?? []).length;
    const ps = (perStep[a.step_key] ??= { type: a.step_type, attempts: 0, exec_ms: 0, queue_ms: 0, human_ms: 0, claude_ms: 0, turns: 0 });
    ps.attempts++;
    ps.exec_ms += Number(a.exec_ms);
    ps.queue_ms += Number(a.queue_ms ?? 0);
    ps.human_ms += Number(a.human_ms ?? 0);
    ps.claude_ms += m.duration_ms ?? 0;
    ps.turns += m.turns ?? 0;
  }
  totals.retries = Object.values(perStep).reduce((n, s) => n + Math.max(0, s.attempts - 1), 0);
  totals.cost_usd = Math.round(totals.cost_usd * 1e4) / 1e4;
  const wall_ms = run?.started_at ? new Date(run.finished_at ?? Date.now()).getTime() - new Date(run.started_at).getTime() : 0;
  const bottleneck = Object.entries(perStep).sort((a, b) => b[1].exec_ms + b[1].queue_ms - (a[1].exec_ms + a[1].queue_ms))[0]?.[0] ?? null;
  return {
    run_id: runId,
    profile: run?.profile,
    agent_provider: run?.agent_provider ?? "claude",
    wall_ms,
    totals,
    per_step: perStep,
    by_tool: byTool,
    bottleneck,
    measured: ["wall_ms", "exec_ms", "queue_ms", "human_ms", "tool_ms (event granularity)", "claude_ms (SDK)", "turns", "tokens", "tool_calls"],
    estimated: ["cost_usd (SDK estimate)"],
    attempts,
  };
}

export async function metricsSummary(days = 30, scope?: { ownerId?: number; all?: boolean }) {
  const since = `now() - make_interval(days => ${Number(days) || 30})`;
  const own = !scope ? "" : scope.all ? "AND r.owner_id IS NOT NULL" : `AND r.owner_id = ${Number(scope.ownerId)}`;
  const attemptOwn = !scope ? "" : scope.all ? "AND a.run_id IN (SELECT id FROM workflow_runs WHERE owner_id IS NOT NULL)" : `AND a.run_id IN (SELECT id FROM workflow_runs WHERE owner_id = ${Number(scope.ownerId)})`;
  const byProfile = await q(
    pool,
    `SELECT r.profile, count(DISTINCT r.id)::int AS runs, count(DISTINCT r.id) FILTER (WHERE r.status = 'COMPLETED')::int AS completed,
            round(avg(extract(epoch FROM (r.finished_at - r.started_at))) FILTER (WHERE r.finished_at IS NOT NULL)::numeric / 60, 1) AS avg_wall_min,
            round(COALESCE(sum((a.metrics->>'turns')::numeric), 0) / NULLIF(count(DISTINCT r.id), 0), 1) AS turns_per_run,
            round(COALESCE(sum((a.metrics->>'cost_usd')::numeric), 0) / NULLIF(count(DISTINCT r.id), 0), 3) AS cost_per_run,
            round(count(a.id) FILTER (WHERE a.metrics ? 'turns')::numeric / NULLIF(count(DISTINCT r.id), 0), 1) AS claude_attempts_per_run
       FROM workflow_runs r LEFT JOIN workflow_step_attempts a ON a.run_id = r.id
      WHERE r.created_at > ${since} ${own} GROUP BY 1 ORDER BY 1`,
  );
  const [byWorkflow, byStepType, tools, integrations, skills, failures, denied] = await Promise.all([
    q(pool, `SELECT r.definition_key, count(DISTINCT r.id)::int AS runs,
                    count(DISTINCT r.id) FILTER (WHERE r.status = 'COMPLETED')::int AS completed,
                    count(DISTINCT r.id) FILTER (WHERE r.status = 'FAILED')::int AS failed,
                    round(COALESCE(sum((a.metrics->>'cost_usd')::numeric), 0), 4) AS cost_usd,
                    COALESCE(sum((a.metrics->'tokens'->>'input')::bigint + (a.metrics->'tokens'->>'output')::bigint), 0)::bigint AS tokens
               FROM workflow_runs r LEFT JOIN workflow_step_attempts a ON a.run_id = r.id
              WHERE r.created_at > ${since} ${own} GROUP BY 1 ORDER BY runs DESC`),
    q(pool, `SELECT s.type, count(*)::int AS attempts, count(*) FILTER (WHERE a.status = 'FAILED')::int AS failed,
                    round(avg(extract(epoch FROM (a.finished_at - a.started_at)))::numeric, 1) AS avg_seconds,
                    round(COALESCE(sum((a.metrics->>'cost_usd')::numeric), 0), 4) AS cost_usd
               FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id
              WHERE a.started_at > ${since} ${attemptOwn} GROUP BY 1 ORDER BY attempts DESC`),
    q(pool, `SELECT t.key AS tool, sum(t.value::int)::int AS calls, count(DISTINCT a.id)::int AS attempts
               FROM workflow_step_attempts a, jsonb_each_text(COALESCE(a.metrics->'tool_calls', '{}'::jsonb)) t
              WHERE a.started_at > ${since} ${attemptOwn} GROUP BY 1 ORDER BY calls DESC`),
    q(pool, `SELECT c->>'name' AS name, count(*)::int AS calls, count(*) FILTER (WHERE (c->>'ok')::boolean IS NOT TRUE)::int AS failed,
                    round(avg((c->>'ms')::numeric))::int AS avg_ms
               FROM workflow_step_attempts a, jsonb_array_elements(COALESCE(a.metrics->'integration_calls', '[]'::jsonb)) c
              WHERE a.started_at > ${since} ${attemptOwn} GROUP BY 1 ORDER BY calls DESC`),
    q(pool, `SELECT k AS key, count(*)::int AS loads
               FROM workflow_step_attempts a, jsonb_array_elements_text(COALESCE(a.metrics->'skills_loaded', '[]'::jsonb)) k
              WHERE a.started_at > ${since} ${attemptOwn} GROUP BY 1 ORDER BY loads DESC LIMIT 50`),
    q(pool, `SELECT a.run_id, s.key AS step_key, s.type, a.number, a.finished_at, left(COALESCE(a.error->>'message', ''), 300) AS error
               FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id
              WHERE a.status = 'FAILED' AND a.started_at > ${since} ${attemptOwn} ORDER BY a.id DESC LIMIT 25`),
    q(pool, `SELECT d->>'tool' AS tool, left(d->>'reason', 160) AS reason, count(*)::int AS times
               FROM workflow_step_attempts a, jsonb_array_elements(COALESCE(a.metrics->'denied', '[]'::jsonb)) d
              WHERE a.started_at > ${since} ${attemptOwn} GROUP BY 1, 2 ORDER BY times DESC LIMIT 25`),
  ]);
  return { days, by_profile: byProfile, by_workflow: byWorkflow, by_step_type: byStepType, tools, integrations, skills, failures, denied, evaluation: await harnessEvaluation(since, attemptOwn, own) };
}

/**
 * Harness evaluation (kept apart from execution status): did coding steps pass the platform's own verification, how
 * many repairs it took, which failures keep recurring, and how often a human had to step in.
 */
export async function harnessEvaluation(since: string, attemptOwn = "", own = "") {
  const [verification, patterns, human] = await Promise.all([
    one<any>(
      pool,
      `SELECT count(*)::int AS coding_attempts,
              count(*) FILTER (WHERE a.metrics ? 'verification' AND a.metrics->'verification'->>'outcome' NOT IN ('skipped', 'disabled'))::int AS verified,
              count(*) FILTER (WHERE (a.metrics->'verification'->>'passed')::boolean)::int AS passed,
              count(*) FILTER (WHERE (a.metrics->'verification'->>'passed')::boolean AND (a.metrics->'verification'->>'repairs')::int = 0)::int AS passed_first_try,
              round(avg((a.metrics->'verification'->>'repairs')::numeric) FILTER (WHERE a.metrics ? 'verification'), 2) AS avg_repairs,
              count(*) FILTER (WHERE a.metrics->'verification'->>'outcome' = 'no_progress')::int AS stopped_no_progress,
              count(*) FILTER (WHERE a.metrics->'verification'->>'outcome' = 'failed')::int AS repair_budget_exhausted,
              round(avg((a.metrics->'verification'->>'duration_ms')::numeric) FILTER (WHERE a.metrics ? 'verification') / 1000, 1) AS avg_verify_s,
              count(*) FILTER (WHERE a.metrics->'verification'->>'status' = 'accepted_with_preexisting')::int AS accepted_preexisting,
              count(*) FILTER (WHERE a.metrics->'verification'->>'outcome' = 'error')::int AS errors,
              count(*) FILTER (WHERE (a.metrics->'verification'->>'needs_review')::boolean)::int AS needs_review,
              count(*) FILTER (WHERE a.metrics->'verification'->>'outcome' = 'disabled')::int AS disabled
         FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id
        WHERE s.type = 'coding_agent' AND a.started_at > ${since} ${attemptOwn}`,
    ),
    q(
      pool,
      `SELECT left(sig, 300) AS signature, count(*)::int AS times, count(DISTINCT a.run_id)::int AS runs
         FROM workflow_step_attempts a, jsonb_array_elements_text(COALESCE(a.metrics->'verification'->'failure_signatures', '[]'::jsonb)) sig
        WHERE a.started_at > ${since} ${attemptOwn} GROUP BY sig HAVING count(*) > 1 ORDER BY times DESC LIMIT 15`,
    ),
    one<any>(
      pool,
      `SELECT count(*)::int AS runs,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM workflow_questions qq WHERE qq.run_id = r.id AND qq.status = 'answered')
                                  OR EXISTS (SELECT 1 FROM workflow_steps hs WHERE hs.run_id = r.id AND hs.type = 'human_approval' AND hs.status = 'COMPLETED' AND COALESCE(hs.output->>'auto', 'false') <> 'true')
                                  OR EXISTS (SELECT 1 FROM workflow_step_attempts ra WHERE ra.run_id = r.id AND ra.input->'pending' ? 'reexecute'))::int AS with_human,
              (SELECT count(*)::int FROM workflow_questions qq JOIN workflow_runs r2 ON r2.id = qq.run_id WHERE r2.created_at > ${since} AND qq.status = 'answered' ${own.replaceAll("r.owner_id", "r2.owner_id")}) AS answers,
              (SELECT count(*)::int FROM workflow_step_attempts ra JOIN workflow_runs r2 ON r2.id = ra.run_id WHERE r2.created_at > ${since} AND ra.input->'pending' ? 'reexecute' ${own.replaceAll("r.owner_id", "r2.owner_id")}) AS reexecutions
         FROM workflow_runs r WHERE r.created_at > ${since} ${own}`,
    ),
  ]);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    verification: { ...verification, pass_rate_pct: pct(verification.passed, verification.verified), first_try_pass_rate_pct: pct(verification.passed_first_try, verification.verified) },
    repeated_failures: patterns,
    human_intervention: { ...human, rate_pct: pct(human.with_human, human.runs) },
  };
}
