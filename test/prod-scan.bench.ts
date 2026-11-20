/**
 * Production error scan benchmark (ADR 0004), against fake Splunk/SigNoz servers and the isolated test database
 * behind a proxy that adds BENCH_DB_LATENCY_MS (default 20) each way and counts statements per client:
 *
 *   BENCH_ENGINE=typescript npm run bench:prod-scan
 *   BENCH_ENGINE=go npm run bench:prod-scan
 *
 * Runs unchanged on the pre-migration commit (no src/prodErrors/jobs.ts: the legacy in-process scan), which is how
 * the "before" numbers are produced. Measures one scan (latency, statements, provider requests, CPU, event loop),
 * two instances starting a scan at once, and an idle minute of the schedule and job pollers.
 *
 * Env: BENCH_ENGINE, BENCH_N (scans, default 5), BENCH_ROWS (Splunk groups, default 300), BENCH_PROVIDER_MS
 * (latency of every provider request, default 50), BENCH_DB_LATENCY_MS, BENCH_IDLE_SECONDS (default 65), BENCH_OUT.
 */
import { createServer as tcpServer, connect, type Socket } from "node:net";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

if (process.env.PLATFORM_TEST !== "1")
  throw new Error("Use --import ./test/setup.ts with the isolated local test database");
const ENGINE = process.env.BENCH_ENGINE ?? "typescript";
const N = Number(process.env.BENCH_N ?? 5);
const ROWS = Number(process.env.BENCH_ROWS ?? 300);
const PROVIDER_MS = Number(process.env.BENCH_PROVIDER_MS ?? 50);
const LATENCY = Number(process.env.BENCH_DB_LATENCY_MS ?? 20);
const IDLE = Number(process.env.BENCH_IDLE_SECONDS ?? 65);
const root = resolve(import.meta.dirname, "..");
const durable = existsSync(resolve(root, "src/prodErrors/jobs.ts"));
process.env.SPLUNK_POLL_MS = "500";

