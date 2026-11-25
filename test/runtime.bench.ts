/**
 * End-to-end runtime benchmark on the isolated test database, with stub providers and executors (no live model):
 *
 *   npm run bench:runtime                       # BENCH_N=10 turns/runs per scenario
 *   BENCH_DB_LATENCY_MS=20 npm run bench:runtime
 *
 * Scenarios, each measured alone and again while a background load runs (a knowledge import of 5 repositories and
 * code searches over 3 checkouts of this platform's src/, in a loop):
 *   chat_turn          one ASK turn whose provider streams 30 text updates over ~450 ms: time to the first visible
 *                      response delta (chat_events row), time to completion
 *   chat_concurrent    8 conversations at once, same provider
 *   workflow_run       a 12-step run of stub agent steps (10 ms each): start → COMPLETED, scheduler overhead per step
 *   checkpoint_replay  re-execute the root of that run (context-only replay of 12 descendants) → COMPLETED
 *   workflow_concurrent_8 / _16  that many runs started together under the production loops (4 + 1 workers)
 *   chat_concurrent_16 16 conversations at once
 *   workflow_scheduled the same run executed by the production scheduler loops (2 workers + 1 light worker, 1 s idle
 *                      poll) instead of drain(): adds the queue wait between a job becoming runnable and its claim
 * Measured per scenario: p50/p95/p99 latency, SQL statements, Node CPU, event-loop delay p99/max, peak RSS, and the
 * host's PSI (cpu/memory/io "some" stall time during the scenario). Writes docs/architecture/runtime-e2e*.json.
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { installBenchHarness, quantile, round } from "./fixtures/benchHarness.ts";
import { config as appConfig } from "../src/config.ts";

const N = Number(process.env.BENCH_N ?? 10);
const LATENCY = Number(process.env.BENCH_DB_LATENCY_MS ?? 0);
const root = resolve(import.meta.dirname, "..");
const { db, directUrl } = await installBenchHarness({ tools: ["git", "rg"], latencyMs: LATENCY });
// The observer polls turn state every 5 ms on its own connection, outside the counting proxy: before, its ~80 polls per
// turn were counted as platform statements (the "156 statements per turn" of the hardening review).
const observer = new (await import("pg")).default.Pool({ connectionString: directUrl, max: 16 });

const { config } = await import("../src/config.ts");
const { migrate } = await import("../src/db/migrate.ts");
const { pool, q } = await import("../src/db/pool.ts");
const { createUser } = await import("../src/auth/users.ts");
const { chat } = await import("../src/chat/service.ts");
const { setChatProviders } = await import("../src/chat/runtime.ts");
const admission = await import("../src/chat/admission.ts");
const { setChatHealthProbe } = admission;
const titles = await import("../src/chat/title.ts");
const { setChatTitleComplete } = titles;
const { definitions } = await import("../src/workflow/definitions.ts");
const { startRun, getRun, reexecuteStep } = await import("../src/workflow/engine.ts");
const { drain, startScheduler } = await import("../src/workflow/scheduler.ts");
const { registerExecutor } = await import("../src/workflow/executors/registry.ts");
const { conditionExecutor } = await import("../src/workflow/executors/builtin.ts");
const { settleBackground } = await import("../src/workflow/background.ts");
const { repositories } = await import("../src/repos/service.ts");
const { importFromRepositories } = await import("../src/knowledge/importer.ts");
const search = await import("../src/codeIntelligence/search.ts");
const { shareAllRepositoriesForTests } = await import("./fixtures/repositoryAccess.ts");
await migrate();
await shareAllRepositoriesForTests();

// ---------------------------------------------------------------- stubs
const PROVIDERS = ["claude", "cursor", "codex", "antigravity", "copilot"] as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const allHealthy = () =>
  PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const }));
const instantHealth = async () => allHealthy();
/**
 * What a production health probe costs (`claude auth status --json`, the one readiness check without a cache: ~0.3 s,
 * ~150 MiB per process), reported healthy so the stub providers run. Installed as the prober when the platform has one
 * (so its caching applies), else as the whole health seam (the code before the change probed on every admission).
 */
