/**
 * Live-update request budget: real HTTP server, real PostgreSQL LISTEN/NOTIFY, real production bundle in headless
 * Chromium. Simulates an agent writing transcript events in bursts (tool call, tool result, assistant text) plus a
 * few status transitions, and counts what the browser asks for and what the server does in return.
 *
 *   npm run build && npm run bench:live-updates
 *
 * Scenarios:
 *   run-view     Run page with the step inspector open while the agent works
 *   run-overview Run page without a selected step (totals, cost, timeline panels)
 *   questions    Questions page (an any-run subscriber) during the same activity
 *   fallback     Run page while /api/stream is unreachable (polling fallback)
 *   hidden-tab   Run page hidden for a while, then shown again (reconnect + catch up)
 * Output: one JSON line per scenario with request counts per endpoint, total server DB queries and server CPU ms.
 */
import { createServer } from "node:http";
import pg from "pg";
import { chromium, type Page } from "playwright-core";
import { pool, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { seedKnowledge } from "../src/knowledge/service.ts";
import { handle } from "../src/http/app.ts";
import { createUser } from "../src/auth/users.ts";
import * as stream from "../src/api/stream.ts";
import { runEvents } from "../src/workflow/events.ts";

const BURSTS = Number(process.env.BENCH_BURSTS ?? 12);
const BURST_GAP_MS = Number(process.env.BENCH_BURST_GAP_MS ?? 1500);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await migrate();
await seedTemplates();
await seedKnowledge();
await createUser({ username: "bench", password: "bench-password", role: "member" });
await stream.startEventStream();
const server = createServer(handle);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

// Count every statement the server sends to PostgreSQL (pool.query goes through Client#query exactly once).
let dbQueries = 0;
const origQuery = pg.Client.prototype.query;
(pg.Client.prototype as any).query = function (this: any, ...a: any[]) {
  dbQueries++;
  return (origQuery as any).apply(this, a);
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

async function session() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base + "/#/overview");
  const login = await page.evaluate(async () => {
    const r = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "bench", password: "bench-password" }) });
    return r.json();
  });
  return { context, page, csrf: login.csrf as string };
}

async function newRun(page: Page, csrf: string) {
  const run = await page.evaluate(async (csrf) => {
    const w = await (await fetch("/api/work-items", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ title: "bench", project: "OMS" }) })).json();
    return (await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ workflow: "bug-investigation", work_item_id: w.id, start: false }) })).json();
  }, csrf);
  const step = (await one<{ id: number; key: string }>(pool, "SELECT id, key FROM workflow_steps WHERE run_id = $1 ORDER BY position LIMIT 1", [run.id]))!;
  const attempt = (await one<{ id: number }>(pool, "INSERT INTO workflow_step_attempts (step_id, run_id, number, generation, status) VALUES ($1, $2, 1, 1, 'RUNNING') RETURNING id", [step.id, run.id]))!;
  await pool.query("UPDATE workflow_steps SET status = 'RUNNING', current_attempt_id = $1 WHERE id = $2", [attempt.id, step.id]);
  await pool.query("UPDATE workflow_runs SET status = 'RUNNING' WHERE id = $1", [run.id]);
  return { runId: Number(run.id), stepId: Number(step.id), stepKey: step.key, attemptId: Number(attempt.id) };
}

/** An agent at work: every burst is a tool call, its result and a line of assistant text; status changes at 1/3 and 2/3. */
async function agentActivity(r: { runId: number; stepId: number; attemptId: number }, bursts = BURSTS) {
  for (let i = 0; i < bursts; i++) {
    await runEvents.add(pool, r.runId, "tool", `Read src/file${i}.ts`, r.stepId, r.attemptId);
    await runEvents.add(pool, r.runId, "tool_result", `contents of file ${i}`, r.stepId, r.attemptId);
    await runEvents.add(pool, r.runId, "agent", `Looking at file ${i}`, r.stepId, r.attemptId);
    if (i === Math.floor(bursts / 3) || i === Math.floor((2 * bursts) / 3)) await runEvents.add(pool, r.runId, "status", `analyze: RUNNING → RUNNING (bench ${i})`, r.stepId);
    await sleep(BURST_GAP_MS);
  }
}

