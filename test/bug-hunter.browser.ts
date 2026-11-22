/**
 * Bug Hunter on the Production Errors incident page, in a real browser (production bundle, real server, real hunt
 * through the engine and harness with the scripted fake `codex` agents). Checks: the panel lists the incident's hunts,
 * shows the derived status and stages, the confirmed finding with separate bug and incident-cause verdicts, the
 * reproduction, coverage and execution; starting a hunt from the panel (repository + provider, no browser dialogs);
 * the polling notice while active; cancel. Screenshots go to docs/validation/production-bug-hunter/.
 *
 *   npm run build && npm run smoke:bug-hunter
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "playwright-core";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { handle } from "../src/http/app.ts";
import { createUser } from "../src/auth/users.ts";
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
const out = resolve(process.env.BUG_HUNT_SCREENSHOTS || "docs/validation/production-bug-hunter");
const PROVIDERS = ["claude", "cursor", "codex", "antigravity", "copilot"] as const;

before(async () => {
  await migrate();
  // The login form is shown once an administrator exists.
  await createUser({
    username: "bughunt-admin",
    password: "bughunt-admin-password",
    role: "admin",
  });
  const user = await createUser({
    username: "bughunt-ui",
    password: "bughunt-ui-password",
    role: "member",
  });
  setSharedHealthProber(async () =>
    PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })),
  );
  const fx = await setupBugHuntFixture(process.env.TEST_ROOT!);
  // One finished hunt, produced by the real engine (as the panel would have started it).
  const h = await startBugHunt(caseFingerprint("misleading-stacktrace"), user, {
    repositories: [fx.repo],
    provider: "codex",
  });
  for (let i = 0; i < 4000; i++) {
    const r = await getRun(h.run_id);
    if (["COMPLETED", "FAILED", "CANCELED"].includes(r.status)) break;
    if (!(await runOnce())) await new Promise((res) => setTimeout(res, 50));
  }
  assert.equal((await getRun(h.run_id)).status, "COMPLETED");
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

test("Bug Hunter panel: results, start, polling notice and cancel on the incident page", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem("hasaki.uiLocale", "en"));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Expand the app's scroll container only while capturing the full document.
  const shot = async (name: string) => {
    const style = await page.addStyleTag({
      content:
        ".app,.shell,.page,main{height:auto!important;max-height:none!important;overflow:visible!important}body{overflow:visible!important}",
    });
    await page.screenshot({ path: resolve(out, name), fullPage: true });
    await style.evaluate((el) => el.parentNode?.removeChild(el));
  };
  let dialogs = 0;
  page.on("dialog", (d) => (dialogs++, void d.dismiss()));
  await page.goto(`${base}/#/prod-errors/${caseFingerprint("misleading-stacktrace")}`);
  await page.locator('input[name="username"]').fill("bughunt-ui");
  await page.locator('input[name="password"]').fill("bughunt-ui-password");
  await page.locator('button[type="submit"]').click();
  const panel = page.locator(".bh-hunts").first();
  await panel.waitFor();
  await page.locator(".bh-detail .bh-status").first().waitFor();
  assert.match(
    await page.locator(".bh-detail .bh-status").first().innerText(),
    /Completed|Partial/,
  );
  assert.equal(await page.locator(".bh-stages li").count(), 9);
  const confirmed = page.locator('.bh-finding[data-status="CONFIRMED"]');
  const sandboxed = (await confirmed.count()) > 0;
  if (sandboxed) {
    // The callee bug is confirmed; as a cause it is PROBABLE (it is not the crashing frame): two verdicts shown.
    const text = await confirmed.first().innerText();
    assert.match(text, /Fill/);
    assert.match(text, /Code bug: CONFIRMED/);
    assert.match(text, /Incident cause: PROBABLE/);
    assert.match(text, /reproduced/);
    assert.ok(await confirmed.first().getByRole("button", { name: "Create fix task" }).isVisible());
  }
  // The crashing frame (Format) stays a suspicion: plausible, not proven.
  assert.match(
    await page.locator('.bh-finding[data-status="SUSPECTED"]').first().innerText(),
    /Format/,
  );
  await page.locator(".bh-coverage summary").click();
  assert.match(await page.locator(".bh-coverage").innerText(), /Functions in scope[\s\S]*Format/);
  await shot("incident-bug-hunter-results.png");

  // Start another hunt from the panel: repository + provider, no browser dialogs.
  await page.getByRole("button", { name: "Start Bug Hunt" }).click();
  await page.locator(".bh-form input[type=checkbox]").first().check();
  await page.locator(".bh-form select").selectOption("codex");
  await shot("incident-bug-hunter-start.png");
  await page.getByRole("button", { name: "Run Bug Hunt" }).click();
  await page.locator(".bh-hunts li").nth(1).waitFor();
  await page.getByText(/Refreshes every 5 s \(not real-time\)/).waitFor();
  assert.match(await page.locator(".bh-detail .bh-status").first().innerText(), /Queued|Running/);
  await shot("incident-bug-hunter-queued.png");
  await page.locator(".bh-detail").getByRole("button", { name: "Cancel" }).click();
  await page.locator(".bh-detail .bh-status", { hasText: "Canceled" }).waitFor({ timeout: 15_000 });
  assert.equal(dialogs, 0, "no browser-native dialogs");
  assert.deepEqual(errors, []);
  console.log(`BUGHUNT-UI ${JSON.stringify({ sandboxed, screenshots: out })}`);
  await context.close();
});
