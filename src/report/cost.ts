/**
 * Cost read model for runs and work items: totals, token usage, breakdown by step and by model, cost that produced no
 * result ("wasted"), and budget status. Everything is derived from `execution_attempt_telemetry` (provider-reported
 * cost; nothing is priced or backfilled here). A cost that no provider reported stays null — never an invented 0.
 *
 * Wasted cost, per attempt:
 *   failed / canceled / stale  — the attempt itself ended without a usable result
 *   superseded                 — it completed, but the step was re-executed / retried and a later attempt replaced it
 * At work-item level a run that ended FAILED or CANCELED counts entirely as wasted ("failed_run").
 *
 * Budget: a run's own `budget_usd`, else the global default (config.costBudget.runUsd); a work item's own
 * `budget_usd`, else config.costBudget.workItemUsd. Checked by the engine after every attempt (enforceBudget).
 */
import { config } from "../config.ts";
import { pool, q, one, type Db } from "../db/pool.ts";

export interface TokenTotals { input: number; output: number; cache_read: number; cache_creation: number; reasoning: number }
export interface CostBucket {
  /** Sum of reported cost; null when no attempt in the bucket reported one. */
  cost_usd: number | null;
  attempts: number;
  /** Attempts that ran an agent but reported no cost (cost is then a lower bound). */
  attempts_without_cost: number;
  tokens: TokenTotals;
}
export type Availability = "complete" | "partial" | "unavailable" | "none";
export interface CostSummary {
  total: CostBucket;
  availability: Availability;
  wasted: { cost_usd: number; pct: number | null; by_reason: Record<string, number> };
  by_step: Array<CostBucket & { step_key: string; step_name: string; wasted_usd: number }>;
  by_model: Array<CostBucket & { provider: string; model: string }>;
}
export type BudgetStatus = "none" | "ok" | "warning" | "exceeded";
export interface BudgetLine { limit_usd: number | null; source: "own" | "default" | null; used_usd: number; pct: number | null; status: BudgetStatus }

export interface AttemptCostRow {
  attempt_id: number;
  run_id: number;
  step_key: string;
  step_name: string;
  status: string;
  run_status: string;
  current_attempt_id: number | null;
  provider: string | null;
  model: string | null;
  cost: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  reasoning_tokens: number | null;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const emptyBucket = (): CostBucket => ({ cost_usd: null, attempts: 0, attempts_without_cost: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, reasoning: 0 } });
const usedAgent = (r: AttemptCostRow) => r.cost != null || r.provider != null || (r.input_tokens ?? 0) + (r.output_tokens ?? 0) > 0;

function add(b: CostBucket, r: AttemptCostRow) {
  b.attempts++;
  if (r.cost != null) b.cost_usd = round((b.cost_usd ?? 0) + Number(r.cost));
  else if (usedAgent(r)) b.attempts_without_cost++;
  b.tokens.input += Number(r.input_tokens ?? 0);
  b.tokens.output += Number(r.output_tokens ?? 0);
  b.tokens.cache_read += Number(r.cache_read_tokens ?? 0);
  b.tokens.cache_creation += Number(r.cache_creation_tokens ?? 0);
  b.tokens.reasoning += Number(r.reasoning_tokens ?? 0);
}

/** Why an attempt's cost produced nothing, or null when it is the step's live result / still running. */
export function wasteReason(r: AttemptCostRow, wholeFailedRuns = false): string | null {
  if (r.status === "FAILED") return "failed";
  if (r.status === "CANCELED") return "canceled";
  if (r.status === "STALE") return "stale";
  if (r.status === "COMPLETED" && r.current_attempt_id != null && Number(r.current_attempt_id) !== Number(r.attempt_id)) return "superseded";
  if (wholeFailedRuns && (r.run_status === "FAILED" || r.run_status === "CANCELED")) return "failed_run";
  return null;
}

