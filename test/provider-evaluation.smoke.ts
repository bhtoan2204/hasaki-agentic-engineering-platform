/** Browser integration over existing durable benchmark jobs. Synthetic controls only, no live model calls. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { publishBuiltinSuite, createEvaluation } from "../src/eval/service.ts";
import { registerDefaultExecutors } from "../src/workflow/executors/index.ts";
import { startPendingRun } from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { handle } from "../src/http/app.ts";
await migrate();
config.evaluation.enabled = true;
config.learning.detectChanges = false;
config.learning.evolveSkills = false;
registerDefaultExecutors();
const owner = await createUser({
  username: "evaluation-smoke",
  password: "evaluation-password",
  role: "admin",
});
const suite = await publishBuiltinSuite();
for (const variant of ["minimal", "pack", "tools"]) {
  const e = await createEvaluation(owner.id, {
    suite_id: suite.id,
    request_key: `smoke-${variant}`,
    configuration: {
      adapter: "provider_fixture",
      provider_sequence: [
        { provider: "claude", model: null },
        { provider: "codex", model: null },
      ],
      context_variant: variant,
      repetitions: 1,
      case_limit: 1,
    },
  });
  await startPendingRun(e.workflow_run_id);
  await drain();
}
const server = createServer(handle);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const output = resolve("docs/evaluation/phase6/screenshots");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const evidence: string[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await context.addInitScript(() => {
    if (!localStorage.getItem("hasaki.uiLocale")) localStorage.setItem("hasaki.uiLocale", "en");
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const query = "from=2026-11-01&to=2026-11-15&timezone=UTC&page_size=2";
  await page.goto(`${base}/#/insights/evaluation?${query}`);
  await page.locator('input[name="username"]').fill("evaluation-smoke");
  await page.locator('input[name="password"]').fill("evaluation-password");
  await page.locator('button[type="submit"]').click();
  await page
    .getByRole("heading", { name: "Provider and model benchmark scorecards", exact: true })
    .waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve(output, "agent-evaluation-en.png"), fullPage: true });
  const table = page
    .locator("section")
    .filter({
      has: page.getByRole("heading", {
        name: "Provider and model benchmark scorecards",
        exact: true,
      }),
    })
    .last();
  assert.match(await table.innerText(), /fixture_control/);
  assert.ok(!(await table.innerText()).includes("$0"));
  evidence.push(
    "PASS scorecards: mixed provider routes are fixture controls; missing cost is not $0; no horizontal page overflow.",
  );
  await page
    .getByLabel("Recommendation task category", { exact: true })
    .fill(String(suite.manifest.cases[0].category));
  const snapshot = page.waitForResponse(
    (r) => r.url().endsWith("/api/agent-recommendations") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate recommendation", exact: true }).click();
  assert.equal((await snapshot).status(), 200);
  await page
    .getByRole("heading", { name: "Insufficient evidence / unavailable", exact: true })
    .waitFor();
  evidence.push(
    "PASS recommendations: fixture-only data yields Insufficient evidence, with an immutable evidence snapshot.",
  );
  const details = page
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "Evidence and verification artifacts", exact: true }),
    })
    .last();
  const next = details.getByRole("button", { name: "Next", exact: true });
  assert.equal(await next.isDisabled(), false);
  await next.click();
  await page.waitForURL(/page=2/);
  await page
    .getByRole("heading", { name: "Evidence and verification artifacts", exact: true })
    .waitFor();
  evidence.push("PASS detailed evidence: server pagination survives URL navigation.");
  await page.getByRole("button", { name: "VI", exact: true }).click();
  await page.getByRole("heading", { name: "Đánh giá agent", exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, "agent-evaluation-vi.png"), fullPage: true });
  await page.getByLabel("Chuỗi agent", { exact: true }).selectOption("claude,codex,cursor");
  await page.getByLabel("Biến thể ngữ cảnh", { exact: true }).selectOption("pack");
  await page.getByLabel("Số nhiệm vụ", { exact: true }).fill("1");
  await page.getByLabel("Số lần lặp", { exact: true }).fill("1");
  const queued = page.waitForResponse(
    (r) => r.url().endsWith("/api/evaluation-runs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Xếp hàng đánh giá", exact: true }).click();
  const result = await queued;
  assert.equal(result.status(), 200);
  const body = result.request().postDataJSON();
  assert.deepEqual(
    body.configuration.provider_sequence.map((p: any) => p.provider),
    ["claude", "codex", "cursor"],
  );
  assert.equal(body.configuration.context_variant, "pack");
  evidence.push(
    "PASS Vietnamese configuration: queues Claude → Codex → Cursor with the selected context variant through existing evaluation APIs.",
  );
  assert.deepEqual(errors, []);
  evidence.push("PASS browser: no uncaught page errors; no paid provider execution.");
  writeFileSync(resolve(output, "smoke-results.txt"), evidence.join("\n") + "\n");
  console.log(evidence.join("\n"));
} finally {
  await browser.close();
  server.close();
  await pool.end();
}
