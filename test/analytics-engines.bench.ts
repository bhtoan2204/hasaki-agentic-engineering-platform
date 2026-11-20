/**
 * TypeScript vs Go analytics engines on one deterministic dataset in the isolated test database (never a real one):
 *
 *   npm run bench:analytics                         # local PostgreSQL (Unix socket)
 *   BENCH_DB_LATENCY_MS=20 npm run bench:analytics  # every packet to PostgreSQL delayed 20 ms each way (remote RDS)
 *
 * Per engine and dashboard (cold: no cache): latency p50/p95/p99, SQL statements and their summed execution time
 * per request as measured by each engine's database client, response size, CPU per request of the process doing the
 * work (Node or platform-go).
 * Then concurrent load (BENCH_CONCURRENCY clients over every dashboard) with probes for what dashboards must not
 * starve: a Node pool query (workflow engine, API) and a platform-go retrieval request; pool waits; peak RSS. Then
 * warm-cache reads through the public handler. Writes docs/architecture/analytics-engines.json.
 *
 * Env: BENCH_RUNS (dataset runs, default 20000), BENCH_N (iterations, default 15), BENCH_CONCURRENCY (default 8),
 * BENCH_DB_LATENCY_MS (default 0), BENCH_OUT (output path).
 */
import { createServer as tcpServer, connect, type Socket } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

if (process.env.PLATFORM_TEST !== "1")
  throw new Error("Use --import ./test/setup.ts with the isolated local test database");

const N = Number(process.env.BENCH_N ?? 15);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 8);
const LATENCY = Number(process.env.BENCH_DB_LATENCY_MS ?? 0);
const RUNS = Number(process.env.BENCH_RUNS ?? 20000);

/** A TCP → Unix-socket proxy that delays every chunk by LATENCY ms in each direction, keeping order. */
async function latencyProxy(socketPath: string) {
  const pipe = (from: Socket, to: Socket) => {
    let tail = Promise.resolve();
    from.on("data", (chunk) => {
      const due = Date.now() + LATENCY;
      tail = tail.then(
        () =>
          new Promise<void>((done) =>
            setTimeout(
              () => {
                to.write(chunk);
                done();
              },
              Math.max(0, due - Date.now()),
            ),
          ),
      );
    });
    from.on("close", () => void tail.then(() => to.destroy()));
    from.on("error", () => to.destroy());
  };
  const server = tcpServer((client) => {
    const upstream = connect({ path: socketPath });
    pipe(client, upstream);
    pipe(upstream, client);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}

if (LATENCY > 0) {
  const url = new URL(process.env.DATABASE_URL!);
  const host = url.searchParams.get("host")!;
  const port = await latencyProxy(`${host}/.s.PGSQL.5432`);
  url.searchParams.delete("host");
  url.host = `127.0.0.1:${port}`;
  process.env.DATABASE_URL = url.toString();
}

const { config } = await import("../src/config.ts");
const { migrate } = await import("../src/db/migrate.ts");
const { pool, one } = await import("../src/db/pool.ts");
const { seedAnalyticsDataset, DEFAULT_SIZE } = await import("./fixtures/analyticsDataset.ts");
const { parseAnalyticsFilters } = await import("../src/api/analytics/filters.ts");
const { loadDashboard, analyticsEngineStats } = await import("../src/api/analytics/engine.ts");
const { engineeringAnalytics } = await import("../src/api/analytics/index.ts");
const { flushAllCaches } = await import("../src/cache/index.ts");
const { retrievalService } = await import("../src/retrieval/semantic.ts");
const { startPlatformGo } = await import("./fixtures/platformGo.ts");
type Dashboard = Parameters<typeof loadDashboard>[0];

await migrate();
const seeded = performance.now();
await seedAnalyticsDataset({ ...DEFAULT_SIZE, runs: RUNS });
console.error(`dataset ready in ${((performance.now() - seeded) / 1000).toFixed(1)}s`);
// The production supervisor gives platform-go a pool of 4 (src/retrieval/goService.ts); analytics may use 2 of them.
const go = await startPlatformGo({ DATABASE_POOL_MAX: "4", ANALYTICS_MAX_CONCURRENT: "2" });

const users = await pool.query<{ id: number; username: string }>(
  "SELECT id,username FROM users WHERE username IN ('bench-user-1','bench-user-2')",
);
const admin = users.rows.find((u) => u.username === "bench-user-1")!;
const member = users.rows.find((u) => u.username === "bench-user-2")!;
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const range = `from=${day(-30)}&to=${day(1)}&timezone=Asia/Bangkok`;
const scenarios: Array<{ name: string; dashboard: Dashboard; query: string; all: boolean }> = [];
for (const [scope, all] of [
  ["member", false],
  ["support", true],
] as const) {
  for (const dashboard of ["usage", "performance", "workflows", "health", "options"] as const)
    scenarios.push({ name: `${dashboard} (${scope})`, dashboard, query: range, all });
  scenarios.push({
    name: `health-service (${scope})`,
    dashboard: "health-service",
    query: `${range}&service=api&namespace=oms`,
    all,
  });
  scenarios.push({
    name: `usage by repository, codex (${scope})`,
    dashboard: "usage",
    query: `${range}&group_by=repository&provider=codex`,
    all,
  });
  scenarios.push({
    name: `health, provider filter (${scope})`,
    dashboard: "health",
    query: `${range}&provider=claude&service=api&namespace=oms`,
    all,
  });
}
const scopeOf = (all: boolean) => ({ ownerId: all ? admin.id : member.id, all });

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? 0;
};
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
/** Statements and their execution time as seen by each engine's database client (local socket ≈ server time). */
const nodeSql = { statements: 0, ms: 0 };
const clientQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
  nodeSql.statements++;
  const t = performance.now();
  const done = () => (nodeSql.ms += performance.now() - t);
  // pg.Pool calls client.query with a callback (no promise); direct callers get a promise.
  const last = args.length - 1;
  if (typeof args[last] === "function") {
    const cb = args[last] as (...a: unknown[]) => void;
    args[last] = (...a: unknown[]) => (done(), cb(...a));
  }
  const r = (clientQuery as (...a: unknown[]) => unknown).apply(this, args);
  if (r && typeof (r as Promise<unknown>).then === "function")
    (r as Promise<unknown>).then(done, done);
  return r as never;
} as unknown as typeof clientQuery;
async function sqlTotals() {
  const g = await goStats();
  return { statements: nodeSql.statements + g.statements, ms: nodeSql.ms + g.statement_ms };
}
function goProc() {
  const stat = readFileSync(`/proc/${go.pid}/stat`, "utf8").split(") ")[1].split(" ");
  const status = readFileSync(`/proc/${go.pid}/status`, "utf8");
  const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(status)?.[1] ?? 0);
  return {
    cpuMs: ((Number(stat[11]) + Number(stat[12])) * 1000) / 100,
    rssMb: kb("VmRSS") / 1024,
    hwmMb: kb("VmHWM") / 1024,
  };
}
const nodeCpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const goStats = async () => (await retrievalService("/internal/v1/analytics/stats")).json();