/** TCP → Unix socket proxy: LATENCY ms each way, and a count of statements (Query/Execute messages) sent. */
async function dbProxy(socketPath: string) {
  const stats = { statements: 0 };
  const delayed = (from: Socket, to: Socket, count: boolean) => {
    let tail = Promise.resolve();
    let buf = Buffer.alloc(0);
    let startup = count;
    from.on("data", (chunk) => {
      if (count) {
        buf = Buffer.concat([buf, chunk as Buffer]);
        for (;;) {
          if (startup) {
            if (buf.length < 4) break;
            const len = buf.readInt32BE(0);
            if (buf.length < len) break;
            buf = buf.subarray(len);
            // SSLRequest is answered, then the real startup message follows.
            startup = len === 8;
            continue;
          }
          if (buf.length < 5) break;
          const len = buf.readInt32BE(1);
          if (buf.length < len + 1) break;
          const type = String.fromCharCode(buf[0]);
          if (type === "Q" || type === "E") stats.statements++;
          buf = buf.subarray(len + 1);
        }
      }
      const due = Date.now() + LATENCY;
      tail = tail.then(
        () =>
          new Promise<void>((r) =>
            setTimeout(() => (to.write(chunk), r()), Math.max(0, due - Date.now())),
          ),
      );
    });
    from.on("close", () => void tail.then(() => to.destroy()));
    from.on("error", () => to.destroy());
  };
  const server = tcpServer((client) => {
    const upstream = connect({ path: socketPath });
    delayed(client, upstream, true);
    delayed(upstream, client, false);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, stats };
}
const dbUrl = new URL(process.env.DATABASE_URL!);
const socket = `${dbUrl.searchParams.get("host")}/.s.PGSQL.5432`;
const through = (port: number) => {
  const u = new URL(dbUrl);
  u.searchParams.delete("host");
  u.host = `127.0.0.1:${port}`;
  return u.toString();
};
const nodeDb = await dbProxy(socket);
const goDb = await dbProxy(socket);
process.env.DATABASE_URL = through(nodeDb.port);

const { config } = await import("../src/config.ts");
const { migrate } = await import("../src/db/migrate.ts");
const { pool, q } = await import("../src/db/pool.ts");
const { execution } = await import("../src/auth/execution.ts");
const { createUser } = await import("../src/auth/users.ts");
const { setSplunkCookie } = await import("../src/integrations/splunk.ts");
const { saveSignoz } = await import("../src/integrations/signoz.ts");
const { loadPersonalIntegrations } = await import("../src/integrations/loadPersonal.ts");
const scan = await import("../src/prodErrors/scan.ts");

// ---------------------------------------------------------------- fake providers
const H = Math.floor(Date.now() / 3_600_000) * 3600 - 3600;
const provider = { splunk: 0, signoz: 0, searches: 0 };
const later = <T>(fn: () => T) => new Promise<T>((r) => setTimeout(() => r(fn()), PROVIDER_MS));
const rows = Array.from({ length: ROWS }, (_, i) => ({
  ns: i % 2 ? "oms-prod" : "payment-prod",
  svc: `svc-${i % 17}`,
  lv: i % 50 ? "ERROR" : "PANIC",
  sig: `error ${i} while handling request`,
  today: String(2000 - i),
  yesterday: String(i % 3 ? 1000 - i : 0),
  first: String(H + i),
  last: String(H + 3000 + i),
  sample: `error ${i} while handling request id=${i}`,
  caller: `pkg/file${i % 9}.go:${i}`,
  image: "harbor.example/oms/oms-api:prod.2611051524.efd844a",
  analytics_hourly: [`${H}:${1000 - i}`, `${H + 3600}:${1000}`],
}));
let polls = 0;
const splunkServer: Server = createServer((req, res) => {
  provider.splunk++;
  const url = new URL(req.url!, "http://x");
  const json = (b: unknown) =>
    void later(
      () => (
        res.writeHead(200, { "content-type": "application/json" }),
        res.end(JSON.stringify(b))
      ),
    );
  if (url.pathname.endsWith("/authentication/current-context"))
    return json({ entry: [{ content: { username: "bench@example.vn", roles: ["dev"] } }] });
  if (req.method === "GET" && url.pathname.endsWith("/search/jobs/job1"))
    return json({
      entry: [
        {
          content: {
            dispatchState: ++polls % 3 ? "RUNNING" : "DONE",
            doneProgress: 0.5,
            scanCount: 10,
            eventCount: 5,
            isDone: polls % 3 === 0,
          },
        },
      ],
    });
  if (url.pathname.endsWith("/results")) return json({ results: rows });
  req.resume();
  req.on("end", () => {
    if (url.pathname.endsWith("/search/jobs")) provider.searches++;
    json({ sid: "job1" });
  });
});
const signozServer: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    provider.signoz++;
    const send = (b: unknown) =>
      void later(
        () => (
          res.writeHead(200, { "content-type": "application/json" }),
          res.end(JSON.stringify(b))
        ),
      );
    if (!raw) return send({ status: "success", data: { keys: {} } });
    const body = JSON.parse(raw);
    const spec = body.compositeQuery?.queries?.[0]?.spec ?? {};
    const keys: string[] = (spec.groupBy ?? []).map((g: { name: string }) => g.name);
    if (/parent_span_id = ''/.test(spec.filter?.expression ?? ""))
      return send({ status: "success", data: { type: body.requestType, data: { results: [] } } });
    const groups = Array.from({ length: 40 }, (_, i) => [
      "oms-prod",
      `svc-${i % 17}`,
      `POST /api/${i}`,
      `status ${i}`,
      "500",
    ]);
    const data =
      body.requestType === "time_series"
        ? {
            results: [
              {
                queryName: "A",
                aggregations: [
                  {
                    index: 0,
                    series: groups.map((l) => ({
                      labels: keys.map((name, k) => ({ key: { name }, value: l[k] })),
                      values: [{ timestamp: H * 1000, value: 9 }],
                    })),
                  },
                ],
              },
            ],
          }
        : body.requestType === "scalar"
          ? {
              results: [
                {
                  queryName: "A",
                  columns: [...keys, "value"].map((name) => ({ name })),
                  data: keys.length ? groups.map((l) => [...l, 9]) : [[12]],
                },
              ],
            }
          : { results: [{ queryName: "A", rows: [] }] };
    send({ status: "success", data: { type: body.requestType, data } });
  });
});
await new Promise<void>((r) => splunkServer.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => signozServer.listen(0, "127.0.0.1", r));

