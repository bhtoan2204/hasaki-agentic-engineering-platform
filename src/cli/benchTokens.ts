/**
 * Token consumption benchmark (provider-reported usage, never prompt-length estimates for savings claims).
 *
 *   npm run bench:tokens -- telemetry [--days 14] [--out DIR]
 *     Read-only. Workflow attempts by profile (MICRO/FAST/STANDARD/DEEP) and chat turns from recorded telemetry:
 *     median uncached input, cache reads/writes, output, tool calls, latency, retries and success, split by whether
 *     delta context was applied (context_delivery / chat steps). Compare windows before and after enabling it.
 *
 *   npm run bench:tokens -- chat --live --owner USER --budget-usd 2 [--repeat 3] [--out DIR]
 *     Spends provider quota: runs the same multi-step chat workload with delta context off (baseline) and on
 *     (candidate) through the real chat runtime and providers, and reports provider-reported usage per turn.
 *     Refuses without --live and a positive --budget-usd; stops once the reported cost reaches the budget.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool, q, one } from "../db/pool.ts";
import { config } from "../config.ts";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const median = (xs: number[]) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};
const out = opt("out") ?? ".eval/tokens";

async function telemetry(days: number) {
  const attempts = await q<{
    profile: string | null;
    provider: string;
    delta: boolean;
    input_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    output_tokens: number | null;
    tool_calls: number | null;
    retries: number | null;
    wall_duration_ms: number | null;
    ok: boolean;
    peak_occupancy: number | null;
    compactions: number;
  }>(
    pool,
    `SELECT r.profile, t.provider, (a.metrics ? 'context_delivery') AS delta,
            (a.metrics->'context_window'->>'peak_tokens')::bigint AS peak_occupancy,
            COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(a.metrics->'compactions') = 'array' THEN a.metrics->'compactions' END), 0) AS compactions,
            t.input_tokens, t.cache_read_tokens,
            t.cache_creation_tokens, t.output_tokens,
            (SELECT sum(v::numeric) FROM jsonb_each_text(CASE WHEN jsonb_typeof(t.tool_calls) = 'object' THEN t.tool_calls ELSE '{}'::jsonb END) x(k, v))::int AS tool_calls,
            t.retries, t.wall_duration_ms,
            (t.status = 'COMPLETED') AS ok
       FROM execution_attempt_telemetry t
       JOIN workflow_step_attempts a ON a.id = t.attempt_id
       JOIN workflow_runs r ON r.id = a.run_id
      WHERE t.start_time > now() - make_interval(days => $1)
        AND NOT EXISTS (SELECT 1 FROM evaluation_runs e WHERE e.workflow_run_id = r.id)`,
    [days],
  );
  const groups = new Map<string, typeof attempts>();
  for (const a of attempts) {
    const k = `${a.profile ?? "?"}|${a.provider}|${a.delta ? "delta" : "full"}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const workflow = [...groups.entries()].map(([k, rows]) => {
    const [profile, provider, context] = k.split("|");
    const known = rows.filter((r) => r.input_tokens != null);
    return {
      workload: profile,
      provider,
      context,
      attempts: rows.length,
      usage_reported: known.length,
      // Everything the provider read for the prompt: uncached input + cache reads + cache writes.
      median_total_input: median(
        known.map(
          (r) =>
            Number(r.input_tokens) +
            Number(r.cache_read_tokens ?? 0) +
            Number(r.cache_creation_tokens ?? 0),
        ),
      ),
      median_input: median(known.map((r) => Number(r.input_tokens))),
      median_cache_read: median(known.map((r) => Number(r.cache_read_tokens ?? NaN))),
      median_cache_creation: median(known.map((r) => Number(r.cache_creation_tokens ?? NaN))),
      median_output: median(known.map((r) => Number(r.output_tokens ?? NaN))),
      median_tool_calls: median(rows.map((r) => Number(r.tool_calls ?? NaN))),
      median_wall_ms: median(rows.map((r) => Number(r.wall_duration_ms ?? NaN))),
      retries: rows.reduce((n, r) => n + Number(r.retries ?? 0), 0),
      // Context pressure and compaction outcome (retention/recovery: success with vs without a compaction).
      median_peak_occupancy: median(rows.map((r) => Number(r.peak_occupancy ?? NaN))),
      compacted_attempts: rows.filter((r) => r.compactions > 0).length,
      success_rate_compacted: (() => {
        const c = rows.filter((r) => r.compactions > 0);
        return c.length ? c.filter((r) => r.ok).length / c.length : null;
      })(),
      success_rate: rows.length ? rows.filter((r) => r.ok).length / rows.length : null,
    };
  });
  const turns = await q<{
    provider: string | null;
    status: string;
    metrics: Record<string, unknown>;
  }>(
    pool,
    "SELECT effective_provider AS provider, status, metrics FROM chat_turns WHERE created_at > now() - make_interval(days => $1) AND status IN ('completed', 'failed')",
    [days],
  );
  const chat = ["full", "delta"].map((context) => {
    const rows = turns.filter((t) => {
      const steps = (t.metrics.steps as Array<{ sent?: string }> | undefined) ?? [];
      return context === "delta"
        ? steps.some((s) => s.sent === "delta")
        : !steps.some((s) => s.sent === "delta");
    });
    const known = rows.filter((t) => t.metrics.input_tokens != null);
    return {
      workload: "chat",
      context,
      turns: rows.length,
      usage_reported: known.length,
      median_total_input: median(
        known.map(
          (t) =>
            Number(t.metrics.input_tokens) +
            Number(t.metrics.cache_read_tokens ?? 0) +
            Number(t.metrics.cache_creation_tokens ?? 0),
        ),
      ),
      median_input: median(known.map((t) => Number(t.metrics.input_tokens))),
      median_cache_read: median(known.map((t) => Number(t.metrics.cache_read_tokens ?? NaN))),
      median_output: median(known.map((t) => Number(t.metrics.output_tokens ?? NaN))),
      median_tool_calls: median(rows.map((t) => Number(t.metrics.tool_calls ?? NaN))),
      median_latency_ms: median(rows.map((t) => Number(t.metrics.latency_ms ?? NaN))),
      success_rate: rows.length
        ? rows.filter((t) => t.status === "completed").length / rows.length
        : null,
    };
  });
  return { kind: "telemetry", days, measurement: "provider_reported", workflow, chat };
}

const WORKLOAD = [
  "Tìm trong knowledge các quy tắc hoàn tiền, đọc đầy đủ từng tài liệu liên quan, rồi tóm tắt các quy tắc chính.",
  "Liệt kê các repository mình đọc được, tìm trong code nơi xử lý refund và đọc đoạn code chính, rồi giải thích luồng.",
  "Tìm các work item gần đây liên quan tới đơn hàng, xem run tương ứng và tóm tắt trạng thái.",
];

async function liveChat() {
  const budget = Number(opt("budget-usd"));
  if (!args.includes("--live") || !Number.isFinite(budget) || budget <= 0) {
    console.error("refused: this spends provider quota. Pass --live and a positive --budget-usd.");
    process.exit(2);
  }
  const username = opt("owner");
  const user = username
    ? await one<{ id: number; username: string; role: string; active: boolean }>(
        pool,
        "SELECT id, username, role, active FROM users WHERE username = $1 AND active",
        [username],
      )
    : null;
  if (!user) throw new Error("pass --owner <active username>");
  const { chat } = await import("../chat/service.ts");
  const { runTurn } = await import("../chat/runtime.ts");
  const actor = {
    id: user.id,
    username: user.username,
    role: user.role as "admin" | "member",
    active: true,
  };
  const repeat = Number(opt("repeat") ?? 1);
  let spent = 0;
  const rows: Array<Record<string, unknown>> = [];
  for (let r = 0; r < repeat; r++)
    for (const [i, message] of WORKLOAD.entries())
      for (const delta of [false, true]) {
        if (spent >= budget) break;
        config.agent.deltaContext = delta;
        const c = await chat.create(actor, {
          mode: "INVESTIGATE",
          provider: opt("provider") ?? "claude",
        });
        const m = await chat.postMessage(actor, c.id, {
          content: message,
          client_message_id: `bench-tokens-${Date.now()}-${r}-${i}-${delta}`,
        });
        await runTurn(m.turn.id);
        const t = await one<{ status: string; metrics: Record<string, unknown> }>(
          pool,
          "SELECT status, metrics FROM chat_turns WHERE id = $1",
          [m.turn.id],
        );
        const x = t!.metrics;
        spent += Number(x.cost_usd ?? 0);
        rows.push({
          workload: `chat#${i}`,
          repeat: r,
          context: delta ? "delta" : "full",
          status: t!.status,
          input_tokens: x.input_tokens ?? null,
          cache_read_tokens: x.cache_read_tokens ?? null,
          cache_creation_tokens: x.cache_creation_tokens ?? null,
          output_tokens: x.output_tokens ?? null,
          tool_calls: x.tool_calls ?? null,
          provider_calls: x.completions ?? null,
          latency_ms: x.latency_ms ?? null,
          cost_usd: x.cost_usd ?? null,
          estimated_sent_tokens: ((x.steps as Array<{ estimated_tokens?: number }>) ?? []).reduce(
            (n, s) => n + Number(s.estimated_tokens ?? 0),
            0,
          ),
        });
      }
  const summary = ["full", "delta"].map((context) => {
    const r = rows.filter((x) => x.context === context);
    return {
      context,
      turns: r.length,
      success_rate: r.length ? r.filter((x) => x.status === "completed").length / r.length : null,
      median_total_input_tokens: median(
        r.map(
          (x) =>
            Number(x.input_tokens ?? NaN) +
            Number(x.cache_read_tokens ?? 0) +
            Number(x.cache_creation_tokens ?? 0),
        ),
      ),
      median_input_tokens: median(r.map((x) => Number(x.input_tokens ?? NaN))),
      median_cache_read_tokens: median(r.map((x) => Number(x.cache_read_tokens ?? NaN))),
      median_output_tokens: median(r.map((x) => Number(x.output_tokens ?? NaN))),
      median_latency_ms: median(r.map((x) => Number(x.latency_ms ?? NaN))),
    };
  });
  const [full, delta] = summary;
  const reduction =
    full.median_total_input_tokens && delta.median_total_input_tokens != null
      ? 1 - delta.median_total_input_tokens / full.median_total_input_tokens
      : null;
  return {
    kind: "live-chat",
    measurement: "provider_reported",
    spent_usd: spent,
    budget_usd: budget,
    summary,
    median_input_reduction: reduction,
    rows,
  };
}

try {
  const mode = args[0];
  const report = mode === "chat" ? await liveChat() : await telemetry(Number(opt("days") ?? 14));
  mkdirSync(out, { recursive: true });
  const file = join(
    out,
    `tokens-${report.kind}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`,
  );
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`written: ${file}`);
} finally {
  await pool.end();
}
