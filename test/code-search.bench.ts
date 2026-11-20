/**
 * Code search engines (ADR 0006) on 1, 5, 15 and 30 real repositories in the isolated test database:
 *
 *   BENCH_ENGINES=typescript,go npm run bench:code-search
 *   BENCH_DB_LATENCY_MS=20 npm run bench:code-search      # every PostgreSQL packet delayed 20 ms each way
 *
 * Each repository is a git checkout of this platform's own src/ (about 360 TypeScript files), indexed by the Go
 * indexer. Per engine, scale and operation (searchSymbols, findDependencies, findReferences, searchCodeExact,
 * buildCodeContext): the first call (cold) and BENCH_N further calls (warm) → p50/p95/p99, SQL statements (counted by
 * a proxy in front of PostgreSQL, Node and platform-go alike), git and ripgrep subprocesses (counted by PATH
 * wrappers), bytes read by the processes doing the work, Node CPU and event-loop delay, platform-go CPU/RSS, and
 * retrieval quality: the hits of both engines on the same query. Writes docs/architecture/code-search-engines*.json.
 */
import { connect, createServer as tcpServer, type Socket } from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

if (process.env.PLATFORM_TEST !== "1")
  throw new Error("Use --import ./test/setup.ts with the isolated local test database");
const ENGINES = (process.env.BENCH_ENGINES ?? "typescript,go").split(",") as Array<
  "typescript" | "go"
>;
const SCALES = (process.env.BENCH_SCALES ?? "1,5,15,30").split(",").map(Number);
const N = Number(process.env.BENCH_N ?? 5);
const LATENCY = Number(process.env.BENCH_DB_LATENCY_MS ?? 0);
const root = resolve(import.meta.dirname, "..");
const scratch = process.env.TEST_ROOT!;

// ---------------------------------------------------------------- counters: git/rg wrappers, database proxy
const wrapDir = join(scratch, "bench-wrappers");
const counterDir = join(scratch, "bench-counters");
mkdirSync(wrapDir, { recursive: true });
mkdirSync(counterDir, { recursive: true });
for (const tool of ["git", "rg"]) {
  const real = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
  writeFileSync(
    join(wrapDir, tool),
    `#!/bin/sh\nprintf . >> ${counterDir}/${tool}\nexec ${real} "$@"\n`,
  );
  chmodSync(join(wrapDir, tool), 0o755);
}
process.env.PATH = `${wrapDir}:${process.env.PATH}`;
const count = (tool: string) => {
  try {
    return readFileSync(join(counterDir, tool), "utf8").length;
  } catch {
    return 0;
  }
};

