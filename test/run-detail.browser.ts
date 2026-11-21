/**
 * Run Detail in a real browser (production bundle, real server, real LISTEN/NOTIFY, stub executor): small, medium and
 * large workflows (up to 240 steps, ~2 600 attempts, 10 000 events). Measures load, DAG render, requests, React commits,
 * main-thread script time, long tasks, layout shifts, heap, step switching, and the cost of state-change and
 * activity-only event bursts. Deterministic invariants are asserted (one shared stream, no run reload for activity
 * events, bounded reloads per state change, every DAG node rendered); timings are published, not asserted.
 *
 *   npm run build && npm run smoke:run-detail
 *   RUN_DETAIL_BENCH_OUT=docs/architecture/run-detail-frontend.json npm run smoke:run-detail
 */
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { handle } from "../src/http/app.ts";
import { createUser } from "../src/auth/users.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { conditionExecutor } from "../src/workflow/executors/builtin.ts";
import { runEvents } from "../src/workflow/events.ts";
import { setSharedHealthProber } from "../src/agent/health.ts";
import { startEventStream, stopEventStream } from "../src/api/stream.ts";
import { settleBackground } from "../src/workflow/background.ts";

let server: Server;
let browser: Browser;
let base = "";
let ownerId = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const measurements: Record<string, unknown> = {};
const PROVIDERS = ["claude", "cursor", "codex", "antigravity", "copilot"] as const;

before(async () => {
  await migrate();
  const u = await createUser({ username: "run-ui", password: "run-ui-password", role: "member" });
  ownerId = u.id;
  setSharedHealthProber(async () =>
    PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })),
  );
  registerExecutor("condition", conditionExecutor);
  registerExecutor("agent", {
    async execute(ctx) {
      return { kind: "completed", output: { summary: `${ctx.step.key} done` } };
    },
  });
  await startEventStream();
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-precise-memory-info"],
    ...(process.env.CHROMIUM_LD_LIBRARY_PATH
      ? { env: { ...process.env, LD_LIBRARY_PATH: process.env.CHROMIUM_LD_LIBRARY_PATH } }
      : {}),
  });
});

after(async () => {
  if (process.env.RUN_DETAIL_BENCH_OUT)
    writeFileSync(
      process.env.RUN_DETAIL_BENCH_OUT,
      JSON.stringify({ generated_at: new Date().toISOString(), ...measurements }, null, 2) + "\n",
    );
  await browser?.close();
  await stopEventStream();
  server.closeAllConnections();
  server.close();
  await settleBackground();
  setSharedHealthProber(undefined);
  await pool.end();
});

/** EventSource constructions, React commits (minimal devtools hook), long tasks and layout shifts. */
const instrument = () => {
  const w = window as unknown as Record<string, unknown>;
  const m = { streams: 0, commits: 0, longTasks: 0, longTaskMs: 0, cls: 0 };
  w.__rv = m;
  const Native = window.EventSource;
  class Counted extends Native {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      m.streams++;
    }
  }
  window.EventSource = Counted as typeof EventSource;
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    onScheduleFiberRoot() {},
    onCommitFiberRoot() {
      m.commits++;
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        m.longTasks++;
        m.longTaskMs += e.duration;
      }
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as Array<
        PerformanceEntry & { value: number; hadRecentInput: boolean }
      >)
        if (!e.hadRecentInput) m.cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    /* observers unavailable */
  }
};
type Counters = {
  streams: number;
  commits: number;
  longTasks: number;
  longTaskMs: number;
  cls: number;
};
const counters = (page: Page) =>
  page.evaluate(() => ({ ...(window as unknown as { __rv: Counters }).__rv }));
const heapMb = (page: Page) =>
  page.evaluate(
    () =>
      ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
        0) / 1048576,
  );

async function signedIn(): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  await page.goto(base + "/#/overview");
  await page.evaluate(async () => {
    await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "run-ui", password: "run-ui-password" }),
    });
  });
  await page.close();
  return context;
}

/** Main-thread script and task time (CDP Performance domain). */
async function perf(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  return async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    return {
      script: m.ScriptDuration * 1000,
      task: m.TaskDuration * 1000,
      layout: m.LayoutDuration * 1000,
    };
  };
}

/**
 * A completed run of `steps` agent steps in 4 parallel chains after a condition root, each step with `extra` earlier
 * (invalidated) attempts and `events` activity lines spread over the attempts.
 */