const run = promisify(execFile);
let probes = 0;
const spawnedHealth = async () => {
  probes++;
  await run("claude", ["auth", "status", "--json"], { timeout: 15_000 }).catch(() => {});
  return allHealthy();
};
let currentHealth: typeof instantHealth | null = null;
const useHealth = (fn: typeof instantHealth) => {
  if (currentHealth === fn) return; // keep the shared reading (and its reuse) across iterations
  currentHealth = fn;
  const prober = (admission as { setChatHealthProber?: (f: typeof fn | undefined) => void })
    .setChatHealthProber;
  if (prober) {
    setChatHealthProbe(undefined);
    prober(fn);
  } else setChatHealthProbe(fn);
};
useHealth(instantHealth);
/** Workflow scenarios: the real readiness checks (CLI status commands, no model call), counted per shared probe. */
const { probeAgentHealth } = await import("../src/agent/health.ts");
const realHealth = async () => {
  probes++;
  return (await probeAgentHealth()) as ReturnType<typeof allHealthy>;
};
const withRealHealth =
  <T>(fn: () => Promise<T>) =>
  async () => {
    useHealth(realHealth);
    return fn();
  };
const withInstantHealth =
  <T>(fn: () => Promise<T>) =>
  async () => {
    useHealth(instantHealth);
    return fn();
  };
const streamer = async (_p: string, opts: { onStream?: (e: unknown) => void }) => {
  opts.onStream?.({ type: "started" });
  let text = "";
  for (let i = 0; i < 30; i++) {
    opts.onStream?.({ type: "text", text: (text += `từ ${i} `) });
    await sleep(15);
  }
  return { text, model: "stub", tokens: { input: 100, output: 60 }, cost_usd: null };
};
setChatProviders(Object.fromEntries(PROVIDERS.map((p) => [p, streamer])) as never);
// Title generation has its own completion seam: without it every new conversation would start the real Claude SDK.
const stubTitle = async () => "Benchmark conversation";
setChatTitleComplete(stubTitle);
/**
 * What one real title costs, without calling a model: the Claude CLI process starts (`claude auth status`, the CPU and
 * memory of a CLI start) and the answer takes as long as a measured real title (3.3–4.4 s wall, 2026-11-21).
 * BENCH_REAL_TITLES=1 uses the real SDK instead — the tests run with the real HOME, so that calls the model with the
 * configured Claude account and spends its usage.
 */
const TITLE_WALL_MS = 3500;
const modeledTitle = async () => {
  const t0 = Date.now();
  await run("claude", ["auth", "status", "--json"], { timeout: 15_000 }).catch(() => {});
  await sleep(Math.max(0, TITLE_WALL_MS - (Date.now() - t0)));
  return "Benchmark title";
};
registerExecutor("condition", conditionExecutor);
registerExecutor("agent", {
  async execute(ctx) {
    await sleep(10);
    return { kind: "completed", output: { summary: ctx.step.key } };
  },
});
const STEPS = 12;
await definitions.create({
  key: "runtime-bench",
  spec: {
    name: "Runtime benchmark",
    steps: [
      { key: "root", type: "condition", config: { path: "inputs.enabled", equals: true } },
      ...Array.from({ length: STEPS }, (_, i) => ({
        key: `step-${i}`,
        type: "agent",
        depends_on: [i === 0 ? "root" : `step-${i - 1}`],
        config: {
          replay: "context_only",
          agent: { provider: "claude", allowed_tools: ["platform.submit_result"] },
        },
      })),
    ],
  },
});
const user = await createUser({
  username: `bench-${Date.now()}`,
  password: "bench-password-1",
  role: "member",
});
const actor = {
  id: user.id,
  username: user.username,
  role: user.role,
  active: user.active,
} as never;

