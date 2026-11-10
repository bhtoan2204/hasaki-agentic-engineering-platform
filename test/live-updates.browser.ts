/**
 * Browser behaviour of the shared live-update stream (production bundle, real server, real LISTEN/NOTIFY):
 * missed events recovered after a hidden period, polling fallback when the stream is blocked, several tabs,
 * no duplicate rows, and no run reload for transcript-only events.
 *
 *   npm run build && npm run smoke:live-updates
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { pool, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { seedKnowledge } from "../src/knowledge/service.ts";
import { handle } from "../src/http/app.ts";
import { createUser } from "../src/auth/users.ts";
import { runEvents } from "../src/workflow/events.ts";
import { startEventStream, stopEventStream } from "../src/api/stream.ts";

let server: Server;
let browser: Browser;
let base = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  await migrate();
  await seedTemplates();
  await seedKnowledge();
  await createUser({ username: "live-ui", password: "live-ui-password", role: "member" });
  await startEventStream();
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});

after(async () => {
  await browser?.close();
  await stopEventStream();
  server.closeAllConnections();
  server.close();
  await pool.end();
});

async function signedIn(): Promise<{ context: BrowserContext; csrf: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base + "/#/overview");
  const { csrf } = await page.evaluate(async () => {
    const r = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "live-ui", password: "live-ui-password" }) });
    return r.json();
  });
  await page.close();
  return { context, csrf };
}

async function newRun(context: BrowserContext, csrf: string) {
  const page = await context.newPage();
  await page.goto(base + "/#/overview");
  const run = await page.evaluate(async (csrf) => {
    const h = { "content-type": "application/json", "x-csrf-token": csrf };
    const w = await (await fetch("/api/work-items", { method: "POST", headers: h, body: JSON.stringify({ title: "live", project: "OMS" }) })).json();
    return (await fetch("/api/runs", { method: "POST", headers: h, body: JSON.stringify({ workflow: "bug-investigation", work_item_id: w.id, start: false }) })).json();
  }, csrf);
  await page.close();
  const step = (await one<{ id: number }>(pool, "SELECT id FROM workflow_steps WHERE run_id = $1 ORDER BY position LIMIT 1", [run.id]))!;
  return { runId: Number(run.id), stepId: Number(step.id) };
}

function track(page: Page) {
  const urls: string[] = [];
  page.on("request", (r) => urls.push(new URL(r.url()).pathname + new URL(r.url()).search));
  return {
    urls,
    count: (re: RegExp) => urls.filter((u) => re.test(u)).length,
  };
}

async function openRun(context: BrowserContext, runId: number) {
  const page = await context.newPage();
  const t = track(page);
  await page.goto(`${base}/#/runs/${runId}`);
  await page.getByText("run created", { exact: false }).first().waitFor({ timeout: 10_000 }).catch(() => {});
  await sleep(1000);
  return { page, t };
}

const setVisible = (page: Page, v: boolean) =>
  page.evaluate((v) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (v ? "visible" : "hidden") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => !v });
    document.dispatchEvent(new Event("visibilitychange"));
  }, v);
const occurrences = (page: Page, text: string) => page.evaluate((t) => document.body.innerText.split(t).length - 1, text);
async function shows(page: Page, text: string, ms = 10_000) {
  const end = Date.now() + ms;
  while ((await occurrences(page, text)) === 0) {
    if (Date.now() > end) throw new Error(`"${text}" never appeared`);
    await sleep(100);
  }
}

test("events written while the tab is hidden appear once after it is shown again (cursor replay)", async () => {
  const { context, csrf } = await signedIn();
  const { runId, stepId } = await newRun(context, csrf);
  const { page, t } = await openRun(context, runId);
  await setVisible(page, false);
  await sleep(300);
  await runEvents.add(pool, runId, "user", "missed-while-hidden-1", stepId);
  await runEvents.add(pool, runId, "tool", "missed-while-hidden-2", stepId);
  await sleep(500);
  const streamsBefore = t.count(/^\/api\/stream/);
  await setVisible(page, true);
  await shows(page, "missed-while-hidden-1");
  await shows(page, "missed-while-hidden-2");
  await sleep(1500);
  assert.equal(await occurrences(page, "missed-while-hidden-1"), 1, "no duplicate timeline rows");
  assert.equal(await occurrences(page, "missed-while-hidden-2"), 1);
  const reopened = t.urls.filter((u) => u.startsWith("/api/stream")).slice(streamsBefore);
  assert.ok(reopened.length >= 1 && reopened.every((u) => /after=\d+/.test(u)), `stream reopened from a cursor: ${reopened}`);
  await context.close();
});

test("transcript-only events never reload the run; state events do", async () => {
  const { context, csrf } = await signedIn();
  const { runId, stepId } = await newRun(context, csrf);
  const { page, t } = await openRun(context, runId);
  const runLoads = () => t.count(new RegExp(`^/api/runs/${runId}$`));
  const before = runLoads();
  for (let i = 0; i < 6; i++) {
    await runEvents.add(pool, runId, "tool", `activity-${i}`, stepId);
    await sleep(200);
  }
  await shows(page, "activity-5");
  assert.equal(runLoads(), before, "tool lines only extend the timeline");
  await runEvents.add(pool, runId, "status", "analyze: PENDING → RUNNING", stepId);
  await sleep(1500);
  assert.equal(runLoads(), before + 1, "a status change reloads the run once");
  await context.close();
});

test("with the stream blocked, the tab polls the event cursor and still shows new events", async () => {
  const { context, csrf } = await signedIn();
  const { runId, stepId } = await newRun(context, csrf);
  await context.route("**/api/stream**", (route) => route.abort());
  const { page, t } = await openRun(context, runId);
  // No cursor yet: the first poll reloads every view once and returns a cursor; later polls carry it.
  const end = Date.now() + 15_000;
  while (!t.count(/^\/api\/events\?after=\d+/)) {
    assert.ok(Date.now() < end, "cursor polling never started");
    await sleep(100);
  }
  const runLoadsBefore = t.count(new RegExp(`^/api/runs/${runId}$`));
  await runEvents.add(pool, runId, "user", "seen-through-fallback", stepId);
  await shows(page, "seen-through-fallback", 15_000);
  await sleep(6000); // quiet period: polling must not reload views when nothing changed
  assert.equal(t.count(new RegExp(`^/api/runs/${runId}$`)), runLoadsBefore + 1, "one reload for the one state event");
  assert.equal(await occurrences(page, "seen-through-fallback"), 1);
  await context.close();
});

test("two tabs of the same user both follow the run", async () => {
  const { context, csrf } = await signedIn();
  const { runId, stepId } = await newRun(context, csrf);
  const one = await openRun(context, runId);
  const two = await openRun(context, runId);
  await runEvents.add(pool, runId, "user", "both-tabs-see-this", stepId);
  await Promise.all([shows(one.page, "both-tabs-see-this"), shows(two.page, "both-tabs-see-this")]);
  await context.close();
});