type Cold = {
  p50: number;
  p95: number;
  p99: number;
  statements: number;
  sql_ms: number;
  bytes: number;
  node_cpu_ms: number;
  go_cpu_ms: number;
};
async function cold(engine: "typescript" | "go", s: (typeof scenarios)[number]): Promise<Cold> {
  config.analytics.engine = engine;
  const f = parseAnalyticsFilters(new URLSearchParams(s.query));
  await loadDashboard(s.dashboard, f, scopeOf(s.all)); // warm plans and connections
  const times: number[] = [];
  let bytes = 0;
  const before = await sqlTotals();
  const cpu0 = nodeCpuMs(),
    go0 = goProc().cpuMs;
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    const data = await loadDashboard(s.dashboard, f, scopeOf(s.all));
    times.push(performance.now() - t);
    bytes = Buffer.byteLength(JSON.stringify(data));
  }
  const cpu = nodeCpuMs() - cpu0,
    goCpu = goProc().cpuMs - go0;
  const after = await sqlTotals();
  return {
    p50: round(quantile(times, 0.5)),
    p95: round(quantile(times, 0.95)),
    p99: round(quantile(times, 0.99)),
    statements: round((after.statements - before.statements) / N, 2),
    sql_ms: round((after.ms - before.ms) / N),
    bytes,
    node_cpu_ms: round(cpu / N),
    go_cpu_ms: round(goCpu / N),
  };
}

