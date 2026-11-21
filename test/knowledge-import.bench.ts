/**
 * Knowledge import engines (ADR 0007) on 1, 5, 15 and 30 repositories in the isolated test database:
 *
 *   BENCH_ENGINES=typescript,go npm run bench:knowledge-import
 *   BENCH_DB_LATENCY_MS=20 npm run bench:knowledge-import     # every PostgreSQL packet delayed 20 ms each way
 *
 * Fixture per repository: CLAUDE.md (+ identical AGENTS.md), two convention docs, six skills with reference files and
 * a script (two of them identical in every repository), five Cursor rules; every fifth repository is a wiki with ~120
 * nested docs. Plus a user-level skills directory. Scenarios per engine and scale: cold import (empty registry),
 * unchanged re-import, and incremental re-imports with 1%, 10% and 100% of the documents modified. Measured: latency
 * p50/p95/p99, scan vs. publication time, SQL statements, bytes read (rchar), Node CPU, peak RSS, event-loop p99, the
 * latency of a concurrent pool probe, new versions and embedding queue entries; and the import reports of both engines.
 * Writes docs/architecture/knowledge-import-engines*.json.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  installBenchHarness,
  processStat,
  quantile,
  readChars,
  round,
} from "./fixtures/benchHarness.ts";

const ENGINES = (process.env.BENCH_ENGINES ?? "typescript,go").split(",") as Array<
  "typescript" | "go"
>;
const SCALES = (process.env.BENCH_SCALES ?? "1,5,15,30").split(",").map(Number);
const N = Number(process.env.BENCH_N ?? 5);
const LATENCY = Number(process.env.BENCH_DB_LATENCY_MS ?? 0);
const root = resolve(import.meta.dirname, "..");
const { db } = await installBenchHarness({ tools: ["git"], latencyMs: LATENCY });
const scratch = process.env.TEST_ROOT!;
process.env.CLAUDE_USER_SKILLS_DIR = join(scratch, "bench-user-skills");
mkdirSync(process.env.CLAUDE_USER_SKILLS_DIR, { recursive: true });

const { config } = await import("../src/config.ts");
const { migrate } = await import("../src/db/migrate.ts");
const { pool, q, one } = await import("../src/db/pool.ts");
const { repositories } = await import("../src/repos/service.ts");
const importer = await import("../src/knowledge/importer.ts");
const { startPlatformGo } = await import("./fixtures/platformGo.ts");
await migrate();
const go = ENGINES.includes("go") ? await startPlatformGo() : null;

// ---------------------------------------------------------------- fixture
const MAX = Math.max(...SCALES);
const names = Array.from({ length: MAX }, (_, i) =>
  i % 5 === 4
    ? `kb-${String(i + 1).padStart(2, "0")}-wiki`
    : `kb-${String(i + 1).padStart(2, "0")}`,
);
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "b",
  GIT_AUTHOR_EMAIL: "b@b",
  GIT_COMMITTER_NAME: "b",
  GIT_COMMITTER_EMAIL: "b@b",
};
/** Deterministic prose with some Vietnamese, code fences and lists; `n` paragraphs. */
const prose = (seed: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `${i % 4 === 0 ? `## Section ${i} of ${seed}\n\n` : ""}Paragraph ${i} of ${seed}: số tiền được lưu bằng int64 VND, ` +
      `never float. Validate the request, log with the trace id, and return a typed error.${
        i % 5 === 0
          ? `\n\n\`\`\`go\nfunc handle${i}(ctx context.Context) error { return nil }\n\`\`\``
          : ""
      }${i % 3 === 0 ? `\n\n- rule ${i}a\n- rule ${i}b` : ""}`,
  ).join("\n\n");
const skill = (name: string, owner: string) =>
  `---\nname: ${name}\ndescription: >-\n  Use when working on ${name} in ${owner};\n  covers validation and errors.\n---\n# ${name}\n\n${prose(`${name}-${owner}`, 12)}\n\nSee [the guide](references/guide.md).\n`;
