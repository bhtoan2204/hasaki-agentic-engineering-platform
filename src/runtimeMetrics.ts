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
  ignored.clear();
  loop.reset();
}