await migrate();
const admin = await createUser({
  username: "bench-admin",
  password: "bench-password",
  role: "admin",
});
config.splunk.baseUrl = `http://127.0.0.1:${(splunkServer.address() as AddressInfo).port}`;
config.signoz.allowedInternalHosts = ["127.0.0.1"];
config.prodErrors.userId = admin.id;
const asAdmin = <T>(fn: () => Promise<T>) =>
  execution.run({ userId: admin.id, kind: "user" }, async () => {
    await loadPersonalIntegrations(true);
    return fn();
  });
await asAdmin(async () => {
  await setSplunkCookie("splunkd_8000=SESSIONabc; splunkweb_csrf_token_8000=CSRF123");
  await saveSignoz({
    baseUrl: `http://127.0.0.1:${(signozServer.address() as AddressInfo).port}`,
    token: "sz-bench-key-0123456789",
    enabled: true,
  });
});

let go: { pid: number; stop: () => void } | null = null;
let platform: Server | null = null;
if (ENGINE === "go") {
  if (!durable)
    throw new Error("the Go engine needs the durable scan jobs (src/prodErrors/jobs.ts)");
  const { handle } = await import("../src/http/app.ts");
  platform = createServer(handle);
  await new Promise<void>((r) => platform!.listen(0, "127.0.0.1", r));
  const { startPlatformGo } = await import("./fixtures/platformGo.ts");
  go = await startPlatformGo({
    DATABASE_URL: through(goDb.port),
    PROD_ERRORS_ENGINE: "go",
    PLATFORM_INTERNAL_URL: `http://127.0.0.1:${(platform.address() as AddressInfo).port}`,
  });
  (config.prodErrors as { engine?: string }).engine = "go";
}