const docs: string[] = []; // every generated document (absolute path), for the incremental scenarios
const write = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  docs.push(file);
};
const t0 = performance.now();
for (const [i, name] of names.entries()) {
  const dir = join(config.reposRoot, "kb-src", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (name.endsWith("-wiki")) {
    for (let d = 0; d < 120; d++)
      write(
        join(
          dir,
          "docs",
          ["architecture", "partners", "domain"][d % 3],
          `area-${d % 7}`,
          `doc-${d}.md`,
        ),
        `# ${name} document ${d}\n\n${prose(`${name}-${d}`, 10)}\n`,
      );
    write(join(dir, "docs", "CONVENTIONS.md"), `# Conventions of ${name}\n\n${prose(name, 8)}\n`);
    write(join(dir, ".inventory", "conflicts.md"), `# Conflicts\n\n${prose(`${name}-c`, 4)}\n`);
  } else {
    const claude = `# ${name}\n\nThis service handles orders for ${name}.\n\n${prose(name, 20)}\n`;
    write(join(dir, "CLAUDE.md"), claude);
    write(join(dir, "AGENTS.md"), claude);
    write(join(dir, "docs", "CONVENTIONS.md"), `# Conventions\n\n${prose(`${name}-conv`, 10)}\n`);
    write(
      join(dir, "docs", "api-conventions.md"),
      `# API conventions\n\n${prose(`${name}-api`, 8)}\n`,
    );
    for (const s of ["shared-a", "shared-b", "local-1", "local-2", "local-3", "local-4"]) {
      const owner = s.startsWith("shared") ? "all" : name;
      const base = join(dir, ".claude", "skills", s);
      write(join(base, "SKILL.md"), skill(s, owner));
      for (const r of ["guide", "errors", "testing"])
        write(
          join(base, "references", `${r}.md`),
          `# ${s} ${r}\n\n${prose(`${s}-${owner}-${r}`, 6)}\n`,
        );
      write(join(base, "scripts", "check.sh"), `#!/bin/sh\n# ${s} ${owner}\nexit 0\n`);
    }
    for (let r = 0; r < 5; r++)
      write(
        join(dir, ".cursor", "rules", `rule-${r}.mdc`),
        `---\ndescription: rule ${r} of ${name}\nglobs: "**/*.go"\nalwaysApply: ${r === 0}\n---\n# Rule ${r}\n\n${prose(`${name}-rule-${r}`, 4)}\n`,
      );
  }
  execFileSync("git", ["-C", dir, "init", "-q", "-b", config.baseBranch], { env });
  execFileSync("git", ["-C", dir, "add", "."], { env });
  execFileSync("git", ["-C", dir, "commit", "-qm", "base"], { env });
  await repositories.upsert(name, { path: `kb-src/${name}`, projects: [i < 15 ? "KB" : "KB2"] });
}
for (let s = 0; s < 5; s++)
  write(
    join(process.env.CLAUDE_USER_SKILLS_DIR, `user-${s}`, "SKILL.md"),
    skill(`user-${s}`, "user"),
  );
console.error(
  `${MAX} repositories, ${docs.length} documents written in ${round((performance.now() - t0) / 1000)}s`,
);

// ---------------------------------------------------------------- scenarios
const clearRegistry = async () => {
  await q(pool, "DELETE FROM knowledge_proposals");
  await q(pool, "DELETE FROM knowledge_items");
  await q(pool, "DELETE FROM knowledge_deletions");
  await q(pool, "DELETE FROM retrieval.queue");
};
const counts = async () => ({
  versions: Number((await one(pool, "SELECT count(*)::int AS n FROM knowledge_versions"))!.n),
  queue: Number((await one(pool, "SELECT count(*)::int AS n FROM retrieval.queue"))!.n),
});
const scaleDocs = (scale: number) =>
  docs.filter((f) => names.slice(0, scale).some((n) => f.includes(`/kb-src/${n}/`)));
let edit = 0;
const modify = (files: string[], pct: number) => {
  // Every pct% file, rotating, appended to (never the identical AGENTS.md alone: it would just split from CLAUDE.md).
  const picked = files.filter((_, i) => (i + edit) % Math.round(100 / pct) === 0);
  edit++;
  for (const f of picked) writeFileSync(f, readFileSync(f, "utf8") + `\nEdit ${edit}.\n`);
  return picked.length;
};

const measure = async (fn: () => Promise<unknown>) => {
  const probe: number[] = [];
  let probing = true;
  const prober = (async () => {
    while (probing) {
      const t = performance.now();
      await q(pool, "SELECT 1");
      probe.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 25));
    }
  })();
  const el = monitorEventLoopDelay({ resolution: 5 });
  el.enable();
  const before = await counts();
  const s0 = db.statements,
    io0 = readChars(process.pid) + (go ? readChars(go.pid!) : 0),
    c0 = process.cpuUsage(),
    g0 = go ? processStat(go.pid!).cpu : 0;
  const t = performance.now();
  const out = await fn();
  const ms = performance.now() - t;
  const statements = db.statements - s0;
  const cpu = process.cpuUsage(c0);
  const bytes = readChars(process.pid) + (go ? readChars(go.pid!) : 0) - io0;
  const goCpu = go ? processStat(go.pid!).cpu - g0 : 0;
  el.disable();
  probing = false;
  await prober;
  const after = await counts();
  return {
    out,
    ms,
    statements,
    bytes,
    node_cpu: (cpu.user + cpu.system) / 1000,
    go_cpu: goCpu,
    event_loop_p99: el.percentile(99) / 1e6,
    probe_p95: quantile(probe, 0.95) ?? 0,
    versions: after.versions - before.versions,
    // The queue is drained between runs only by clearing: count what this run left.
    embedding_jobs: after.queue,
  };
};
type M = Awaited<ReturnType<typeof measure>>;
const summarize = (ms: M[], extra: Record<string, unknown> = {}) => {
  const avg = (k: keyof M) => round(ms.reduce((a, m) => a + (m[k] as number), 0) / ms.length);
  return {
    p50_ms: round(
      quantile(
        ms.map((m) => m.ms),
        0.5,
      ),
    ),
    p95_ms: round(
      quantile(
        ms.map((m) => m.ms),
        0.95,
      ),
    ),
    p99_ms: round(
      quantile(
        ms.map((m) => m.ms),
        0.99,
      ),
    ),
    sql_statements: avg("statements"),
    bytes_read: avg("bytes"),
    node_cpu_ms: avg("node_cpu"),
    go_cpu_ms: avg("go_cpu"),
    event_loop_p99_ms: avg("event_loop_p99"),
    concurrent_probe_p95_ms: avg("probe_p95"),
    new_versions: avg("versions"),
    embedding_jobs: avg("embedding_jobs"),
    ...extra,
  };
};
/**
 * Node memory after a scenario: live heap and buffers after a full GC (what is retained), RSS, and the process's peak
 * RSS so far (maxRSS only grows, so compare it between scenarios of one run). Needs --expose-gc for the GC.
 */