const db = { statements: 0 };
async function dbProxy(socketPath: string) {
  const pipe = (from: Socket, to: Socket, counting: boolean) => {
    let tail = Promise.resolve();
    let buf = Buffer.alloc(0);
    let startup = counting;
    from.on("data", (chunk: Buffer) => {
      if (counting) {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (startup) {
            if (buf.length < 4) break;
            const len = buf.readInt32BE(0);
            if (buf.length < len) break;
            buf = buf.subarray(len);
            startup = len === 8;
            continue;
          }
          if (buf.length < 5) break;
          const len = buf.readInt32BE(1);
          if (buf.length < len + 1) break;
          if (buf[0] === 0x51 || buf[0] === 0x45) db.statements++; // 'Q' simple query, 'E' execute
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
    pipe(client, upstream, true);
    pipe(upstream, client, false);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}
const url = new URL(process.env.DATABASE_URL!);
const port = await dbProxy(`${url.searchParams.get("host")}/.s.PGSQL.5432`);
url.searchParams.delete("host");
url.host = `127.0.0.1:${port}`;
process.env.DATABASE_URL = url.toString();

const { config } = await import("../src/config.ts");
const { migrate } = await import("../src/db/migrate.ts");
const { pool } = await import("../src/db/pool.ts");
const { repositories } = await import("../src/repos/service.ts");
const { indexRepository } = await import("../src/codeIntelligence/indexer.ts");
const search = await import("../src/codeIntelligence/search.ts");
const { startPlatformGo } = await import("./fixtures/platformGo.ts");
config.codeIntelligence.enabled = true;
config.codeIntelligence.engine = "go";
await migrate();
const go = await startPlatformGo({ CODE_INDEX_JOBS: "4" });

// ---------------------------------------------------------------- repositories
const MAX = Math.max(...SCALES);
const names = Array.from(
  { length: MAX },
  (_, i) => `bench-search-${String(i + 1).padStart(2, "0")}`,
);
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "b",
  GIT_AUTHOR_EMAIL: "b@b",
  GIT_COMMITTER_NAME: "b",
  GIT_COMMITTER_EMAIL: "b@b",
};
const t0 = performance.now();
for (const name of names) {
  const dir = join(config.reposRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q", "-b", config.baseBranch], { env });
  execFileSync("git", ["-C", dir, "add", "."], { env });
  execFileSync("git", ["-C", dir, "commit", "-qm", "base"], { env });
  await repositories.upsert(name, { projects: ["BENCH"] });
}
for (let i = 0; i < names.length; i += 4)
  await Promise.all(names.slice(i, i + 4).map((n) => indexRepository(n)));
console.error(`${MAX} repositories indexed in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------- workloads
const QUERIES = [
  "searchSymbols fresh snapshot provenance",
  "superviseSpawn stop SupervisionReport",
  "enqueueScan heartbeat recoverScans",
  "missingSymbolNameThatDoesNotExist",
];
const SYMBOL = "fresh";
const QUALIFIED = "superviseSpawn";
type Op = (scope: Parameters<typeof search.searchSymbols>[1]) => Promise<unknown>;
const OPS: Record<string, Op> = {
  searchSymbols: async (scope) => {
    for (const q of QUERIES) await search.searchSymbols(q, scope, 30);
  },
  findDependencies: (scope) => search.findDependencies(QUALIFIED, scope, 2),
  findReferences: (scope) => search.findReferences(SYMBOL, scope),
  searchCodeExact: (scope) =>
    search.searchCodeExact("superviseSpawn(", scope, 20, { anyFile: true }),
  buildCodeContext: async (scope) => {
    for (const q of QUERIES.slice(0, 3)) await search.buildCodeContext(q, scope);
  },
};

const quantile = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)];
const round = (x: number) => Math.round(x * 10) / 10;
const ioBytes = (pid: number) => {
  try {
    return Number(/read_bytes: (\d+)/.exec(readFileSync(`/proc/${pid}/io`, "utf8"))?.[1] ?? 0);
  } catch {
    return 0;
  }
};
const goStat = () => {
  const s = readFileSync(`/proc/${go.pid}/stat`, "utf8").split(") ")[1].split(" ");
  return {
    cpu: ((Number(s[11]) + Number(s[12])) * 1000) / 100,
    hwm:
      Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${go.pid}/status`, "utf8"))?.[1] ?? 0) /
      1024,
  };
};

