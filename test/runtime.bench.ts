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
 * Measured per scenario: p50/p95/p99 latency, SQL statements, Node CPU, event-loop delay p99/max, peak RSS, and the
 * host's PSI (cpu/memory/io "some" stall time during the scenario). Writes docs/architecture/runtime-e2e*.json.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { installBenchHarness, quantile, round } from "./fixtures/benchHarness.ts";

const N = Number(process.env.BENCH_N ?? 10);
const LATENCY = Number(process.env.BENCH_DB_LATENCY_MS ?? 0);
const root = resolve(import.meta.dirname, "..");
const { db } = await installBenchHarness({ tools: ["git", "rg"], latencyMs: LATENCY });

const { config } = await import("../src/config.ts");
const { migrate } = await import("../src/db/migrate.ts");
const { pool, q } = await import("../src/db/pool.ts");
const { createUser } = await import("../src/auth/users.ts");
const { chat } = await import("../src/chat/service.ts");
const { setChatProviders } = await import("../src/chat/runtime.ts");
const { setChatHealthProbe } = await import("../src/chat/admission.ts");
const { setChatTitleComplete } = await import("../src/chat/title.ts");
const { definitions } = await import("../src/workflow/definitions.ts");
const { startRun, getRun, reexecuteStep } = await import("../src/workflow/engine.ts");
const { drain } = await import("../src/workflow/scheduler.ts");
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
setChatHealthProbe(async () =>
  PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })),
);
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
setChatTitleComplete(async () => "Benchmark conversation");
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
    sql_statements_per_op: round((db.statements - s0) / n),
    node_cpu_ms_per_op: round((cpu.user + cpu.system) / 1000 / n),
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
      pool,
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
const scenarios = {
  chat_turn: async () => {
    const c = await chat.create(actor, { mode: "ASK", provider: "claude" });
    return turn(c.id, `runtime-bench-${seq++}`);
  },
  chat_concurrent: async () => {
    const cs = await Promise.all(
      Array.from({ length: 8 }, () => chat.create(actor, { mode: "ASK", provider: "claude" })),
    );
    const t0 = performance.now();
    const r = await Promise.all(cs.map((c) => turn(c.id, `runtime-bench-${seq++}`)));
    return {
      first_delta_ms: Math.max(...r.map((x) => x.first_delta_ms)),
      turn_ms: Math.max(...r.map((x) => x.turn_ms)),
      all_ms: performance.now() - t0,
    };
  },
  workflow_run: async () => {
    const t0 = performance.now();
    const run = await startRun({ definitionKey: "runtime-bench", inputs: { enabled: true } });
    await drain();
    if ((await getRun(run.id)).status !== "COMPLETED") throw new Error("run did not complete");
    const ms = performance.now() - t0;
    lastRun = run.id;
    return { run_ms: ms, overhead_per_step_ms: (ms - STEPS * 10) / STEPS };
  },
  checkpoint_replay: async () => {
    const t0 = performance.now();
    await reexecuteStep(lastRun, "root");
    await drain();
    if ((await getRun(lastRun)).status !== "COMPLETED") throw new Error("replay did not complete");
    return { replay_ms: performance.now() - t0 };
  },
};
let lastRun = 0;

const result: Record<string, unknown> = {
  generated_at: new Date().toISOString(),
  db_latency_ms_each_way: LATENCY,
  iterations: N,
  load: "knowledge import of 5 repositories + exact and symbol code search over 3 checkouts of src/, in a loop",
  alone: {} as Record<string, unknown>,
  under_load: {} as Record<string, unknown>,
};
const only = process.env.BENCH_SCENARIOS?.split(",");
const selected = Object.entries(scenarios).filter(([n]) => !only || only.includes(n));
for (const [name, fn] of selected)
  (result.alone as Record<string, unknown>)[name] = await scenario(name, N, fn);
loading = true;
const load = backgroundLoad();
await sleep(500);
for (const [name, fn] of process.env.BENCH_SKIP_LOAD ? [] : selected)
  (result.under_load as Record<string, unknown>)[name] = await scenario(`${name} (load)`, N, fn);
loading = false;
await load;
result.background_load_cycles = loadOps;
const file = join(root, `docs/architecture/runtime-e2e${LATENCY ? `-latency${LATENCY}` : ""}.json`);
writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
console.error(`wrote ${file}`);
setChatProviders(undefined);
setChatHealthProbe(undefined);
setChatTitleComplete(undefined);
await settleBackground();
await pool.end();
spawnSync("true");
process.exit(0);