const memory = () => {
  (globalThis as { gc?: () => void }).gc?.();
  const m = process.memoryUsage();
  const mb = (x: number) => round(x / 1048576);
  return {
    rss_mb: mb(m.rss),
    heap_used_mb: mb(m.heapUsed),
    heap_total_mb: mb(m.heapTotal),
    external_mb: mb(m.external),
    array_buffers_mb: mb(m.arrayBuffers),
    peak_rss_mb: round(process.resourceUsage().maxRSS / 1024),
  };
};
const report = (r: Awaited<ReturnType<typeof importer.importFromRepositories>>) => ({
  created: r.created,
  updated: r.updated,
  unchanged: r.unchanged,
  retired: r.retired,
  conflicts: r.conflicts,
  skipped: r.skipped.length,
});

const result: Record<string, unknown> = {
  generated_at: new Date().toISOString(),
  db_latency_ms_each_way: LATENCY,
  iterations: N,
  fixture: `${docs.length} documents in ${MAX} repositories (every fifth a wiki) + 5 user skills`,
  runs: {} as Record<string, Record<string, Record<string, unknown>>>,
};
const runs = result.runs as Record<string, Record<string, Record<string, unknown>>>;
const reports: Record<string, unknown[]> = {};
const restore = () => {
  for (const name of names) {
    const dir = join(config.reposRoot, "kb-src", name);
    execFileSync("git", ["-C", dir, "checkout", "-q", "--", "."], { env });
  }
};
for (const engine of ENGINES) {
  config.knowledge.importEngine = engine;
  runs[engine] = {};
  reports[engine] = [];
  for (const scale of SCALES) {
    restore();
    for (const [i, name] of names.entries())
      await repositories.upsert(name, { enabled: i < scale });
    const files = scaleDocs(scale);
    const out: Record<string, unknown> = {};
    // Scan alone (no database writes), to split the cost.
    const scan: M[] = [];
    for (let i = 0; i < N; i++) scan.push(await measure(() => importer.scanRepositories()));
    out.scan_only = summarize(scan, { memory: memory() });
    const cold: M[] = [];
    for (let i = 0; i < Math.max(2, Math.ceil(N / 2)); i++) {
      await clearRegistry();
      cold.push(await measure(() => importer.importFromRepositories()));
    }
    out.cold = summarize(cold, { report: report(cold[0].out as never), memory: memory() });
    reports[engine].push(report(cold[0].out as never));
    await q(pool, "DELETE FROM retrieval.queue");
    const unchanged: M[] = [];
    for (let i = 0; i < N; i++) {
      unchanged.push(await measure(() => importer.importFromRepositories()));
      await q(pool, "DELETE FROM retrieval.queue");
    }
    out.unchanged = summarize(unchanged, {
      report: report(unchanged[0].out as never),
      memory: memory(),
    });
    reports[engine].push(report(unchanged[0].out as never));
    for (const pct of [1, 10, 100]) {
      const ms: M[] = [];
      let modified: number;
      let total = 0;
      for (let i = 0; i < N; i++) {
        modified = modify(files, pct);
        total += modified;
        ms.push(await measure(() => importer.importFromRepositories()));
        await q(pool, "DELETE FROM retrieval.queue");
      }
      out[`modified_${pct}pct`] = summarize(ms, {
        modified_files: round(total / N),
        report: report(ms[0].out as never),
        memory: memory(),
      });
    }
    out.documents = files.length;
    out.node_peak_rss_mb = round(process.resourceUsage().maxRSS / 1024);
    runs[engine][scale] = out;
    console.error(engine.padEnd(10), String(scale).padStart(2), JSON.stringify(out));
  }
  restore();
}
// Both engines on the same files and registry state: the same reports and the same registry (checked by the parity
// test in detail; here the per-scenario counts).
if (ENGINES.length > 1) {
  result.identical_reports = isDeepStrictEqual(reports[ENGINES[0]], reports[ENGINES[1]]);
  result.p50_improvement_pct = Object.fromEntries(
    SCALES.map((scale) => [
      scale,
      Object.fromEntries(
        Object.keys(runs[ENGINES[0]][scale])
          .filter((k) => typeof runs[ENGINES[0]][scale][k] === "object")
          .map((k) => {
            const a = runs[ENGINES[0]][scale][k] as { p50_ms: number };
            const b = runs[ENGINES[1]][scale][k] as { p50_ms: number };
            return [k, round((100 * (a.p50_ms - b.p50_ms)) / a.p50_ms)];
          }),
      ),
    ]),
  );
}
if (go) result.platform_go = processStat(go.pid!);
const file = join(
  root,
  `docs/architecture/knowledge-import-engines${LATENCY ? `-latency${LATENCY}` : ""}${ENGINES.length === 1 ? `-${ENGINES[0]}` : ""}.json`,
);
writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
console.error(`wrote ${file}`);
go?.stop();
await pool.end();
spawnSync("true");
process.exit(0);
