/**
 * Process-wide runtime metrics that explain latency on the critical paths (GET /api/metrics/runtime, admin only, next
 * to /api/metrics/cache): database statements, transactions and pool waits, scheduler claims and queue wait, shared
 * provider-health reuse, replay decisions and checkpoint size, API response size and compression, event-loop delay.
 *
 * Fixed metric names and fixed label values only (no run, user, repository or prompt values): memory is constant and
 * nothing private leaves the process. Histograms use fixed buckets; quantiles are bucket upper bounds.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";

const BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000];
const BYTE_BUCKETS = [1024, 8192, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216];

class Histogram {
  readonly bounds: number[];
  counts: number[];
  n = 0;
  sum = 0;
  max = 0;
  constructor(bounds: number[]) {
    this.bounds = bounds;
    this.counts = new Array(bounds.length + 1).fill(0);
  }
  observe(v: number) {
    if (!Number.isFinite(v) || v < 0) return;
    let i = 0;
    while (i < this.bounds.length && v > this.bounds[i]) i++;
    this.counts[i]++;
    this.n++;
    this.sum += v;
    if (v > this.max) this.max = v;
  }
  private quantile(p: number) {
    if (!this.n) return null;
    const rank = Math.ceil(p * this.n);
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      seen += this.counts[i];
      if (seen >= rank) return i < this.bounds.length ? this.bounds[i] : this.max;
    }
    return this.max;
  }
  snapshot() {
    return {
      count: this.n,
      avg: this.n ? Math.round((this.sum / this.n) * 10) / 10 : null,
      p50_le: this.quantile(0.5),
      p95_le: this.quantile(0.95),
      p99_le: this.quantile(0.99),
      max: Math.round(this.max * 10) / 10,
    };
  }
}

const COUNTERS = [
  "db.statements",
  "db.transactions",
  "db.transactions_rolled_back",
  "scheduler.claims",
  "scheduler.claims_empty",
  "scheduler.wakes",
  "health.shared_probes",
  "health.shared_reused",
  "health.invalidated",
  "health.switch_probes",
  "http.responses",
  "http.responses_compressed",
  "http.bytes_raw",
  "http.bytes_sent",
] as const;
export type Counter = (typeof COUNTERS)[number];
const HISTOGRAMS = {
  "db.transaction_ms": BUCKETS,
  "db.pool_connect_wait_ms": BUCKETS,
  "scheduler.queue_wait_ms": BUCKETS,
  "workflow.attempt_ms": BUCKETS,
  "workflow.replay_plan_ms": BUCKETS,
  "workflow.checkpoint_bytes": BYTE_BUCKETS,
  "http.route_ms": BUCKETS,
  "http.response_bytes": BYTE_BUCKETS,
  "shared.lookup_ms": BUCKETS,
} as const;
export type HistogramName = keyof typeof HISTOGRAMS;
/** Replay and checkpoint decisions (execution_decisions.action values), counted per action. */
const DECISIONS = [
  "REUSE",
  "REEXECUTE",
  "FORCE_REEXECUTE",
  "VERIFY_ONLY",
  "RECONCILE",
  "RESTORE",
  "RECORD",
] as const;

/** Task memory aging (knowledge/aging.ts): decisions per policy and action, fixed label sets. */
export const MEMORY_AGING_POLICIES = [
  "replacement",
  "stale",
  "unknown",
  "unapproved",
  "disuse",
  "lesson_contradicted",
  "lesson_disputed",
  "chat_contradicted",
  "procedure_failed",
  "cap",
  "purge",
  "manual",
] as const;
export type MemoryAgingPolicy = (typeof MEMORY_AGING_POLICIES)[number];
export const MEMORY_AGING_ACTIONS = [
  "archive",
  "supersede",
  "dormant",
  "restore",
  "purge",
] as const;
export type MemoryAgingAction = (typeof MEMORY_AGING_ACTIONS)[number];
const aging = new Map<string, number>(
  MEMORY_AGING_POLICIES.flatMap((p) => MEMORY_AGING_ACTIONS.map((a) => [`${p}.${a}`, 0] as const)),
);
/** Active task memory per owner: the one owner-keyed metric (admin endpoint only), bounded to the largest owners. */
const MAX_AGING_OWNERS = 50;
let activeTaskMemory = { total: 0, per_owner: {} as Record<string, number>, other: 0 };

/** Shared results (src/sharing): events per kind, fixed label sets. */
export const SHARED_METRIC_KINDS = [
  "code_assessment",
  "prod_error.runtime_rca",
  "prod_error.bug_hunt",
] as const;
export const SHARED_METRIC_EVENTS = [
  "hit",
  "wait",
  "miss",
  "forced",
  "bypass",
  "retry_held",
  "denied",
  "lost_race",
  "published",
  "failed",
  "stale",
  "expired",
] as const;
export type SharedMetricEvent = (typeof SHARED_METRIC_EVENTS)[number];
const sharedZero = () =>
  new Map<string, number>(
    SHARED_METRIC_KINDS.flatMap((k) => [
      ...SHARED_METRIC_EVENTS.map((e) => [`${k}.${e}`, 0] as const),
      [`${k}.tokens_saved`, 0] as const,
    ]),
  );