// ---------------------------------------------------------------- background load fixture
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "b",
  GIT_AUTHOR_EMAIL: "b@b",
  GIT_COMMITTER_NAME: "b",
  GIT_COMMITTER_EMAIL: "b@b",
};
const loadRepos = Array.from({ length: 5 }, (_, i) => `rt-load-${i}`);
for (const [i, name] of loadRepos.entries()) {
  const dir = join(config.reposRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  if (i < 3) cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), `# ${name}\n\nRules.\n`);
  for (let d = 0; d < 40; d++)
    writeFileSync(join(dir, "docs", `d${d}-convention.md`), `# D${d}\n\n${"Text. ".repeat(200)}\n`);
  execFileSync("git", ["-C", dir, "init", "-q", "-b", config.baseBranch], { env });
  execFileSync("git", ["-C", dir, "add", "."], { env });
  execFileSync("git", ["-C", dir, "commit", "-qm", "base"], { env });
  await repositories.upsert(name, { projects: ["RT"] });
}
config.codeIntelligence.enabled = true;
const searchScope = {
  repositories: loadRepos.slice(0, 3),
  allowed: loadRepos.slice(0, 3),
  provision: false,
};
let loading = false;
let loadOps = 0;
const backgroundLoad = async () => {
  while (loading) {
    await importFromRepositories();
    await search.searchCodeExact("export function", searchScope, 20, { anyFile: true });
    await search.searchSymbols("searchSymbols fresh importer", searchScope, 30);
    if (process.env.BENCH_LOAD_WORKFLOW) {
      // Workflow load as well (chat-only scenario sets: no other drain runs at the same time).
      await startRun({ definitionKey: "runtime-bench", inputs: { enabled: true } });
      await drain();
    }
    loadOps++;
  }
};

// ---------------------------------------------------------------- measurement
const psi = () => {
  const read = (r: string) => {
    try {
      return Number(
        /some .*total=(\d+)/.exec(readFileSync(`/proc/pressure/${r}`, "utf8"))?.[1] ?? 0,
      );
    } catch {
      return 0;
    }
  };
  return { cpu: read("cpu"), memory: read("memory"), io: read("io") };
};
async function scenario(name: string, n: number, one: () => Promise<Record<string, number>>) {
  const el = monitorEventLoopDelay({ resolution: 5 });
  let peakRss = 0;
  const rss = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 50);
  el.enable();
  let waitSamples = 0,
    waitSum = 0,
    waitMax = 0;
  const waiting = setInterval(() => {
    waitSamples++;
    waitSum += pool.waitingCount;
    waitMax = Math.max(waitMax, pool.waitingCount);
  }, 5);
  const texts0 = new Map(db.byText);
  const probes0 = probes;
  const p0 = psi(),
    s0 = db.statements,
    c0 = process.cpuUsage(),
    t0 = performance.now();
  const samples: Array<Record<string, number>> = [];
  for (let i = 0; i < n; i++) samples.push(await one());
  if (process.env.BENCH_VERBOSE)
    console.error(name, JSON.stringify(samples.map((x) => Object.values(x).map(round))));
  const wall = performance.now() - t0;
  const cpu = process.cpuUsage(c0),
    p1 = psi();
  el.disable();
  clearInterval(rss);
  clearInterval(waiting);
  if (process.env.BENCH_SQL_TOP) {
    const diff = [...db.byText]
      .map(([k, v]) => [k, (v - (texts0.get(k) ?? 0)) / n] as const)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Number(process.env.BENCH_SQL_TOP));
    for (const [k, v] of diff) console.error(`  ${String(round(v)).padStart(6)}  ${k}`);
  }
  const stat = (k: string) => {
    const xs = samples.map((s) => s[k]).filter((x) => x !== undefined);
    return {
      p50: round(quantile(xs, 0.5)),
      p95: round(quantile(xs, 0.95)),
      p99: round(quantile(xs, 0.99)),
    };
  };
  const out = {
    ...Object.fromEntries(Object.keys(samples[0]).map((k) => [k, stat(k)])),
    // The first iteration of a scenario in this process (cold caches: provider readiness CLIs, plans, JIT).
    first_sample: Object.fromEntries(Object.entries(samples[0]).map(([k, v]) => [k, round(v)])),
    sql_statements_per_op: round((db.statements - s0) / n),
    pool_waiting_avg: round(waitSum / Math.max(1, waitSamples)),
    pool_waiting_max: waitMax,
    health_probes_per_op: round((probes - probes0) / n),
    node_cpu_ms_per_op: round((cpu.user + cpu.system) / 1000 / n),
    event_loop_p95_ms: round(el.percentile(95) / 1e6),
    event_loop_p99_ms: round(el.percentile(99) / 1e6),
    event_loop_max_ms: round(el.max / 1e6),
    peak_rss_mb: round(peakRss / 1048576),
    psi_stall_ms: {
      cpu: round((p1.cpu - p0.cpu) / 1000),
      memory: round((p1.memory - p0.memory) / 1000),
      io: round((p1.io - p0.io) / 1000),
    },
    wall_s: round(wall / 1000),
  };
  console.error(name.padEnd(28), JSON.stringify(out));
  return out;
}

