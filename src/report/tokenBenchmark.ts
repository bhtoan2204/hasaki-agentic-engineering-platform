/**
 * Token efficiency from recorded telemetry (`execution_attempt_telemetry`), grouped by provider, model and execution
 * profile, at three levels:
 *   - attempts: usage availability, retry overhead and tokens spent by failed attempts;
 *   - runs: success, first-pass success and tokens per successful run;
 *   - work items: the same across every run of a work item.
 * Only terminal outcomes count toward success and failure. A run (or work item) is attributed to the slice of its final
 * attempt, so a run that switched provider or model is counted once, for the one that finished it, with the tokens of
 * every attempt it took. A token figure is null when any of its parts was not reported; it is never filled with 0.
 */
import { pool, q, type Db } from "../db/pool.ts";

export type UsageAvailability = "complete" | "partial" | "unavailable" | "none";

export interface AttemptTelemetryRow {
  run_id: number;
  run_status: string;
  work_item_id: number | null;
  attempt_id: number;
  number: number;
  provider: string;
  model: string;
  execution_profile: string;
  status: string;
  terminal_status: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
}

export interface TelemetryAttempt extends AttemptTelemetryRow {
  retries: number;
  wall_duration_ms: number | null;
  delta: boolean;
  peak_occupancy: number | null;
  compactions: number;
  tool_calls: number | null;
}

export interface TokenTotals {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_creation: number | null;
  total: number | null;
}

export interface AttemptShare {
  count: number;
  tokens: TokenTotals;
  /** Share of all attempt tokens in the slice. */
  ratio: number | null;
}

export interface OutcomeMetrics {
  successful: number;
  failed: number;
  canceled: number;
  first_pass_successes: number;
  /** Over completed + failed; canceled outcomes are reported apart. */
  success_rate: number | null;
  first_pass_success_rate: number | null;
  successes_with_usage: number;
  mean_tokens_per_success: TokenTotals;
  median_tokens_per_success: TokenTotals;
}

export interface TokenEfficiencySlice {
  provider: string;
  model: string;
  execution_profile: string;
  attempts: {
    count: number;
    with_usage: number;
    zero_usage: number;
    usage_availability: UsageAvailability;
    tokens: TokenTotals;
    retries: AttemptShare;
    failed: AttemptShare;
  };
  runs: OutcomeMetrics;
  work_items: OutcomeMetrics;
}

export const median = (xs: number[]): number | null => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};

export const round = (n: number, d = 4): number => {
  const factor = 10 ** d;
  return Math.round(n * factor) / factor;
};

const mean = (xs: number[]) =>
  xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 2) : null;
const ratio = (part: number | null, whole: number | null) =>
  part == null || !whole ? null : round(part / whole);
const add = (a: number | null, b: number | null) => (a == null || b == null ? null : a + b);

const PARTS = ["input", "output", "cache_read", "cache_creation"] as const;
const KEYS = [...PARTS, "total"] as const;
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELED"]);

export function attemptTokens(a: AttemptTelemetryRow): TokenTotals {
  const t = {
    input: a.input_tokens,
    output: a.output_tokens,
    cache_read: a.cache_read_tokens,
    cache_creation: a.cache_creation_tokens,
  };
  return { ...t, total: PARTS.reduce<number | null>((s, k) => add(s, t[k]), 0) };
}

export function sumTokens(list: TokenTotals[]): TokenTotals {
  const sum: TokenTotals = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };
  for (const t of list) for (const k of KEYS) sum[k] = add(sum[k], t[k]);
  return sum;
}

function tokenStat(list: TokenTotals[], stat: (xs: number[]) => number | null): TokenTotals {
  const out = {} as TokenTotals;
  for (const k of KEYS) out[k] = stat(list.map((t) => t[k]).filter((x): x is number => x != null));
  return out;
}

interface Outcome {
  status: string;
  firstPass: boolean;
  tokens: TokenTotals;
}

function outcomeMetrics(list: Outcome[]): OutcomeMetrics {
  const successes = list.filter((o) => o.status === "COMPLETED");
  const failed = list.filter((o) => o.status === "FAILED").length;
  const firstPass = successes.filter((o) => o.firstPass).length;
  const tokens = successes.map((o) => o.tokens);
  return {
    successful: successes.length,
    failed,
    canceled: list.filter((o) => o.status === "CANCELED").length,
    first_pass_successes: firstPass,
    success_rate: ratio(successes.length, successes.length + failed),
    first_pass_success_rate: ratio(firstPass, successes.length + failed),
    successes_with_usage: tokens.filter((t) => t.total != null).length,
    mean_tokens_per_success: tokenStat(tokens, mean),
    median_tokens_per_success: tokenStat(tokens, median),
  };
}

function availability(tokens: TokenTotals[]): UsageAvailability {
  if (!tokens.length) return "none";
  if (tokens.every((t) => t.total != null)) return "complete";
  return tokens.some((t) => PARTS.some((k) => t[k] != null)) ? "partial" : "unavailable";
}