let shared = sharedZero();

const counters = new Map<string, number>(COUNTERS.map((c) => [c, 0]));
const histograms = new Map<string, Histogram>(
  Object.entries(HISTOGRAMS).map(([name, bounds]) => [name, new Histogram([...bounds])]),
);
const decisions = new Map<string, number>(DECISIONS.map((d) => [d, 0]));
const ignored = new Map<string, number>();
const MAX_IGNORED_CONTEXTS = 100;
const startedAt = Date.now();
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

export function count(name: Counter, by = 1) {
  counters.set(name, (counters.get(name) ?? 0) + by);
}
export function observe(name: HistogramName, value: number) {
  histograms.get(name)!.observe(value);
}
/** Errors deliberately swallowed (ignoreError): per call-site label, at most MAX_IGNORED_CONTEXTS labels, the rest in "other". */
export function countIgnoredError(context: string) {
  const key = ignored.has(context) || ignored.size < MAX_IGNORED_CONTEXTS ? context : "other";
  ignored.set(key, (ignored.get(key) ?? 0) + 1);
}
export function countDecision(action: string) {
  // Unknown values are folded into nothing: the label set stays fixed.
  if (decisions.has(action)) decisions.set(action, decisions.get(action)! + 1);
}

export function countMemoryAging(policy: MemoryAgingPolicy, action: MemoryAgingAction) {
  const key = `${policy}.${action}`;
  if (aging.has(key)) aging.set(key, aging.get(key)! + 1);
}
/** Unknown kinds or events are dropped: the label set stays fixed. */
export function countShared(kind: string, event: SharedMetricEvent | "tokens_saved", by = 1) {
  const key = `${kind}.${event}`;
  if (shared.has(key)) shared.set(key, shared.get(key)! + by);
}
function sharedSnapshot() {
  return Object.fromEntries(
    SHARED_METRIC_KINDS.map((k) => {
      const n = (e: string) => shared.get(`${k}.${e}`)!;
      const lookups = ["hit", "wait", "miss", "forced", "bypass", "retry_held"].reduce(
        (s, e) => s + n(e),
        0,
      );
      return [
        k,
        {
          ...(Object.fromEntries(SHARED_METRIC_EVENTS.map((e) => [e, n(e)])) as Record<
            SharedMetricEvent,
            number
          >),
          tokens_saved: n("tokens_saved"),
          lookups,
          // A hit and a wait both avoid a run of the model.
          avoided_runs: n("hit") + n("wait"),
          hit_rate: lookups ? Math.round((n("hit") / lookups) * 1000) / 1000 : null,
          stale_total: n("stale") + n("expired"),
        },
      ];
    }),
  );
}

export function setActiveTaskMemory(byOwner: Record<string, number>) {
  const sorted = Object.entries(byOwner).sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, MAX_AGING_OWNERS);
  activeTaskMemory = {
    total: sorted.reduce((n, [, v]) => n + v, 0),
    per_owner: Object.fromEntries(shown),
    other: sorted.slice(MAX_AGING_OWNERS).reduce((n, [, v]) => n + v, 0),
  };
}

/** Gauges read at snapshot time (pool sizes, busy workers), registered by their owners. */
const gauges = new Map<string, () => number>();
export function registerGauge(name: string, read: () => number) {
  gauges.set(name, read);
}

export function runtimeMetricsSnapshot() {
  const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
  return {
    since: new Date(startedAt).toISOString(),
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    counters: Object.fromEntries(counters),
    histograms: Object.fromEntries([...histograms].map(([k, h]) => [k, h.snapshot()])),
    replay_decisions: Object.fromEntries(decisions),
    ignored_errors: Object.fromEntries(ignored),
    memory_aging: { actions: Object.fromEntries(aging), active_task_memory: activeTaskMemory },
    shared_results: sharedSnapshot(),
    gauges: Object.fromEntries([...gauges].map(([k, read]) => [k, read()])),
    event_loop_ms: {
      p50: ms(loop.percentile(50)),
      p99: ms(loop.percentile(99)),
      max: ms(loop.max),
    },
    memory_mb: Math.round(process.memoryUsage().rss / 1048576),
  };
}

/** Tests: start from zero. */
export function resetRuntimeMetrics() {
  for (const k of counters.keys()) counters.set(k, 0);
  for (const [k, bounds] of Object.entries(HISTOGRAMS))
    histograms.set(k, new Histogram([...bounds]));
  for (const k of decisions.keys()) decisions.set(k, 0);
  for (const k of aging.keys()) aging.set(k, 0);
  activeTaskMemory = { total: 0, per_owner: {}, other: 0 };
  shared = sharedZero();
  ignored.clear();
  loop.reset();
}