/** One chat turn: first visible delta and completion, observed by polling on a separate connection. */
const turn = async (conversation: number, tag: string) => {
  const t0 = performance.now();
  const msg = await chat.postMessage(actor, conversation, {
    content: "hỏi",
    client_message_id: tag,
  });
  let first = NaN;
  for (;;) {
    const rows = await q<{ kind: string; status: string | null }>(
      observer as never,
      `SELECT (SELECT kind FROM chat_events WHERE turn_id = $1 AND kind = 'response.delta' LIMIT 1) AS kind,
              (SELECT status FROM chat_turns WHERE id = $1) AS status`,
      [msg.turn.id],
    );
    if (Number.isNaN(first) && rows[0].kind) first = performance.now() - t0;
    if (["completed", "failed", "canceled"].includes(rows[0].status ?? "")) {
      if (rows[0].status !== "completed") throw new Error(`turn ${rows[0].status}`);
      return { first_delta_ms: first, turn_ms: performance.now() - t0 };
    }
    await sleep(5);
  }
};
let seq = 0;
/** n conversations each answering one turn at once: the last first delta and completion. */
const concurrentTurns = async (n: number) => {
  const cs = await Promise.all(
    Array.from({ length: n }, () => chat.create(actor, { mode: "ASK", provider: "claude" })),
  );
  const t0 = performance.now();
  const r = await Promise.all(cs.map((c) => turn(c.id, `runtime-bench-${seq++}`)));
  return {
    first_delta_ms: Math.max(...r.map((x) => x.first_delta_ms)),
    turn_ms: Math.max(...r.map((x) => x.turn_ms)),
    all_ms: performance.now() - t0,
  };
};
const scenarios = {
  chat_turn: withInstantHealth(async () => {
    const c = await chat.create(actor, { mode: "ASK", provider: "claude" });
    return turn(c.id, `runtime-bench-${seq++}`);
  }),
  chat_concurrent: withInstantHealth(() => concurrentTurns(8)),
  chat_concurrent_16: withInstantHealth(() => concurrentTurns(16)),
  /**
   * 8 new conversations at once, production-like: every admission pays a real readiness probe and every first message
   * schedules a title that costs what a real one does (see modeledTitle). Also measured: when every title has settled.
   */
  chat_new_titles: async () => {
    // Titles still queued by earlier scenarios (stub titles that yield to their running turns) would otherwise run
    // with the modeled cost below and be counted here.
    while (titleBusy()) await sleep(10);
    useHealth(spawnedHealth);
    if (process.env.BENCH_REAL_TITLES) appConfig.chat.titleRealInTests = "1";
    setChatTitleComplete(process.env.BENCH_REAL_TITLES ? undefined : modeledTitle);
    try {
      const cs = await Promise.all(
        Array.from({ length: 8 }, () => chat.create(actor, { mode: "ASK", provider: "claude" })),
      );
      const t0 = performance.now();
      const r = await Promise.all(cs.map((c) => turn(c.id, `runtime-bench-${seq++}`)));
      const turnsDone = performance.now() - t0;
      while (titleBusy()) await sleep(10);
      const firsts = r.map((x) => x.first_delta_ms);
      return {
        first_delta_ms: Math.max(...firsts),
        first_delta_median_ms: quantile(firsts, 0.5),
        turn_ms: Math.max(...r.map((x) => x.turn_ms)),
        all_ms: turnsDone,
        titles_settled_ms: performance.now() - t0,
      };
    } finally {
      useHealth(instantHealth);
      setChatTitleComplete(stubTitle);
    }
  },
  workflow_run: withRealHealth(async () => {
    const t0 = performance.now();
    const run = await startRun({ definitionKey: "runtime-bench", inputs: { enabled: true } });
    await drain();
    if ((await settled(run.id)) !== "COMPLETED") throw new Error("run did not complete");
    const ms = performance.now() - t0;
    lastRun = run.id;
    return { run_ms: ms, overhead_per_step_ms: (ms - STEPS * 10) / STEPS };
  }),
  checkpoint_replay: withRealHealth(async () => {
    const t0 = performance.now();
    await reexecuteStep(lastRun, "root");
    await drain();
    if ((await settled(lastRun)) !== "COMPLETED") throw new Error("replay did not complete");
    return { replay_ms: performance.now() - t0 };
  }),
  workflow_concurrent_8: withRealHealth(() => concurrentRuns(8)),
  workflow_concurrent_16: withRealHealth(() => concurrentRuns(16)),
  workflow_scheduled: withRealHealth(async () => {
    scheduler ??= startScheduler({
      workers: 2,
      lightWorkers: 1,
      leaseSeconds: 120,
      heartbeatSeconds: 10,
      pollMs: 1000,
    });
    // Idle between runs, as a production instance would be: the workers are asleep when the run arrives.
    await sleep(1200);
    const t0 = performance.now();
    const run = await startRun({ definitionKey: "runtime-bench", inputs: { enabled: true } });
    for (;;) {
      const [r] = await q<{ status: string }>(
        observer as never,
        "SELECT status FROM workflow_runs WHERE id = $1",
        [run.id],
      );
      if (["COMPLETED", "FAILED", "CANCELED"].includes(r.status)) {
        if (r.status !== "COMPLETED") throw new Error(`run ${r.status}`);
        break;
      }
      await sleep(5);
    }
    const ms = performance.now() - t0;
    const [w] = await q<{ total: number; max: number }>(
      observer as never,
      "SELECT sum(telemetry_queue_duration_ms)::float AS total, max(telemetry_queue_duration_ms)::float AS max FROM workflow_step_attempts WHERE run_id = $1",
      [run.id],
    );
    return { run_ms: ms, queue_wait_total_ms: w.total, queue_wait_max_ms: w.max };
  }),
};
let scheduler: ReturnType<typeof startScheduler> | null = null;
/**
 * drain() returns when it finds no claimable job; under BENCH_LOAD_WORKFLOW the background loop's own drain() may still
 * hold one of this run's jobs. Wait for the run to settle instead of reading its status at once (that race aborted the
 * before-run of checkpoint_replay under load).
 */
