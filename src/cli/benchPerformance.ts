/** Paired platform-component baselines; uses existing scheduler/context functions, never a live provider. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { cpus, arch, platform, release } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "../eval/dataset.ts";
import {
  measureQueries,
  pairedSummary,
  platformPerformanceFixtures,
  type PerformanceSample,
} from "../eval/performance.ts";
import type { ContextPack } from "../context/pack.ts";

const args = Object.fromEntries(process.argv.slice(2).map((s) => s.replace(/^--/, "").split("=")));
// Only the existing test-owned preload can authorize this measurement process. Never accept an admin URL.
const database = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
if (
  process.env.PLATFORM_TEST !== "1" ||
  !/^platform_test_[a-f0-9]+$/.test(database.pathname.slice(1)) ||
  !database.searchParams.get("host")?.startsWith("/")
)
  throw new Error("Run this suite with --import ./test/setup.ts and test-owned PostgreSQL");
if (!args["baseline-ref"] || !args.output)
  throw new Error("--baseline-ref and --output are required");
if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(args["baseline-ref"]))
  throw new Error("Invalid baseline ref");
const repetitions = Number(args.repetitions ?? 5);
if (!Number.isInteger(repetitions) || repetitions < 5 || repetitions > 30)
  throw new Error("Repetitions must be 5–30");
const git = (root: string, ...argv: string[]) =>
  execFileSync("git", ["-C", root, ...argv], { encoding: "utf8" }).trim();
const files = [
  "src/workflow/scheduler.ts",
  "src/context/plan.ts",
  "src/context/pack.ts",
  "src/agent/metrics.ts",
  "src/db/pool.ts",
];
async function subject(root: string, revision?: string) {
  root = resolve(root);
  if (!revision && git(root, "diff", "HEAD", "--", ...files))
    throw new Error("Benchmark subject modules must be committed");
  const load = (path: string) => import(pathToFileURL(join(root, path)).href);
  const scheduler = (await load(
    "src/workflow/scheduler.ts",
  )) as typeof import("../workflow/scheduler.ts");
  const context = (await load("src/context/plan.ts")) as typeof import("../context/plan.ts");
  const packs = (await load("src/context/pack.ts")) as typeof import("../context/pack.ts");
  const metrics = (await load("src/agent/metrics.ts")) as typeof import("../agent/metrics.ts");
  const { pool } = (await load("src/db/pool.ts")) as typeof import("../db/pool.ts");
  const identity = {
    revision: revision ?? git(root, "rev-parse", "HEAD"),
    tree: git(process.cwd(), "rev-parse", `${revision ?? "HEAD"}^{tree}`),
    modules: Object.fromEntries(
      files.map((file) => [file, sha256(readFileSync(join(root, file), "utf8"))]),
    ),
  };
  return { scheduler, context, packs, metrics, pool, identity };
}
type Subject = Awaited<ReturnType<typeof subject>>;
async function sample(
  s: Subject,
  fixture: (typeof platformPerformanceFixtures)[number],
  temperature: string,
  repetition: number,
) {
  const knowledge = Array.from({ length: fixture.knowledge_items }, (_, i) => ({
    key: `fixture.rule.${i}`,
    title: `Workflow rule ${i}`,
    category: "repository_convention",
    content: "Preserve workflow ownership, recovery, transactions and input scope. ".repeat(8),
    reason: "REPOSITORY fixture",
  }));
  const entries = Array.from({ length: fixture.context_entries }, (_, i) => ({
    id: `fixture-${i}`,
    section: "requirements" as const,
    trust: "untrusted_evidence" as const,
    required: i === 0,
    priority: i,
    body: "Fixture workflow requirement with bounded evidence. ".repeat(16),
    provenance: {
      source_id: `fixture-${i}`,
      version: "1",
      timestamp: null,
      visibility: "owner",
      relevance: "synthetic fixture",
      state: "snapshot",
    },
  }));
  const pack = {
    version: 1,
    run_id: 1,
    step_id: 1,
    attempt_id: 1,
    owner_id: 1,
    snapshot_id: 1,
    created_at: "2026-01-01T00:00:00Z",
    budget_tokens: 20000,
    estimated_tokens: 0,
    token_measurement: "character_estimate_not_provider_usage",
    entries,
    omitted: [],
    parent_pack_ids: [],
    retrieval_calls: 0,
    retrieval_failures: 0,
    preparation_ms: 0,
  } as ContextPack;
  const phases: Record<string, number> = {};
  function phase<T>(name: string, action: () => T): T {
    const start = performance.now();
    try {
      return action();
    } finally {
      phases[name] = performance.now() - start;
    }
  }
  const start = performance.now();
  // This suite is serial and owns these pools. All measured idle-claim SQL uses pool.query promises;
  // client-level transaction statements are outside this workload and are not claimed as counted.
  const observed = await measureQueries(
    s.pool as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    async () => {
      const planned = phase("knowledge_planning_ms", () =>
        s.context.planKnowledge(knowledge, {
          requestText: "workflow ownership recovery",
          stepType: "coding_agent",
          inlineTokens: 8000,
          indexSize: 20,
        }),
      );
      const rendered = phase("context_render_ms", () => s.packs.renderContextPack(pack, false));
      const serialized = phase("serialization_ms", () => JSON.stringify({ planned, rendered }));
      const estimated = phase("token_estimation_ms", () => s.context.estimateTokens(serialized));
      const metrics = s.metrics.newMetrics("fixture-no-provider");
      phase("tool_accounting_ms", () => {
        for (let i = 0; i < fixture.context_entries; i++)
          s.metrics.noteToolUse(metrics, "Read", { file_path: `fixture/file-${i % 4}.ts` }, i);
      });
      const claimStart = performance.now();
      for (let i = 0; i < fixture.idle_claims; i++) {
        if (await s.scheduler.claimJob("performance-fixture", 30))
          throw new Error("Expected empty test-owned job queue");
      }
      phases.scheduler_idle_claim_ms = performance.now() - claimStart;
      return {
        output_hash: sha256(serialized + JSON.stringify(metrics.tool_repeats)),
        estimated_serialized_tokens: estimated,
        token_measurement: "character_estimate_not_provider_usage",
        tool_repeats: metrics.tool_repeats,
      };
    },
  );
  return {
    fixture: fixture.id,
    temperature,
    repetition,
    wall_ms: performance.now() - start,
    ...observed.value,
    phases,
    pool_query_calls: observed.query_calls,
    pool_query_failures: observed.query_failures,
    pool_query_elapsed_ms: observed.query_elapsed_ms,
    pool_wait_ms: null,
    provider_latency_ms: null,
    provider_input_tokens: null,
    provider_output_tokens: null,
    provider_cache_read_tokens: null,
    provider_cache_creation_tokens: null,
    provider_cost_usd: null,
    retries: 0,
    canceled_work_ms: null,
  };
}

const baselineRevision = git(
  process.cwd(),
  "rev-parse",
  "--verify",
  `${args["baseline-ref"]}^{commit}`,
);
// Export only committed source files into the authorized worktree: no .git, config or credential files.
const snapshot = mkdtempSync(join(process.cwd(), ".performance-baseline-"));
let baseline: Subject | undefined, candidate: Subject | undefined;
const before: Awaited<ReturnType<typeof sample>>[] = [],
  after: typeof before = [];
try {
  execFileSync("tar", ["-x", "-C", snapshot], {
    input: execFileSync("git", ["archive", baselineRevision, "src", "migrations", "package.json"], {
      maxBuffer: 32 * 1024 * 1024,
    }),
  });
  baseline = await subject(snapshot, baselineRevision);
  candidate = await subject(process.cwd());
  for (const fixture of platformPerformanceFixtures) {
    // Cold = first measured use for this fixture; pools/modules may already be warm for later sizes.
    before.push(await sample(baseline, fixture, "first_use", 0));
    after.push(await sample(candidate, fixture, "first_use", 0));
    for (let i = 0; i < 3; i++) {
      await sample(baseline, fixture, "warmup", i);
      await sample(candidate, fixture, "warmup", i);
    }
    for (let i = 0; i < repetitions; i++) {
      // Alternate order to reduce systematic first-run bias; pairing never drops a slow sample.
      if (i % 2) {
        after.push(await sample(candidate, fixture, "warm", i));
        before.push(await sample(baseline, fixture, "warm", i));
      } else {
        before.push(await sample(baseline, fixture, "warm", i));
        after.push(await sample(candidate, fixture, "warm", i));
      }
    }
  }
  const postgresVersion = (await candidate.pool.query("SHOW server_version")).rows[0]
    .server_version as string;
  const report = {
    suite: "platform-performance-v1",
    evidence_kind: "component_fixture_control",
    fixture_version: 1,
    conditions: {
      node: process.version,
      os: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logical_cpus: cpus().length,
      concurrency: 1,
      repetitions,
      warmups: 3,
      database: "test-owned PostgreSQL Unix socket",
      postgres_version: postgresVersion,
      pool_max: candidate.pool.options.max,
      pool_min: candidate.pool.options.min,
      lockfile_hash: sha256(readFileSync("package-lock.json", "utf8")),
      dependency_policy:
        "Both source subjects use the candidate's installed dependencies and lockfile; dependency upgrades are not compared.",
      test_preload_hash: sha256(readFileSync("test/setup.ts", "utf8")),
      fixture_hash: sha256(JSON.stringify(platformPerformanceFixtures)),
      harness_hash: sha256(
        readFileSync(new URL(import.meta.url), "utf8") +
          readFileSync(new URL("../eval/performance.ts", import.meta.url), "utf8"),
      ),
    },
    fixtures: platformPerformanceFixtures,
    baseline: baseline.identity,
    candidate: candidate.identity,
    samples: { baseline: before, candidate: after },
    paired: pairedSummary(before satisfies PerformanceSample[], after),
    limits: [
      "Component workload sizes, not completed engineering tasks or live-provider speed.",
      "No performance optimization is selected or speedup claimed by this baseline report.",
      "First-use samples include pool warm-up only for the first fixture; warm samples follow three warm-ups.",
      "Input generation, source loading, snapshot extraction and database startup are outside the measured wall time.",
      "Pool query elapsed time includes acquisition; separate pool wait and client transaction queries are not measured.",
      "No active jobs, handoffs, retries, cancellations or provider requests; unavailable metrics remain null.",
      "Baseline is a source-only snapshot of the pinned local ref; remote main freshness is not asserted.",
    ],
  };
  writeFileSync(resolve(args.output), JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      output: resolve(args.output),
      baseline: baseline.identity.revision,
      candidate: candidate.identity.revision,
      pairs: before.length,
    }),
  );
} finally {
  await baseline?.pool.end();
  if (candidate && candidate.pool !== baseline?.pool) await candidate.pool.end();
  rmSync(snapshot, { recursive: true, force: true });
}
