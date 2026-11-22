/**
 * Bug Hunter in the Incidents accordion and on Incident Detail, in a real browser (production bundle, real server,
 * real hunts through the engine and harness with the scripted fake `codex` agents; the test advances the scheduler
 * step by step while the page polls, so intermediate states are real, not mocked).
 *
 * Journeys: collapsed rows show hunt state from ONE batched request; expanding shows Bug Hunter; start from the
 * accordion; stages update while polling; unverified candidates and claims under verification are labelled as such;
 * cancel; collapse/reopen keeps the run; completed results with both verdicts and a fix task; a failed hunt shows its
 * reason; Incident Detail still works; Vietnamese on a phone width without horizontal overflow. Screenshots go to
 * docs/validation/production-bug-hunter-ui/.
 *
 *   npm run build && npm run smoke:bug-hunter
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { pool, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { handle } from "../src/http/app.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { getRun } from "../src/workflow/engine.ts";
import { runOnce } from "../src/workflow/scheduler.ts";
import { setSharedHealthProber } from "../src/agent/health.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { startBugHunt } from "../src/bugHunt/service.ts";
import { caseFingerprint } from "../src/eval/bugHuntFixtures.ts";
import { setupBugHuntFixture } from "./fixtures/bugHuntRepo.ts";

let server: Server;
let browser: Browser;
let base = "";
let user: PublicUser;
let fx: Awaited<ReturnType<typeof setupBugHuntFixture>>;
const hunts: Record<string, number> = {};
const out = resolve(process.env.BUG_HUNT_SCREENSHOTS || "docs/validation/production-bug-hunter-ui");
const PROVIDERS = ["claude", "cursor", "codex", "antigravity", "copilot"] as const;
const FP = {
  fresh: caseFingerprint("real-bug"),
  done: caseFingerprint("misleading-stacktrace"),
  failed: caseFingerprint("missing-cancellation"),
  queued: caseFingerprint("retry-amplification"),
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function drive(runId: number) {
  for (let i = 0; i < 4000; i++) {
    const r = await getRun(runId);
    if (["COMPLETED", "FAILED", "CANCELED"].includes(r.status)) return r.status;
    if (!(await runOnce())) await sleep(50);
  }
  throw new Error(`run ${runId} did not finish`);
}
const stepStatus = async (runId: number, key: string) =>
  (await one<{ status: string }>(
    pool,
    "SELECT status FROM workflow_steps WHERE run_id=$1 AND key=$2",
    [runId, key],
  ))!.status;
/** Advance the scheduler one job at a time until `done` holds (other runs' jobs may run too). */
async function stepUntil(done: () => Promise<boolean>) {
  for (let i = 0; i < 400 && !(await done()); i++) if (!(await runOnce())) await sleep(50);
  assert.ok(await done(), "scheduler reached the expected state");
}

before(async () => {
  await migrate();
  await createUser({
    username: "bughunt-admin",
    password: "bughunt-admin-password",
    role: "admin",
  });
  user = await createUser({
    username: "bughunt-ui",
    password: "bughunt-ui-password",
    role: "member",
  });
  setSharedHealthProber(async () =>
    PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })),
  );
  fx = await setupBugHuntFixture(process.env.TEST_ROOT!);
  // A finished hunt with findings.
  const done = await startBugHunt(FP.done, user, { repositories: [fx.repo], provider: "codex" });
  hunts.done = done.hunt_id;
  assert.equal(await drive(done.run_id), "COMPLETED");
  // A failed hunt: the hunter never submits a result.
  fx.useScript(
    "ui-nosubmit",
    `import def from ${JSON.stringify(join(process.env.TEST_ROOT!, "bughunt-agent.mjs"))};
export default async (x) => (x.prompt.includes("Hunt for REAL") ? null : def(x));`,
  );
  const failed = await startBugHunt(FP.failed, user, {
    repositories: [fx.repo],
    provider: "codex",
  });
  hunts.failed = failed.hunt_id;
  assert.equal(await drive(failed.run_id), "FAILED");
  fx.defaultScript();
  // A hunt that is queued when the page opens (not advanced until later).
  hunts.queued = (
    await startBugHunt(FP.queued, user, { repositories: [fx.repo], provider: "codex" })
  ).hunt_id;
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  mkdirSync(out, { recursive: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  server?.close();
  await settleBackground();
  setSharedHealthProber(undefined);
  await pool.end();
});