const goCpuMs = () => {
  if (!go) return 0;
  const stat = readFileSync(`/proc/${go.pid}/stat`, "utf8").split(") ")[1].split(" ");
  return ((Number(stat[11]) + Number(stat[12])) * 1000) / 100;
};
const goRssMb = () =>
  go
    ? Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${go.pid}/status`, "utf8"))?.[1] ?? 0) / 1024
    : 0;
const nodeCpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
// The benchmark's own polling goes over a direct connection: only the platform's statements are counted.
const pg = (await import("pg")).default;
const probe = new pg.Pool({ connectionString: dbUrl.toString(), max: 1 });
const one = async (_db: unknown, sql: string, params: unknown[] = []) =>
  (await probe.query(sql, params)).rows[0];
const latestScan = () =>
  one(
    pool,
    "SELECT id, ok, finished_at, groups, error FROM prod_error_scans ORDER BY id DESC LIMIT 1",
  );
const maxId = async () =>
  Number((await one(pool, "SELECT COALESCE(max(id),0) AS id FROM prod_error_scans")).id);
/** Until a scan newer than `after` exists and nothing is running (the legacy scan inserts its row asynchronously). */
const waitIdle = async (after: number) => {
  for (;;) {
    const r = await one(
      pool,
      "SELECT max(id) AS id, count(*) FILTER (WHERE finished_at IS NULL)::int AS running FROM prod_error_scans",
    );
    if (Number(r.id) > after && r.running === 0) return;
    await new Promise((x) => setTimeout(x, 50));
  }
};
const start = (opts = {}) =>
  asAdmin(() =>
    Promise.resolve(scan.startScan("manual", opts, { requestedBy: admin.id } as never)),
  );
const quantile = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)];
const round = (x: number) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------- one scan at a time
const times: number[] = [];
const elDelay = monitorEventLoopDelay({ resolution: 10 });
const before = {
  node: nodeDb.stats.statements,
  go: goDb.stats.statements,
  ...provider,
  cpu: nodeCpuMs(),
  gocpu: goCpuMs(),
};
let last = await maxId();
await start(); // warm-up (connections, plans, Go claim path)
await waitIdle(last);
const warm = {
  node: nodeDb.stats.statements,
  go: goDb.stats.statements,
  ...provider,
  cpu: nodeCpuMs(),
  gocpu: goCpuMs(),
};
elDelay.enable();
for (let i = 0; i < N; i++) {
  const t = performance.now();
  last = await maxId();
  await start();
  await waitIdle(last);
  times.push(performance.now() - t);
  const s = await latestScan();
  if (!s.ok) throw new Error(`scan ${s.id} failed: ${s.error}`);
}
elDelay.disable();
const after = {
  node: nodeDb.stats.statements,
  go: goDb.stats.statements,
  ...provider,
  cpu: nodeCpuMs(),
  gocpu: goCpuMs(),
};
void before;
const single = {
  scans: N,
  groups: (await latestScan()).groups,
  latency_p50_ms: round(quantile(times, 0.5)),
  latency_max_ms: round(Math.max(...times)),
  node_db_statements_per_scan: round((after.node - warm.node) / N),
  go_db_statements_per_scan: round((after.go - warm.go) / N),
  splunk_requests_per_scan: round((after.splunk - warm.splunk) / N),
  signoz_requests_per_scan: round((after.signoz - warm.signoz) / N),
  node_cpu_ms_per_scan: round((after.cpu - warm.cpu) / N),
  go_cpu_ms_per_scan: round((after.gocpu - warm.gocpu) / N),
  event_loop_p99_ms: round(elDelay.percentile(99) / 1e6),
  event_loop_max_ms: round(elDelay.max / 1e6),
  node_rss_mb: round(process.memoryUsage().rss / 1048576),
  go_rss_hwm_mb: round(goRssMb()),
};
console.error("single", JSON.stringify(single));

// ---------------------------------------------------------------- two instances at once
// Before: the lock was a module variable, so each instance ran its own scan; the legacy runScan is what each
// instance's startScan ran. Now both go through the shared queue.
const scans0 = (await one(pool, "SELECT count(*)::int AS n FROM prod_error_scans")).n;
const searches0 = provider.searches;
const statements0 = nodeDb.stats.statements + goDb.stats.statements;
const t0 = performance.now();
last = await maxId();
if (durable) await Promise.all([start(), start()]);
else
  await Promise.all([asAdmin(() => scan.runScan("manual")), asAdmin(() => scan.runScan("manual"))]);
await waitIdle(last);
const concurrent = {
  scans_run: (await one(pool, "SELECT count(*)::int AS n FROM prod_error_scans")).n - scans0,
  splunk_searches: provider.searches - searches0,
  db_statements: nodeDb.stats.statements + goDb.stats.statements - statements0,
  wall_ms: round(performance.now() - t0),
};
console.error("concurrent", JSON.stringify(concurrent));

// ---------------------------------------------------------------- idle
await q(pool, "SELECT 1");
const idle0 = {
  node: nodeDb.stats.statements,
  go: goDb.stats.statements,
  cpu: nodeCpuMs(),
  gocpu: goCpuMs(),
};
scan.startProdErrorSchedule();
await new Promise((r) => setTimeout(r, IDLE * 1000));
const idle = {
  seconds: IDLE,
  node_db_statements_per_minute: round(((nodeDb.stats.statements - idle0.node) * 60) / IDLE),
  go_db_statements_per_minute: round(((goDb.stats.statements - idle0.go) * 60) / IDLE),
  node_cpu_ms_per_minute: round(((nodeCpuMs() - idle0.cpu) * 60) / IDLE),
  go_cpu_ms_per_minute: round(((goCpuMs() - idle0.gocpu) * 60) / IDLE),
};
console.error("idle", JSON.stringify(idle));

const result = {
  generated_at: new Date().toISOString(),
  engine: durable ? ENGINE : "legacy (pre-migration)",
  db_latency_ms_each_way: LATENCY,
  provider_latency_ms: PROVIDER_MS,
  splunk_rows: ROWS,
  single,
  concurrent,
  idle,
};
const out =
  process.env.BENCH_OUT ??
  resolve(root, `docs/architecture/prod-scan-${durable ? ENGINE : "legacy"}.json`);
writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
console.error(`wrote ${out}`);
go?.stop();
platform?.close();
splunkServer.close();
signozServer.close();
await pool.end();
await probe.end();
process.exit(0);