async function settled(runId: number) {
  for (;;) {
    const status = (await getRun(runId)).status;
    if (["COMPLETED", "FAILED", "CANCELED"].includes(status)) return status;
    await drain();
    await sleep(5);
  }
}
/** Scheduler empty claims, when the platform counts them (src/runtimeMetrics.ts; absent before Phase 4D). */
const runtimeMetrics = await import("../src/runtimeMetrics.ts").catch(() => null);
const emptyClaims = () =>
  (runtimeMetrics?.runtimeMetricsSnapshot().counters["scheduler.claims_empty"] as
    number | undefined) ?? NaN;
/** n 12-step runs started together under the production loops (4 workers + 1 light worker, 1 s idle poll). */
async function concurrentRuns(n: number) {
  scheduler ??= startScheduler({
    workers: 4,
    lightWorkers: 1,
    leaseSeconds: 120,
    heartbeatSeconds: 10,
    pollMs: 1000,
  });
  await sleep(1200);
  const e0 = emptyClaims();
  const t0 = performance.now();
  const runs = await Promise.all(
    Array.from({ length: n }, () =>
      startRun({ definitionKey: "runtime-bench", inputs: { enabled: true } }),
    ),
  );
  const done = new Map<number, number>();
  while (done.size < n) {
    const rows = await q<{ id: number; status: string }>(
      observer as never,
      "SELECT id, status FROM workflow_runs WHERE id = ANY($1::bigint[])",
      [runs.map((r) => r.id)],
    );
    for (const r of rows) {
      if (["FAILED", "CANCELED"].includes(r.status)) throw new Error(`run ${r.status}`);
      if (r.status === "COMPLETED" && !done.has(r.id)) done.set(r.id, performance.now() - t0);
    }
    await sleep(10);
  }
  const [w] = await q<{ max: number; avg: number }>(
    observer as never,
    "SELECT max(telemetry_queue_duration_ms)::float AS max, avg(telemetry_queue_duration_ms)::float AS avg FROM workflow_step_attempts WHERE run_id = ANY($1::bigint[])",
    [runs.map((r) => r.id)],
  );
  const each = [...done.values()];
  return {
    all_ms: Math.max(...each),
    run_median_ms: quantile(each, 0.5),
    queue_wait_avg_ms: w.avg,
    queue_wait_max_ms: w.max,
    empty_claims: emptyClaims() - e0,
  };
}
let lastRun = 0;
const titleBusy = () =>
  (titles as { titleBacklog?: () => number }).titleBacklog?.() ??
  (titles as unknown as { _titlingBusy: () => number })._titlingBusy();