/** A full load (not a hash change), so the SPA picks up the session cookie set by the login above. */
async function open(page: Page, url: string) {
  await page.goto(url);
  await page.reload();
  await page.waitForLoadState("networkidle").catch(() => { });
}

function recorder(page: Page) {
  const counts: Record<string, number> = {};
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (!u.pathname.startsWith("/api/")) return;
    const key = u.pathname.replace(/\/\d+/g, "/:id");
    counts[key] = (counts[key] ?? 0) + 1;
  });
  return counts;
}

async function measure(name: string, fn: () => Promise<void>, counts: Record<string, number>) {
  for (const k of Object.keys(counts)) delete counts[k];
  const q0 = dbQueries;
  const cpu0 = process.cpuUsage();
  const t0 = Date.now();
  await fn();
  await sleep(1500); // let trailing refreshes land
  const cpu = process.cpuUsage(cpu0);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const sorted = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
  console.log(JSON.stringify({ scenario: name, seconds: Math.round((Date.now() - t0) / 1000), api_requests: total, db_queries: dbQueries - q0, server_cpu_ms: Math.round((cpu.user + cpu.system) / 1000), by_endpoint: sorted }));
}

const want = (process.env.BENCH_SCENARIOS ?? "run-view,run-overview,questions,fallback,hidden-tab").split(",");
try {
  if (want.includes("run-view")) {
    const { context, page, csrf } = await session();
    const r = await newRun(page, csrf);
    const counts = recorder(page);
    await open(page, `${base}/#/runs/${r.runId}/${r.stepKey}`);
    await sleep(2500);
    await measure("run-view", () => agentActivity(r), counts);
    await context.close();
  }
  if (want.includes("run-overview")) {
    const { context, page, csrf } = await session();
    const r = await newRun(page, csrf);
    const counts = recorder(page);
    await open(page, `${base}/#/runs/${r.runId}`);
    await sleep(2500);
    await measure("run-overview", () => agentActivity(r), counts);
    await context.close();
  }
  if (want.includes("questions")) {
    const { context, page, csrf } = await session();
    const r = await newRun(page, csrf);
    const counts = recorder(page);
    await open(page, `${base}/#/questions`);
    await sleep(2500);
    await measure("questions", () => agentActivity(r), counts);
    await context.close();
  }
  if (want.includes("fallback")) {
    const { context, page, csrf } = await session();
    const r = await newRun(page, csrf);
    await page.route("**/api/stream**", (route) => route.abort());
    const counts = recorder(page);
    await open(page, `${base}/#/runs/${r.runId}/${r.stepKey}`);
    await sleep(2500);
    await measure("fallback", () => agentActivity(r), counts);
    await context.close();
  }
  if (want.includes("hidden-tab")) {
    const { context, page, csrf } = await session();
    const r = await newRun(page, csrf);
    const counts = recorder(page);
    await open(page, `${base}/#/runs/${r.runId}/${r.stepKey}`);
    await sleep(2500);
    const setVisible = (v: boolean) =>
      page.evaluate((v) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (v ? "visible" : "hidden") });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => !v });
        document.dispatchEvent(new Event("visibilitychange"));
      }, v);
    await measure(
      "hidden-tab",
      async () => {
        await setVisible(false);
        await agentActivity(r, Math.ceil(BURSTS / 2)); // happens while nobody looks
        await setVisible(true);
        await sleep(2000);
      },
      counts,
    );
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await (stream as any).stopEventStream?.();
  await pool.end().catch(() => { });
  process.exit(0); // the LISTEN client has no stop hook on older code
}