async function seedRun(key: string, steps: number, extra: number, events: number) {
  await definitions.create({
    key,
    spec: {
      name: `Run detail ${key}`,
      steps: [
        { key: "root", type: "condition", config: { path: "inputs.enabled", equals: true } },
        ...Array.from({ length: steps }, (_, i) => ({
          key: `step-${i}`,
          name: `Step ${i}`,
          type: "agent",
          depends_on: [i < 4 ? "root" : `step-${i - 4}`],
          config: { agent: { provider: "claude", allowed_tools: ["platform.submit_result"] } },
        })),
      ],
    },
  } as never);
  const run = await startRun({ definitionKey: key, inputs: { enabled: true }, ownerId });
  await drain(steps + 10);
  await settleBackground();
  if (extra)
    await q(
      pool,
      `INSERT INTO workflow_step_attempts (step_id, run_id, number, generation, status, input, output, metrics,
              started_at, finished_at, invalidated_at, agent_provider)
       SELECT a.step_id, a.run_id, a.number + g, a.generation, 'FAILED', a.input, a.output, a.metrics,
              a.started_at, a.finished_at, now(), a.agent_provider
         FROM workflow_step_attempts a, generate_series(1, $2::int) g WHERE a.run_id = $1 AND a.number = 1`,
      [run.id, extra],
    );
  if (events)
    await q(
      pool,
      `INSERT INTO workflow_events (run_id, step_id, attempt_id, kind, content, data, level)
       SELECT a.run_id, a.step_id, a.id, (ARRAY['agent','tool','tool_result','assistant'])[1 + g % 4],
              'activity line ' || g || ' of step ' || a.step_id, '{}'::jsonb, 'INFO'
         FROM (SELECT * FROM workflow_step_attempts WHERE run_id = $1 AND number = 1) a,
              generate_series(1, $2::int) g`,
      [run.id, Math.ceil(events / (steps + 1))],
    );
  const [{ n }] = await q<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM workflow_step_attempts WHERE run_id = $1",
    [run.id],
  );
  const [{ e }] = await q<{ e: number }>(
    pool,
    "SELECT count(*)::int AS e FROM workflow_events WHERE run_id = $1",
    [run.id],
  );
  const firstAttempt = await q<{ id: number; step_id: number }>(
    pool,
    "SELECT a.id, a.step_id FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE a.run_id = $1 AND s.key = 'step-0' AND a.number = 1",
    [run.id],
  );
  return {
    runId: Number(run.id),
    nodes: steps + 1,
    attempts: n,
    events: e,
    attempt: firstAttempt[0],
  };
}

const runReloads = (urls: string[], runId: number) =>
  urls.filter((u) => u === `/api/runs/${runId}`).length;