/** Pure aggregation (unit-tested). */
export function summarize(rows: AttemptCostRow[], opts: { wholeFailedRuns?: boolean } = {}): CostSummary {
  const total = emptyBucket();
  const steps = new Map<string, CostBucket & { step_key: string; step_name: string; wasted_usd: number }>();
  const models = new Map<string, CostBucket & { provider: string; model: string }>();
  const byReason: Record<string, number> = {};
  let wasted = 0;
  for (const r of rows) {
    add(total, r);
    const s = steps.get(r.step_key) ?? { ...emptyBucket(), step_key: r.step_key, step_name: r.step_name, wasted_usd: 0 };
    add(s, r);
    steps.set(r.step_key, s);
    if (usedAgent(r)) {
      const key = `${r.provider ?? "?"}|${r.model ?? "?"}`;
      const m = models.get(key) ?? { ...emptyBucket(), provider: r.provider ?? "unknown", model: r.model ?? "unknown" };
      add(m, r);
      models.set(key, m);
    }
    const why = wasteReason(r, opts.wholeFailedRuns);
    if (why && r.cost != null) {
      const c = Number(r.cost);
      wasted += c;
      s.wasted_usd = round(s.wasted_usd + c);
      byReason[why] = round((byReason[why] ?? 0) + c);
    }
  }
  const agentAttempts = rows.filter(usedAgent).length;
  const availability: Availability = !agentAttempts ? "none" : total.cost_usd == null ? "unavailable" : total.attempts_without_cost ? "partial" : "complete";
  const byCost = <T extends CostBucket>(a: T, b: T) => (b.cost_usd ?? -1) - (a.cost_usd ?? -1);
  return {
    total,
    availability,
    wasted: { cost_usd: round(wasted), pct: total.cost_usd ? Math.round((wasted / total.cost_usd) * 1000) / 10 : null, by_reason: byReason },
    by_step: [...steps.values()],
    by_model: [...models.values()].sort(byCost),
  };
}

export function budgetLine(limit: number | null, source: BudgetLine["source"], used: number, warnPct = config.costBudget.warnPct): BudgetLine {
  if (limit == null) return { limit_usd: null, source: null, used_usd: round(used), pct: null, status: "none" };
  const pct = Math.round((used / limit) * 1000) / 10;
  return { limit_usd: limit, source, used_usd: round(used), pct, status: used >= limit ? "exceeded" : used >= limit * warnPct ? "warning" : "ok" };
}

async function attemptRows(runIds: number[], db: Db = pool): Promise<AttemptCostRow[]> {
  if (!runIds.length) return [];
  return q<AttemptCostRow>(
    db,
    `SELECT t.attempt_id, t.run_id, s.key AS step_key, s.name AS step_name, t.status, r.status AS run_status, s.current_attempt_id,
            t.provider, t.model, t.reported_cost_usd AS cost, t.input_tokens, t.output_tokens, t.cache_read_tokens,
            t.cache_creation_tokens, t.reasoning_tokens
       FROM execution_attempt_telemetry t
       JOIN workflow_steps s ON s.id = t.step_id
       JOIN workflow_runs r ON r.id = t.run_id
      WHERE t.run_id = ANY($1::bigint[])
      ORDER BY t.run_id, t.attempt_id`,
    [runIds],
  );
}

const sumCost = (rows: AttemptCostRow[]) => rows.reduce((n, r) => n + Number(r.cost ?? 0), 0);
const num = (v: unknown) => (v == null ? null : Number(v));

/** Budget lines of one run and its work item, from the costs already spent. */
export async function budgetsForRun(runId: number, db: Db = pool, rows?: AttemptCostRow[]) {
  const run = await one<{ budget_usd: string | null; work_item_id: number | null; wi_budget: string | null }>(
    db,
    "SELECT r.budget_usd, r.work_item_id, w.budget_usd AS wi_budget FROM workflow_runs r LEFT JOIN work_items w ON w.id = r.work_item_id WHERE r.id = $1",
    [runId],
  );
  if (!run) return null;
  const own = num(run.budget_usd);
  const runLine = budgetLine(own ?? config.costBudget.runUsd, own != null ? "own" : config.costBudget.runUsd != null ? "default" : null, sumCost(rows ?? (await attemptRows([runId], db))));
  let wiLine: BudgetLine | null = null;
  if (run.work_item_id) {
    const wiOwn = num(run.wi_budget);
    const limit = wiOwn ?? config.costBudget.workItemUsd;
    // Spend across every run of the work item (one extra query only when a limit applies).
    const spent = limit == null ? 0 : Number((await one<{ c: string | null }>(db, "SELECT sum(t.reported_cost_usd) AS c FROM execution_attempt_telemetry t JOIN workflow_runs r ON r.id = t.run_id WHERE r.work_item_id = $1", [run.work_item_id]))?.c ?? 0);
    wiLine = budgetLine(limit, wiOwn != null ? "own" : limit != null ? "default" : null, spent);
  }
  return { run: runLine, work_item: wiLine, work_item_id: run.work_item_id };
}