const result: Record<string, unknown> = {
  generated_at: new Date().toISOString(),
  db_latency_ms_each_way: LATENCY,
  iterations: N,
  repository: "this platform's src/ (≈360 TypeScript files) per repository",
  runs: {} as Record<string, unknown>,
  quality: {} as Record<string, unknown>,
};
const runs = result.runs as Record<string, Record<string, Record<string, unknown>>>;
for (const engine of ENGINES) {
  config.codeIntelligence.searchEngine = engine;
  runs[engine] = {};
  for (const scale of SCALES) {
    const scope = {
      repositories: names.slice(0, scale),
      allowed: names.slice(0, scale),
      provision: false,
    };
    runs[engine][scale] = {};
    for (const [name, op] of Object.entries(OPS)) {
      const measure = async () => {
        const s0 = db.statements,
          g0 = count("git"),
          r0 = count("rg"),
          io0 = ioBytes(process.pid) + ioBytes(go.pid);
        const c0 = process.cpuUsage(),
          go0 = goStat().cpu;
        const t = performance.now();
        await op(scope);
        return {
          ms: performance.now() - t,
          statements: db.statements - s0,
          git: count("git") - g0,
          rg: count("rg") - r0,
          bytes: ioBytes(process.pid) + ioBytes(go.pid) - io0,
          node_cpu: (process.cpuUsage(c0).user + process.cpuUsage(c0).system) / 1000,
          go_cpu: goStat().cpu - go0,
        };
      };
      const cold = await measure();
      const el = monitorEventLoopDelay({ resolution: 5 });
      el.enable();
      const warm: Array<Awaited<ReturnType<typeof measure>>> = [];
      for (let i = 0; i < N; i++) warm.push(await measure());
      el.disable();
      const avg = (k: keyof (typeof warm)[number]) =>
        round(warm.reduce((a, w) => a + w[k], 0) / warm.length);
      runs[engine][scale][name] = {
        cold_ms: round(cold.ms),
        p50_ms: round(
          quantile(
            warm.map((w) => w.ms),
            0.5,
          ),
        ),
        p95_ms: round(
          quantile(
            warm.map((w) => w.ms),
            0.95,
          ),
        ),
        p99_ms: round(
          quantile(
            warm.map((w) => w.ms),
            0.99,
          ),
        ),
        sql_statements: avg("statements"),
        git_subprocesses: avg("git"),
        rg_subprocesses: avg("rg"),
        bytes_read: avg("bytes"),
        node_cpu_ms: avg("node_cpu"),
        go_cpu_ms: avg("go_cpu"),
        event_loop_p99_ms: round(el.percentile(99) / 1e6),
      };
      console.error(
        engine.padEnd(10),
        String(scale).padStart(2),
        name.padEnd(16),
        JSON.stringify(runs[engine][scale][name]),
      );
    }
  }
}
// Retrieval quality: the same queries on all repositories, compared hit for hit.
if (ENGINES.length > 1) {
  const scope = {
    repositories: names.slice(0, MAX),
    allowed: names.slice(0, MAX),
    provision: false,
  };
  const answers: Record<string, unknown[]> = {};
  for (const engine of ENGINES) {
    config.codeIntelligence.searchEngine = engine;
    answers[engine] = [];
    for (const q of QUERIES) answers[engine].push((await search.searchSymbols(q, scope, 30)).hits);
    answers[engine].push(await search.findDependencies(QUALIFIED, scope, 2));
    answers[engine].push((await search.buildCodeContext(QUERIES[0], scope)).body);
  }
  // Key order differs between engines' JSON; compare values.
  const same = answers[ENGINES[0]].map((a, i) => isDeepStrictEqual(a, answers[ENGINES[1]][i]));
  result.quality = {
    identical_results: same.every(Boolean),
    identical_per_query: same,
    hits_per_query: answers[ENGINES[0]].map((a) =>
      Array.isArray(a) ? a.length : String(a).length,
    ),
  };
}
// p50 improvement of the second engine over the first, per scale and operation (positive = faster).
if (ENGINES.length > 1)
  result.p50_improvement_pct = Object.fromEntries(
    SCALES.map((scale) => [
      scale,
      Object.fromEntries(
        Object.keys(OPS).map((op) => {
          const a = runs[ENGINES[0]][scale][op] as { p50_ms: number };
          const b = runs[ENGINES[1]][scale][op] as { p50_ms: number };
          return [op, round((100 * (a.p50_ms - b.p50_ms)) / a.p50_ms)];
        }),
      ),
    ]),
  );
result.platform_go = goStat();
const file = join(
  root,
  `docs/architecture/code-search-engines${LATENCY ? `-latency${LATENCY}` : ""}${ENGINES.length === 1 ? `-${ENGINES[0]}` : ""}.json`,
);
writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
console.error(`wrote ${file}`);
go.stop();
await pool.end();
spawnSync("true");
process.exit(0);
