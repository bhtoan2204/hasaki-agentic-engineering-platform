import { AsyncLocalStorage } from "node:async_hooks";

export interface LiveRuntime {
  cwd: string;
  root?: string;
  databaseUrl: string;
  observe: (tokens: number, cost: number | null, key?: object) => void;
}
export const liveRuntime = new AsyncLocalStorage<LiveRuntime>();

export class LiveBudget {
  tokens = 0;
  costUsd = 0;
  reason: string | null = null;
  private samples = new Map<object, { tokens: number; cost: number }>();
  readonly maxTokens: number;
  readonly maxCostUsd: number;
  readonly abort: () => void;
  readonly pricePerMillion: number;
  constructor(maxTokens: number, maxCostUsd: number, abort: () => void, pricePerMillion = 30) {
    this.maxTokens = maxTokens;
    this.maxCostUsd = maxCostUsd;
    this.abort = abort;
    this.pricePerMillion = pricePerMillion;
  }
  observe(tokens: number, cost: number | null, key: object = this) {
    if (
      !Number.isFinite(tokens) ||
      tokens < 0 ||
      (cost !== null && (!Number.isFinite(cost) || cost < 0))
    ) {
      this.reason = "Provider returned invalid usage";
    } else {
      const previous = this.samples.get(key) ?? { tokens: 0, cost: 0 };
      const sample = {
        tokens: Math.max(previous.tokens, tokens),
        cost: Math.max(previous.cost, cost ?? (tokens * this.pricePerMillion) / 1_000_000),
      };
      this.samples.set(key, sample);
      this.tokens += sample.tokens - previous.tokens;
      this.costUsd += sample.cost - previous.cost;
      if (this.tokens > this.maxTokens) this.reason = "Case token budget exceeded";
      if (this.costUsd > this.maxCostUsd) this.reason = "Case cost budget exceeded";
    }
    if (this.reason) this.abort();
  }
}

type UsageMetrics = {
  tokens: Record<string, number | null | undefined> | null;
  cost_usd: number | null;
};
const sumTokens = (m: UsageMetrics) =>
  Object.values(m.tokens ?? {}).reduce<number>((n, v) => n + (v ?? 0), 0);
const sessionOffsets = new WeakMap<object, { tokens: number; cost: number }>();
/** Carry usage of earlier sessions before a caller resets the shared metrics for a new session; `clear` drops it. */
export function setLiveUsageOffset(metrics: UsageMetrics, clear = false) {
  if (clear) sessionOffsets.delete(metrics);
  else sessionOffsets.set(metrics, { tokens: sumTokens(metrics), cost: metrics.cost_usd ?? 0 });
}
export function observeLiveUsage(metrics: UsageMetrics) {
  const runtime = liveRuntime.getStore();
  if (!runtime) return;
  const base = sessionOffsets.get(metrics) ?? { tokens: 0, cost: 0 };
  runtime.observe(
    base.tokens + sumTokens(metrics),
    metrics.cost_usd == null ? null : base.cost + metrics.cost_usd,
    metrics,
  );
}

export function remainingLiveBudgets(
  limits: { max_tokens: number; max_cost_usd: number; max_suite_cost_usd: number },
  usage: { caseTokens: number; caseCost: number; suiteCost: number },
) {
  return {
    tokens: Math.max(0, limits.max_tokens - usage.caseTokens),
    costUsd: Math.max(
      0,
      Math.min(limits.max_cost_usd - usage.caseCost, limits.max_suite_cost_usd - usage.suiteCost),
    ),
  };
}
