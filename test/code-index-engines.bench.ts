/**
 * TypeScript vs Go code intelligence indexing on identical commits, against an isolated local PostgreSQL started by
 * test/setup.ts (never a real database):
 *   npm run bench:code-index -- ~/src/oms-src/oms-api ~/src/oms-src/oms-frontend
 * Per engine: cold full index, incremental index of a commit changing ~2% of files, and the repositories indexed
 * concurrently. Measures wall time, CPU time and peak RSS of the process doing the work, database statements, and
 * the Node event-loop delay meanwhile (what the API and chat feel). Writes docs/architecture/code-index-engines.json.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import pg from "pg";
import { config } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { pool, one, q } from "../src/db/pool.ts";
import { repositories } from "../src/repos/service.ts";
import { indexRepository } from "../src/codeIntelligence/indexer.ts";
import { startPlatformGo } from "./fixtures/platformGo.ts";

if (process.env.PLATFORM_TEST !== "1")
  throw new Error("Use --import ./test/setup.ts with the isolated local test database");
const sources = process.argv.slice(2);
if (!sources.length) throw new Error("usage: code-index-engines.bench.ts <repository checkout>...");
config.codeIntelligence.enabled = true;
await migrate();
const go = await startPlatformGo({ CODE_INDEX_JOBS: String(sources.length) });

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "bench",
  GIT_AUTHOR_EMAIL: "bench@example.com",
  GIT_COMMITTER_NAME: "bench",
  GIT_COMMITTER_EMAIL: "bench@example.com",
};
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env, maxBuffer: 1 << 28 }).trim();

/** A local copy of the source's HEAD on the base branch (no remote, so nothing is fetched). */
async function prepare(source: string) {
  const name = `bench-${basename(source)}`;
  const root = join(config.reposRoot, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", config.baseBranch);
  git(root, "fetch", "-q", "--no-tags", resolve(source), "HEAD");
  git(root, "reset", "-q", "--hard", "FETCH_HEAD");
  await repositories.upsert(name, { projects: ["BENCH"] });
  return { name, root };
}

/** Changes ~2% of the indexed files in a new commit on the base branch. */
function commitChanges(root: string) {
  const files = git(root, "ls-files", "*.go", "*.ts", "*.tsx", "*.js", "*.sql", "*.proto")
    .split("\n")
    .filter(Boolean);
  const changed = files.filter((_, i) => i % 50 === 0);
  for (const f of changed)
    writeFileSync(join(root, f), readFileSync(join(root, f), "utf8") + "\n// bench change\n");
  git(root, "commit", "-qam", "bench change");
  return changed.length;
}

let statements = 0;
const clientQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (this: pg.Client, ...args: Parameters<typeof clientQuery>) {
  statements++;
  return clientQuery.apply(this, args);
} as typeof clientQuery;

const goCpuMs = () => {
  const f = readFileSync(`/proc/${go.pid}/stat`, "utf8").split(") ")[1].split(" ");
  return ((Number(f[11]) + Number(f[12])) * 1000) / 100; // utime + stime, USER_HZ = 100
};
const rssKb = (pid: number | "self") =>
  Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]);

async function measure(engine: "typescript" | "go", work: () => Promise<unknown[]>) {
  config.codeIntelligence.engine = engine;
  const pid = engine === "go" ? go.pid : "self";
  const loop = monitorEventLoopDelay({ resolution: 10 });
  let peak = rssKb(pid);
  const sampler = setInterval(() => (peak = Math.max(peak, rssKb(pid))), 20);
  const cpu0 = engine === "go" ? goCpuMs() : process.cpuUsage();
  const before = { statements };
  loop.enable();
  const t = performance.now();
  const results = (await work()) as Array<{
    snapshot: { id: number };
    metrics: Record<string, number>;
  }>;
  const wall = performance.now() - t;
  loop.disable();
  clearInterval(sampler);
  const cpu =
    engine === "go"
      ? goCpuMs() - (cpu0 as number)
      : ((u) => (u.user + u.system) / 1000)(process.cpuUsage(cpu0 as NodeJS.CpuUsage));
  const sym = await one(
    pool,
    "SELECT coalesce(sum(symbol_count),0)::int AS symbols, coalesce(sum(indexed_files),0)::int AS files FROM code_intelligence.snapshots WHERE id = ANY($1)",
    [results.map((r) => r.snapshot.id)],
  );
  const parsed = results.reduce(
    (n, r) => n + (r.metrics.parsed_files ?? r.metrics.indexed_files - r.metrics.index_cache_hits),
    0,
  );
  return {
    wall_ms: Math.round(wall),
    cpu_ms: Math.round(cpu),
    peak_rss_mb: Math.round(peak / 1024),
    db_statements:
      engine === "go"
        ? results.reduce((n, r) => n + (r.metrics.db_statements ?? 0), 0) +
          (statements - before.statements)
        : statements - before.statements,
    indexed_files: sym!.files,
    symbols: sym!.symbols,
    files_per_s: Math.round((sym!.files / wall) * 1000),
    parsed_files: parsed,
    event_loop_p99_ms: Math.round(loop.percentile(99) / 1e6),
    event_loop_max_ms: Math.round(loop.max / 1e6),
  };
}

const wipe = () =>
  q(
    pool,
    "TRUNCATE code_intelligence.files, code_intelligence.snapshots, code_intelligence.symbols, code_intelligence.relations, code_intelligence.extractions CASCADE",
  );

const repos: Array<{ name: string; root: string }> = [];
for (const s of sources) repos.push(await prepare(s));
// Load parsers once per engine (WASM grammars / CGO init) on a small repository.
for (const engine of ["typescript", "go"] as const) {
  config.codeIntelligence.engine = engine;
  await wipe();
  await indexRepository(repos[0].name);
}
const report: Record<string, unknown> = {
  generated_at: new Date().toISOString(),
  machine: { cpus: (await import("node:os")).cpus().length },
  go_parse_workers: "min(4, cpus/2)",
  repositories: {},
};
for (const engine of ["typescript", "go"] as const) {
  const per: Record<string, unknown> = {};
  for (const r of repos) {
    await wipe();
    const full = await measure(engine, async () => [await indexRepository(r.name)]);
    const changed = commitChanges(r.root);
    const incremental = await measure(engine, async () => [await indexRepository(r.name)]);
    git(r.root, "reset", "-q", "--hard", "HEAD~1");
    per[r.name] = { full, incremental: { ...incremental, changed_files: changed } };
  }
  await wipe();
  per.concurrent = await measure(engine, () =>
    Promise.all(repos.map((r) => indexRepository(r.name))),
  );
  (report.repositories as Record<string, unknown>)[engine] = per;
}
writeFileSync(
  resolve(import.meta.dirname, "../docs/architecture/code-index-engines.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
go.stop();
await pool.end();
process.exit(0);