export async function runCost(runId: number) {
  const rows = await attemptRows([runId]);
  return { run_id: runId, ...summarize(rows), budget: await budgetsForRun(runId, pool, rows) };
}

export async function workItemCost(workItemId: number) {
  const wi = await one<{ budget_usd: string | null }>(pool, "SELECT budget_usd FROM work_items WHERE id = $1", [workItemId]);
  if (!wi) return null;
  const runs = await q<{ id: number; title: string; status: string; definition_key: string; created_at: string }>(
    pool,
    "SELECT id, title, status, definition_key, created_at FROM workflow_runs WHERE work_item_id = $1 ORDER BY id DESC",
    [workItemId],
  );
  const rows = await attemptRows(runs.map((r) => Number(r.id)));
  const summary = summarize(rows, { wholeFailedRuns: true });
  const perRun = runs.map((r) => {
    const s = summarize(rows.filter((x) => Number(x.run_id) === Number(r.id)));
    return { run_id: Number(r.id), title: r.title, status: r.status, workflow: r.definition_key, created_at: r.created_at, cost_usd: s.total.cost_usd, wasted_usd: s.wasted.cost_usd, availability: s.availability };
  });
  const withCost = perRun.filter((r) => r.cost_usd != null);
  const own = num(wi.budget_usd);
  const limit = own ?? config.costBudget.workItemUsd;
  return {
    work_item_id: workItemId,
    ...summary,
    run_count: runs.length,
    avg_per_run_usd: withCost.length ? round(withCost.reduce((n, r) => n + (r.cost_usd ?? 0), 0) / withCost.length) : null,
    runs: perRun,
    budget: budgetLine(limit, own != null ? "own" : limit != null ? "default" : null, sumCost(rows)),
  };
}

/** Compact totals for list pages: one query for all ids. */
export async function costTotalsForRuns(runIds: number[]) {
  const rows = await attemptRows(runIds);
  const out = new Map<number, { cost_usd: number | null; wasted_usd: number; tokens: number; availability: Availability }>();
  for (const id of runIds) {
    const s = summarize(rows.filter((r) => Number(r.run_id) === id));
    out.set(id, { cost_usd: s.total.cost_usd, wasted_usd: s.wasted.cost_usd, tokens: s.total.tokens.input + s.total.tokens.output + s.total.tokens.cache_read + s.total.tokens.cache_creation, availability: s.availability });
  }
  return out;
}

export async function costTotalsForWorkItems(workItemIds: number[]) {
  const out = new Map<number, { cost_usd: number | null; wasted_usd: number; run_count: number; availability: Availability }>();
  if (!workItemIds.length) return out;
  const runs = await q<{ id: number; work_item_id: number }>(pool, "SELECT id, work_item_id FROM workflow_runs WHERE work_item_id = ANY($1::bigint[])", [workItemIds]);
  const rows = await attemptRows(runs.map((r) => Number(r.id)));
  const runToWi = new Map(runs.map((r) => [Number(r.id), Number(r.work_item_id)]));
  for (const id of workItemIds) {
    const mine = rows.filter((r) => runToWi.get(Number(r.run_id)) === id);
    const s = summarize(mine, { wholeFailedRuns: true });
    out.set(id, { cost_usd: s.total.cost_usd, wasted_usd: s.wasted.cost_usd, run_count: runs.filter((r) => Number(r.work_item_id) === id).length, availability: s.availability });
  }
  return out;
}

/** Attach `cost` to each row of a list response (rows keep their shape; failures leave rows without cost). */
export async function withCosts<T extends { id: number }>(rows: T[], kind: "run" | "work_item"): Promise<Array<T & { cost?: unknown }>> {
  try {
    const ids = rows.map((r) => Number(r.id));
    const m = kind === "run" ? await costTotalsForRuns(ids) : await costTotalsForWorkItems(ids);
    return rows.map((r) => ({ ...r, cost: m.get(Number(r.id)) ?? null }));
  } catch {
    return rows;
  }
}

/** Validated budget input: null clears it, otherwise a positive number of USD. */
export function parseBudget(v: unknown): number | null {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error("budget_usd must be a positive number (USD) or null");
  return Math.round(n * 100) / 100;
}