/** CONCURRENCY clients loop over every scenario (cold), while two probes measure starvation every 50 ms. */
async function concurrent(engine: "typescript" | "go") {
  config.analytics.engine = engine;
  const lat: number[] = [];
  const nodeProbe: number[] = [];
  const goProbe: number[] = [];
  let maxNodeWaiting = 0;
  let stop = false;
  const probes = (async () => {
    while (!stop) {
      let t = performance.now();
      await pool.query("SELECT 1");
      nodeProbe.push(performance.now() - t);
      maxNodeWaiting = Math.max(maxNodeWaiting, pool.waitingCount);
      t = performance.now();
      const r = await retrievalService("/internal/v1/retrieval/status", undefined, 30_000).catch(
        () => null,
      );
      await r?.body?.cancel();
      goProbe.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  const g0 = await goStats();
  const sql0 = await sqlTotals();
  const cpu0 = nodeCpuMs(),
    go0 = goProc().cpuMs;
  const rss0 = process.memoryUsage().rss;
  let peakRss = rss0;
  const rssTimer = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 50);
  const fallbacks0 = JSON.stringify(analyticsEngineStats.fallbacks);
  const started = performance.now();
  let errors = 0;
  const errorMessages = new Map<string, number>();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_, c) => {
      for (let i = 0; i < scenarios.length; i++) {
        const s = scenarios[(i + c) % scenarios.length];
        const t = performance.now();
        try {
          await loadDashboard(
            s.dashboard,
            parseAnalyticsFilters(new URLSearchParams(s.query)),
            scopeOf(s.all),
          );
        } catch (e) {
          errors++;
          const m = String((e as Error).message).slice(0, 80);
          errorMessages.set(m, (errorMessages.get(m) ?? 0) + 1);
        }
        lat.push(performance.now() - t);
      }
    }),
  );
  const wall = performance.now() - started;
  clearInterval(rssTimer);
  stop = true;
  await probes;
  const g1 = await goStats();
  const sql1 = await sqlTotals();
  return {
    requests: lat.length,
    errors,
    error_messages: Object.fromEntries(errorMessages),
    fell_back: JSON.stringify(analyticsEngineStats.fallbacks) !== fallbacks0,
    throughput_rps: round((lat.length * 1000) / wall, 2),
    p50: round(quantile(lat, 0.5)),
    p95: round(quantile(lat, 0.95)),
    p99: round(quantile(lat, 0.99)),
    // Probe statements are excluded: one Node SELECT 1 per probe; the Go retrieval probe is not analytics.
    sql_ms_per_request: round((sql1.ms - sql0.ms) / lat.length),
    statements_per_request: round(
      (sql1.statements - sql0.statements - nodeProbe.length) / lat.length,
      2,
    ),
    node_cpu_ms: round(nodeCpuMs() - cpu0),
    go_cpu_ms: round(goProc().cpuMs - go0),
    node_rss_growth_mb: round((peakRss - rss0) / 1048576),
    go_rss_hwm_mb: round(goProc().hwmMb),
    node_pool_probe_p95_ms: round(quantile(nodeProbe, 0.95)),
    node_pool_probe_max_ms: round(Math.max(...nodeProbe)),
    node_pool_max_waiting: maxNodeWaiting,
    go_retrieval_probe_p95_ms: round(quantile(goProbe, 0.95)),
    go_retrieval_probe_max_ms: round(Math.max(...goProbe)),
    go_slot_wait_ms: round(g1.slot_wait_ms - g0.slot_wait_ms),
    go_pool_acquire_wait_ms: round(g1.pool.acquire_wait_ms - g0.pool.acquire_wait_ms),
  };
}

async function warm(engine: "typescript" | "go") {
  config.analytics.engine = engine;
  flushAllCaches();
  const actor = { id: member.id, username: member.username, role: "member" } as never;
  const url = new URL(`http://x/api/analytics/usage?${range}`);
  let t = performance.now();
  await engineeringAnalytics(actor, url, "usage");
  const first = performance.now() - t;
  const times: number[] = [];
  for (let i = 0; i < N; i++) {
    t = performance.now();
    await engineeringAnalytics(actor, url, "usage");
    times.push(performance.now() - t);
  }
  return { first_ms: round(first), hit_p50_ms: round(quantile(times, 0.5), 3) };
}

const result: Record<string, unknown> = {
  generated_at: new Date().toISOString(),
  dataset: { ...DEFAULT_SIZE, runs: RUNS },
  db_latency_ms_each_way: LATENCY,
  iterations: N,
  concurrency: CONCURRENCY,
  postgres: (await one<{ v: string }>(pool, "SELECT version() AS v"))!.v.split(" on ")[0],
  node_pool_max: config.database.poolMax,
  go_pool_max: 4,
  go_analytics_pool_max: 2,
  cold: {} as Record<string, Record<string, Cold>>,
};
const coldOut = result.cold as Record<string, Record<string, Cold>>;
for (const s of scenarios) {
  coldOut[s.name] = { typescript: await cold("typescript", s), go: await cold("go", s) };
  const { typescript: a, go: b } = coldOut[s.name];
  console.error(
    `${s.name.padEnd(42)} p95 ${a.p95}→${b.p95} ms  stmts ${a.statements}→${b.statements}  sql ${a.sql_ms}→${b.sql_ms} ms`,
  );
}
result.concurrent = { typescript: await concurrent("typescript"), go: await concurrent("go") };
console.error("concurrent", JSON.stringify(result.concurrent));
result.warm_cache = { typescript: await warm("typescript"), go: await warm("go") };
result.go_process = goProc();

const out =
  process.env.BENCH_OUT ??
  resolve(
    import.meta.dirname,
    `../docs/architecture/analytics-engines${LATENCY ? `-latency${LATENCY}` : ""}.json`,
  );
writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
console.error(`wrote ${out}`);
go.stop();
await pool.end();
process.exit(0);