/** Pure aggregation of attempt telemetry; see the module comment for the attribution rules. */
export function aggregateTokenEfficiency(rows: AttemptTelemetryRow[]): TokenEfficiencySlice[] {
  type Slice = Pick<TokenEfficiencySlice, "provider" | "model" | "execution_profile"> & {
    attempts: AttemptTelemetryRow[];
    runs: Outcome[];
    workItems: Outcome[];
  };
  const slices = new Map<string, Slice>();
  const sliceOf = (a: AttemptTelemetryRow) => {
    const key = JSON.stringify([a.provider, a.model, a.execution_profile]);
    let s = slices.get(key);
    if (!s) {
      s = {
        provider: a.provider,
        model: a.model,
        execution_profile: a.execution_profile,
        attempts: [],
        runs: [],
        workItems: [],
      };
      slices.set(key, s);
    }
    return s;
  };

  const runs = new Map<number, AttemptTelemetryRow[]>();
  for (const a of rows) {
    sliceOf(a).attempts.push(a);
    const list = runs.get(a.run_id);
    if (list) list.push(a);
    else runs.set(a.run_id, [a]);
  }

  const workItems = new Map<
    number,
    Array<Outcome & { runId: number; final: AttemptTelemetryRow }>
  >();
  for (const [runId, attempts] of runs) {
    const final = attempts.reduce((x, y) => (y.attempt_id > x.attempt_id ? y : x));
    const run = {
      runId,
      final,
      status: final.run_status,
      firstPass: attempts.every((a) => a.number === 1 && a.terminal_status !== "FAILED"),
      tokens: sumTokens(attempts.map(attemptTokens)),
    };
    if (TERMINAL.has(run.status)) sliceOf(final).runs.push(run);
    if (final.work_item_id == null) continue;
    const list = workItems.get(final.work_item_id);
    if (list) list.push(run);
    else workItems.set(final.work_item_id, [run]);
  }
  for (const list of workItems.values()) {
    const latest = list.reduce((x, y) => (y.runId > x.runId ? y : x));
    if (!TERMINAL.has(latest.status)) continue;
    sliceOf(latest.final).workItems.push({
      status: latest.status,
      firstPass: list.length === 1 && latest.firstPass,
      tokens: sumTokens(list.map((r) => r.tokens)),
    });
  }

  return [...slices.values()]
    .map((s) => {
      const tokens = s.attempts.map(attemptTokens);
      const all = sumTokens(tokens);
      const share = (list: AttemptTelemetryRow[]): AttemptShare => {
        const t = sumTokens(list.map(attemptTokens));
        return { count: list.length, tokens: t, ratio: ratio(t.total, all.total) };
      };
      return {
        provider: s.provider,
        model: s.model,
        execution_profile: s.execution_profile,
        attempts: {
          count: s.attempts.length,
          with_usage: tokens.filter((t) => PARTS.some((k) => t[k] != null)).length,
          zero_usage: tokens.filter((t) => t.total === 0).length,
          usage_availability: availability(tokens),
          tokens: all,
          retries: share(s.attempts.filter((a) => a.number > 1)),
          failed: share(s.attempts.filter((a) => a.terminal_status === "FAILED")),
        },
        runs: outcomeMetrics(s.runs),
        work_items: outcomeMetrics(s.workItems),
      };
    })
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model) ||
        a.execution_profile.localeCompare(b.execution_profile),
    );
}

/** Measured workflow attempts of the last `days` days, evaluation runs excluded, in execution order. */
export function loadAttemptTelemetry(days = 14, db: Db = pool) {
  return q<TelemetryAttempt>(
    db,
    `SELECT t.run_id,
            r.status AS run_status,
            r.work_item_id,
            t.attempt_id,
            t.number,
            COALESCE(t.provider, 'unknown') AS provider,
            COALESCE(t.model, 'unknown') AS model,
            COALESCE(t.execution_profile, 'unknown') AS execution_profile,
            t.status,
            t.terminal_status,
            t.input_tokens,
            t.output_tokens,
            t.cache_read_tokens,
            t.cache_creation_tokens,
            t.retries,
            t.wall_duration_ms,
            (a.metrics ? 'context_delivery') AS delta,
            (a.metrics->'context_window'->>'peak_tokens')::bigint AS peak_occupancy,
            COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(a.metrics->'compactions') = 'array' THEN a.metrics->'compactions' END), 0) AS compactions,
            (SELECT sum(v::numeric) FROM jsonb_each_text(CASE WHEN jsonb_typeof(t.tool_calls) = 'object' THEN t.tool_calls ELSE '{}'::jsonb END) x(k, v))::int AS tool_calls
       FROM execution_attempt_telemetry t
       JOIN workflow_step_attempts a ON a.id = t.attempt_id
       JOIN workflow_runs r ON r.id = t.run_id
      WHERE t.start_time > now() - make_interval(days => $1)
        AND NOT EXISTS (SELECT 1 FROM evaluation_runs e WHERE e.workflow_run_id = r.id)
      ORDER BY t.start_time ASC, t.attempt_id ASC`,
    [days],
  );
}