async function measure(size: string, steps: number, extra: number, events: number) {
  const seeded = await seedRun(`run-detail-${size}`, steps, extra, events);
  const context = await signedIn();
  const page = await context.newPage();
  const urls: string[] = [];
  let runBytes = 0,
    runWire = 0,
    wire = 0;
  page.on("request", (r) => urls.push(new URL(r.url()).pathname + new URL(r.url()).search));
  page.on("requestfinished", async (r) => {
    const sizes = await r.sizes().catch(() => null);
    if (!sizes) return;
    wire += sizes.responseBodySize + sizes.responseHeadersSize;
    if (new URL(r.url()).pathname === `/api/runs/${seeded.runId}`) {
      runWire = Math.max(runWire, sizes.responseBodySize);
      runBytes = Math.max(
        runBytes,
        (await (await r.response())?.body().catch(() => null))?.length ?? 0,
      );
    }
  });
  const sample = await perf(page);
  // The top bar asks /api/agent-providers on every page: the first call of a process runs each provider's readiness
  // CLI (2–3 s cold on this host, environment-specific). Warm it first so the load measures the page, and report it.
  const s0 = performance.now();
  await context.request.get(`${base}/api/agent-providers`);
  const providerStatusMs = performance.now() - s0;
  // ---- cold load: navigation → every DAG node rendered
  const t0 = Date.now();
  await page.goto(`${base}/#/runs/${seeded.runId}`);
  await page.waitForFunction(
    (n) => document.querySelectorAll(".react-flow__node").length >= n,
    seeded.nodes,
    { timeout: 60_000, polling: 20 },
  );
  const loadMs = Date.now() - t0;
  await sleep(1500); // let the side cards settle
  const loaded = {
    ...(await counters(page)),
    ...(await sample()),
    requests: urls.length,
    wire_kb: wire / 1024,
    heap_mb: await heapMb(page),
  };
  if (process.env.RUN_DETAIL_DEBUG) console.error(size, "load requests", JSON.stringify(urls));
  assert.equal(
    await page.locator(".react-flow__node").count(),
    seeded.nodes,
    "every step is drawn",
  );

  // ---- state change: one status event → the run (and its cards) refresh
  let c0 = await counters(page);
  let p0 = await sample();
  let u0 = urls.length;
  await runEvents.add(pool, seeded.runId, "status", "run: state change for the benchmark");
  await sleep(2000);
  let c1 = await counters(page);
  let p1 = await sample();
  if (process.env.RUN_DETAIL_DEBUG)
    console.error(size, "state requests", JSON.stringify(urls.slice(u0)));
  const stateChange = {
    commits: c1.commits - c0.commits,
    script_ms: p1.script - p0.script,
    requests: urls.length - u0,
    run_reloads: runReloads(urls.slice(u0), seeded.runId),
  };

  // ---- activity burst: 200 transcript events in ~1 s (no state change)
  c0 = await counters(page);
  p0 = await sample();
  u0 = urls.length;
  for (let i = 0; i < 200; i++) {
    await runEvents.add(
      pool,
      seeded.runId,
      i % 2 ? "tool" : "agent",
      `burst ${i}`,
      seeded.attempt.step_id,
      seeded.attempt.id,
    );
    await sleep(5);
  }
  await sleep(2000);
  c1 = await counters(page);
  p1 = await sample();
  const burst = {
    commits: c1.commits - c0.commits,
    script_ms: p1.script - p0.script,
    requests: urls.length - u0,
    run_reloads: runReloads(urls.slice(u0), seeded.runId),
  };

  // ---- step switching: open five steps in turn (deep link navigation, as a node click does)
  const switches: number[] = [];
  c0 = await counters(page);
  p0 = await sample();
  for (const i of [0, Math.floor(steps / 4), Math.floor(steps / 2), steps - 5, steps - 1]) {
    const s0 = Date.now();
    await page.evaluate(
      ([run, key]) => (location.hash = `#/runs/${run}/${key}`),
      [seeded.runId, `step-${i}`],
    );
    await page.waitForFunction(
      (name) =>
        (document.querySelector(".rv-inspector") as HTMLElement | null)?.innerText.includes(name) ??
        false,
      `Step ${i}`,
      { timeout: 30_000, polling: 10 },
    );
    switches.push(Date.now() - s0);
    await sleep(300);
  }
  c1 = await counters(page);
  p1 = await sample();
  const switching = {
    open_ms_each: switches,
    open_ms_max: Math.max(...switches),
    commits: c1.commits - c0.commits,
    script_ms: p1.script - p0.script,
  };
  const final = await counters(page);
  const result = {
    nodes: seeded.nodes,
    attempts: seeded.attempts,
    events: seeded.events,
    load: {
      load_ms: loadMs,
      requests: loaded.requests,
      run_payload_kb: Math.round(runBytes / 102.4) / 10,
      run_transfer_kb: Math.round(runWire / 102.4) / 10,
      transfer_kb: Math.round(loaded.wire_kb),
      commits: loaded.commits,
      script_ms: Math.round(loaded.script),
      task_ms: Math.round(loaded.task),
      layout_ms: Math.round(loaded.layout),
      long_tasks: loaded.longTasks,
      long_task_ms: Math.round(loaded.longTaskMs),
      cls: Math.round(loaded.cls * 1000) / 1000,
      heap_mb: Math.round(loaded.heap_mb * 10) / 10,
    },
    state_change: { ...stateChange, script_ms: Math.round(stateChange.script_ms) },
    activity_burst_200: { ...burst, script_ms: Math.round(burst.script_ms) },
    step_switching: { ...switching, script_ms: Math.round(switching.script_ms) },
    provider_status_first_call_ms: Math.round(providerStatusMs),
    streams_opened: final.streams,
    heap_mb_end: Math.round((await heapMb(page)) * 10) / 10,
  };
  measurements[size] = result;
  console.error(size, JSON.stringify(result));
  await context.close();
  return result;
}

const SIZES = [
  ["small", 12, 0, 50],
  ["medium", 60, 5, 2000],
  ["large", 240, 10, 10000],
] as const;
for (const [size, steps, extra, events] of SIZES.filter(
  ([s]) => !process.env.RUN_DETAIL_SIZES || process.env.RUN_DETAIL_SIZES.split(",").includes(s),
))
  test(`run detail (${size}): every node drawn, one shared stream, activity never reloads the run`, async () => {
    const r = await measure(size, steps, extra, events);
    assert.equal(r.streams_opened, 1, "one EventSource for the whole session on the page");
    assert.equal(
      r.activity_burst_200.run_reloads,
      0,
      "transcript-only events never reload the run",
    );
    assert.ok(
      r.state_change.run_reloads >= 1 && r.state_change.run_reloads <= 2,
      `state change reloads the run once: ${r.state_change.run_reloads}`,
    );
  });