async function open(locale: "en" | "vi", viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript((l) => localStorage.setItem("hasaki.uiLocale", l), locale);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let dialogs = 0;
  page.on("dialog", (d) => (dialogs++, void d.dismiss()));
  const requests: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/(bug-hunts|prod-errors\/[0-9a-f]{20}\/bug-hunts)/.test(r.url()))
      requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await page.goto(`${base}/#/prod-errors/incidents`);
  await page.locator('input[name="username"]').fill("bughunt-ui");
  await page.locator('input[name="password"]').fill("bughunt-ui-password");
  await page.locator('button[type="submit"]').click();
  await page.locator(".pe-row").first().waitFor();
  return { context, page, errors, requests, dialogs: () => dialogs };
}
const row = (page: Page, fp: string) => page.locator(`#pe-${fp}`);
async function shot(page: Page, name: string) {
  // Expand the app's scroll container only while capturing the full document.
  const style = await page.addStyleTag({
    content:
      ".app,.shell,.page,main{height:auto!important;max-height:none!important;overflow:visible!important}body{overflow:visible!important}",
  });
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  await style.evaluate((el) => el.parentNode?.removeChild(el));
}

test("Bug Hunter inside the Incidents accordion: start, progress, cancel, results, failure, detail page", async () => {
  const { context, page, errors, requests, dialogs } = await open("en", {
    width: 1280,
    height: 1000,
  });
  // Collapsed rows: hunt state from one batched summary request; no per-row detail requests.
  await row(page, FP.done).locator(".pe-hunt").waitFor();
  assert.match(await row(page, FP.done).locator(".pe-hunt").innerText(), /1 confirmed/);
  assert.match(await row(page, FP.failed).locator(".pe-hunt").innerText(), /Failed/);
  assert.match(await row(page, FP.queued).locator(".pe-hunt").innerText(), /Queued/);
  assert.equal(await row(page, FP.fresh).locator(".pe-hunt").count(), 0);
  assert.equal(
    await page.locator(".bh-inline").count(),
    0,
    "collapsed rows render no Bug Hunter body",
  );
  await shot(page, "1-collapsed.png");
  assert.equal(requests.filter((r) => r.includes("/summary")).length, 1);
  assert.equal(requests.filter((r) => /\/api\/bug-hunts\/\d+$/.test(r.split(" ")[1])).length, 0);

  // Expand an incident without a hunt: Bug Hunter is right there.
  await row(page, FP.fresh).locator(".pe-head").click();
  const inline = row(page, FP.fresh).locator(".bh-inline");
  await inline.waitFor();
  assert.match(await inline.innerText(), /No bug hunt for this incident yet/);
  await shot(page, "2-expanded-before.png");

  // Start from the accordion (repository + provider; a single submission).
  await inline.getByRole("button", { name: "Start Bug Hunt" }).click();
  await inline.locator(".bh-form input[type=checkbox]").first().check();
  await inline.locator(".bh-form select").selectOption("codex");
  await inline.getByRole("button", { name: "Run Bug Hunt" }).click();
  await inline.locator(".bh-detail[data-hunt]").waitFor();
  assert.equal(requests.filter((r) => r.startsWith("POST") && r.endsWith("/bug-hunts")).length, 1);
  const huntId = Number(await inline.locator(".bh-detail").getAttribute("data-hunt"));
  const runId = (await one<{ run_id: number }>(pool, "SELECT run_id FROM bug_hunts WHERE id=$1", [
    huntId,
  ]))!.run_id;
  await inline.getByText("Refreshes every 5 s (not real-time)").waitFor();
  assert.match(await inline.locator(".bh-results").innerText(), /No verified findings yet/);
  assert.equal(
    await inline.locator('.bh-tl-item[data-stage="hunt"] a').count(),
    0,
    "a pending stage is not a link",
  );
  assert.match(await row(page, FP.fresh).locator(".pe-hunt").innerText(), /Queued|Running/);

  // The scheduler advances; the page's polling shows the hunter's candidates as unverified hypotheses.
  await stepUntil(async () => (await stepStatus(runId, "hunt")) === "COMPLETED");
  await inline.locator(".bh-callout.is-candidates").waitFor({ timeout: 15_000 });
  assert.match(
    await inline.locator(".bh-callout.is-candidates").innerText(),
    /not verified, hypotheses only/,
  );
  assert.match(await inline.locator('.bh-tl-item[data-stage="hunt"]').innerText(), /Done/);
  assert.ok(
    await inline.locator('.bh-tl-item[data-stage="hunt"] a').getAttribute("href"),
    "a stage that ran links to its step",
  );
  assert.match(await inline.locator('.bh-tl-item[data-stage="triage"]').innerText(), /Pending/);
  assert.doesNotMatch(
    await inline.innerText(),
    /no code bug was confirmed/i,
    "no premature conclusion",
  );
  await stepUntil(async () => (await stepStatus(runId, "triage")) === "COMPLETED");
  await inline.getByText(/Independently verifying 1 claim/).waitFor({ timeout: 15_000 });
  assert.match(await inline.locator(".bh-status").first().innerText(), /Verifying/);
  await shot(page, "3-active.png");

  // Cancel from the accordion.
  await inline.getByRole("button", { name: "Cancel" }).click();
  await inline.locator('.bh-status[data-status="canceled"]').waitFor({ timeout: 15_000 });
  assert.match(await inline.locator(".bh-results").innerText(), /canceled/i);
  await row(page, FP.fresh)
    .locator(".pe-hunt", { hasText: "Canceled" })
    .waitFor({ timeout: 15_000 });

  // Collapse and reopen: the same hunt is shown.
  await row(page, FP.fresh).locator(".pe-head").click();
  await row(page, FP.fresh).locator(".pe-head").click();
  assert.equal(
    Number(await row(page, FP.fresh).locator(".bh-detail").getAttribute("data-hunt")),
    huntId,
  );

  // Completed hunt: results first, both verdicts, verification evidence, a fix task.
  await row(page, FP.done).locator(".pe-head").click();
  const done = row(page, FP.done).locator(".bh-inline");
  await done.locator(".bh-callout.is-confirmed").waitFor();
  const confirmed = done.locator('.bh-finding[data-status="CONFIRMED"]');
  const text = await confirmed.innerText();
  assert.match(text, /Fill/);
  assert.match(text, /Code bug: CONFIRMED/);
  assert.match(text, /Incident cause: PROBABLE/);
  assert.match(text, /reproduced/);
  assert.match(await done.locator('.bh-finding[data-status="SUSPECTED"]').innerText(), /Format/);
  await confirmed.locator(".bh-more summary").click();
  assert.match(await confirmed.locator(".bh-more").innerText(), /go test -count=1/);
  await shot(page, "4-completed.png");
  await confirmed.getByRole("button", { name: "Create fix task" }).click();
  await confirmed.getByRole("link", { name: /Run #\d+/ }).waitFor();

  // Failed hunt: the stage and its recorded reason, with a link to the step.
  await row(page, FP.failed).locator(".pe-head").click();
  const failed = row(page, FP.failed).locator(".bh-inline");
  await failed.locator(".bh-callout.is-failed").waitFor();
  assert.match(
    await failed.locator(".bh-callout.is-failed").innerText(),
    /Bug Hunter: .*submit_result/,
  );
  await failed.locator(".bh-progress summary").click();
  assert.match(await failed.locator('.bh-tl-item[data-stage="hunt"]').innerText(), /Failed/);
  await shot(page, "5-failed.png");

  // Only expanded rows fetched hunt details.
  const detailIds = new Set(
    requests.map((r) => /\/api\/bug-hunts\/(\d+)$/.exec(r.split(" ")[1])?.[1]).filter(Boolean),
  );
  assert.deepEqual([...detailIds].sort(), [huntId, hunts.done, hunts.failed].map(String).sort());

  // Incident Detail still works (history + selected hunt).
  await failed.getByRole("link", { name: "View incident details" }).click();
  await page.locator(".bh-hunts").waitFor();
  assert.match(await page.locator(".bh-hunts").innerText(), /#\d+/);
  assert.equal(dialogs(), 0, "no browser-native dialogs");
  assert.deepEqual(errors, []);
  await context.close();
});

test("Vietnamese on a phone width: readable timeline and findings, no horizontal overflow", async () => {
  const { context, page, errors } = await open("vi", { width: 390, height: 844 });
  await row(page, FP.done).locator(".pe-head").click();
  const done = row(page, FP.done).locator(".bh-inline");
  await done.locator(".bh-callout.is-confirmed").waitFor();
  assert.match(await done.innerText(), /Lỗi code: CONFIRMED/);
  assert.match(await done.innerText(), /Nguyên nhân sự cố: PROBABLE/);
  await done.locator(".bh-progress summary").click();
  assert.match(await done.locator(".bh-timeline").innerText(), /Tái hiện cách ly/);
  const overflow = await page.evaluate(() => {
    const els = [...document.querySelectorAll(".bh-inline, .bh-inline *")] as HTMLElement[];
    const vw = document.documentElement.clientWidth;
    return els
      .filter((e) => e.getBoundingClientRect().right > vw + 1)
      .map((e) => e.className)
      .slice(0, 5);
  });
  assert.deepEqual(overflow, [], "nothing in Bug Hunter extends past the viewport");
  await shot(page, "6-mobile-vi.png");
  assert.deepEqual(errors, []);
  await context.close();
});
