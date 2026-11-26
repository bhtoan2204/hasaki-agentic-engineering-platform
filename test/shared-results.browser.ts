/**
 * Shared results on the Code Assessment page, in a real browser (production bundle, real server): a reused result names
 * who ran it, its age, state and reuses; a stale one stays visible with a warning and a Re-run that asks first; a running
 * one says someone else is running it. Screenshots go to $SHARED_RESULTS_SCREENSHOTS when set.
 *
 *   npm run build && node test/run-integration.ts test/shared-results.browser.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { handle } from "../src/http/app.ts";
import { createUser } from "../src/auth/users.ts";
import { repositories } from "../src/repos/service.ts";
import { setRepositoryAccess } from "../src/repos/access.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { codeAssessmentKey, rubricHash, type SharedKey } from "../src/sharing/key.ts";
import { lookupOrStart } from "../src/sharing/service.ts";
import { settleSharedAnalyses } from "../src/sharing/settle.ts";
import { installationId } from "../src/sharing/scope.ts";

let server: Server;
let browser: Browser;
let base = "";
const ids: Record<string, number> = {};
const shots = process.env.SHARED_RESULTS_SCREENSHOTS;
let scope = "";

before(async () => {
  config.sharedResults.codeAssessment = true;
  await migrate();
  await seedTemplates();
  for (const [u, role] of [
    ["sr-admin", "admin"],
    ["sr-alice", "member"],
    ["sr-bob", "member"],
  ] as const)
    ids[u] = Number((await createUser({ username: u, password: `${u}-password`, role })).id);
  scope = await installationId();
  await definitions.create({
    key: "shared-ui-fixture",
    spec: {
      name: "ui fixture",
      steps: [{ key: "assess", type: "command", config: { command: "true" } }],
    },
  });
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  if (shots) mkdirSync(shots, { recursive: true });
});
after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  server?.close();
  await settleBackground();
  await pool.end();
});

async function repo() {
  const name = `sr-repo-${Object.keys(ids).length}-${Date.now() % 100000}`;
  const row = (await repositories.upsert(name, {}))!;
  for (const u of ["sr-alice", "sr-bob"])
    await setRepositoryAccess(row, ids[u], "read", ids["sr-admin"]);
  return name;
}
const keyOf = (name: string): SharedKey =>
  codeAssessmentKey({
    scope,
    repos: [{ repo: name, commit: "a".repeat(40) }],
    focus: "",
    workflow: { key: "codebase-assessment", version: 1 },
    rubricHash: rubricHash({ instructions: "assess" }),
    model: "claude/claude-opus-5-5#cfg:test",
  });
async function claim(name: string) {
  const r = await lookupOrStart({
    key: keyOf(name),
    actor: { id: ids["sr-alice"], username: "sr-alice" },
    scopeRepos: [name],
    start: async (tx) =>
      Number(
        (
          await startRun(
            {
              definitionKey: "shared-ui-fixture",
              ownerId: ids["sr-alice"],
              start: false,
              title: "ui",
            },
            tx,
          )
        ).id,
      ),
  });
  assert.equal(r.outcome, "miss");
  return r as { analysis: { id: number }; runId: number };
}
async function publish(name: string) {
  const r = await claim(name);
  await q(pool, "UPDATE workflow_runs SET status = 'COMPLETED' WHERE id = $1", [r.runId]);
  await q(pool, "UPDATE workflow_steps SET status = 'COMPLETED', output = $2 WHERE run_id = $1", [
    r.runId,
    JSON.stringify({ findings: [{ title: "N+1 in order list" }, { title: "missing index" }] }),
  ]);
  await settleSharedAnalyses();
  await settleBackground();
  return r.analysis.id;
}

async function open(locale: "en" | "vi", name: string): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript((l) => localStorage.setItem("hasaki.uiLocale", l), locale);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/#/prod-errors/code-scan`);
  await page.locator('input[name="username"]').fill("sr-bob");
  await page.locator('input[name="password"]').fill("sr-bob-password");
  await page.keyboard.press("Enter");
  const select = page.locator(".cs-form select").nth(1);
  await select.waitFor();
  await page.waitForFunction(
    (n) =>
      [...document.querySelectorAll(".cs-form select option")].some(
        (o) => (o as HTMLOptionElement).value === n,
      ),
    name,
  );
  await select.selectOption(name);
  return { page, errors };
}
const card = (page: Page) => page.locator('[data-testid="shared-analysis"]');

test("a reused result: who ran it, how old, valid, reused count, the result, and Re-run", async () => {
  const name = await repo();
  const id = await publish(name);
  await q(pool, "UPDATE shared_analyses SET reuse_count = 4 WHERE id = $1", [id]);
  const { page, errors } = await open("en", name);
  await card(page).waitFor();
  assert.equal(await card(page).getAttribute("data-state"), "valid");
  const text = await card(page).innerText();
  assert.match(text, /Reused/);
  assert.match(text, /Run by sr-alice/);
  assert.match(text, /seconds ago|minutes ago/);
  assert.match(text, /Reused 4 times/);
  assert.match(text, /Result · 2 items/);
  assert.ok(await page.locator('[data-testid="shared-force"]').isVisible());
  if (shots) await card(page).screenshot({ path: join(shots, "shared-valid-en.png") });
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("a stale result stays visible with a warning and why; Re-run asks before anything starts", async () => {
  const name = await repo();
  const id = await publish(name);
  await q(pool, "UPDATE shared_analyses SET status = 'stale', stale_reason = $2 WHERE id = $1", [
    id,
    `commit_changed:${name}`,
  ]);
  const { page, errors } = await open("en", name);
  await card(page).waitFor();
  assert.equal(await card(page).getAttribute("data-state"), "stale");
  const warn = await page.locator('[data-testid="shared-stale"]').innerText();
  assert.match(warn, /may be outdated/);
  assert.match(warn, new RegExp(`the code changed \\(${name}\\)`));
  await page.locator('[data-testid="shared-force"]').click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Re-run the shared analysis\?/);
  if (shots) await page.screenshot({ path: join(shots, "shared-stale-confirm-en.png") });
  await dialog.getByRole("button", { name: /cancel|hủy/i }).click();
  assert.equal(
    Number(
      (
        await q<{ n: number }>(
          pool,
          "SELECT count(*)::int AS n FROM shared_analyses WHERE scope_repos = $1",
          [[name]],
        )
      )[0].n,
    ),
    1,
    "cancelled: nothing started",
  );
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("someone else running it: the reader is told, with no result and no Re-run (Vietnamese)", async () => {
  const name = await repo();
  await claim(name);
  const { page, errors } = await open("vi", name);
  await card(page).waitFor();
  assert.equal(await card(page).getAttribute("data-state"), "running_other");
  assert.match(await card(page).innerText(), /Đang có người khác chạy/);
  assert.match(
    await page.locator('[data-testid="shared-running"]').innerText(),
    /không cần chạy lại/i,
  );
  assert.equal(await page.locator('[data-testid="shared-force"]').count(), 0);
  if (shots) await card(page).screenshot({ path: join(shots, "shared-running-vi.png") });
  assert.deepEqual(errors, []);
  await page.context().close();
});