const result: Record<string, unknown> = {
  generated_at: new Date().toISOString(),
  db_latency_ms_each_way: LATENCY,
  iterations: N,
  load:
    "knowledge import of 5 repositories + exact and symbol code search over 3 checkouts of src/" +
    (process.env.BENCH_LOAD_WORKFLOW ? " + a 12-step workflow run" : "") +
    ", in a loop",
  alone: {} as Record<string, unknown>,
  under_load: {} as Record<string, unknown>,
};
const only = process.env.BENCH_SCENARIOS?.split(",");
const selected = Object.entries(scenarios).filter(([n]) => !only || only.includes(n));
const stopScheduler = async () => {
  await scheduler?.stop();
  scheduler = null;
};
for (const [name, fn] of selected) {
  (result.alone as Record<string, unknown>)[name] = await scenario(name, N, fn);
  await stopScheduler();
}
loading = true;
const load = backgroundLoad();
await sleep(500);
for (const [name, fn] of process.env.BENCH_SKIP_LOAD ? [] : selected) {
  (result.under_load as Record<string, unknown>)[name] = await scenario(`${name} (load)`, N, fn);
  await stopScheduler();
}
loading = false;
await load;
result.background_load_cycles = loadOps;
const file = resolve(
  root,
  process.env.BENCH_OUT ??
    `docs/architecture/runtime-e2e${LATENCY ? `-latency${LATENCY}` : ""}.json`,
);
writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
console.error(`wrote ${file}`);
setChatProviders(undefined);
setChatHealthProbe(undefined);
setChatTitleComplete(undefined);
await settleBackground();
await observer.end();
await pool.end();
spawnSync("true");
process.exit(0);
