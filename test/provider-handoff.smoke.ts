/** Actual UI/HTTP and durable jobs, deterministic adapters only; no paid provider calls. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium } from "playwright-core";
import { pool, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { createUser } from "../src/auth/users.ts";
import { startRun } from "../src/workflow/engine.ts";
import { claimJob, processJob } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { setHandoffReadinessForTests } from "../src/agent/handoff.ts";
import { handle } from "../src/http/app.ts";
process.env.CODEX_BIN = join(import.meta.dirname, "fixtures/fake-codex.mjs");
await migrate();
await createUser({
  username: "handoff-smoke-admin",
  password: "handoff-admin-password",
  role: "admin",
});
const owner = await createUser({
  username: "handoff-smoke",
  password: "handoff-password",
  role: "member",
});
await definitions.create({
  key: "handoff-smoke",
  spec: {
    name: "Provider handoff smoke",
    steps: [
      {
        key: "implement",
        name: "Continue implementation",
        type: "coding_agent",
        config: {
          instructions: "Implement idempotent refunds; preserve existing changes",
          agent: { provider: "claude" },
        },
      },
    ],
  },
});
setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
registerExecutor("coding_agent", {
  execute: async (ctx) => {
    if (ctx.attempt.number === 1)
      return {
        kind: "failed",
        error: "Usage limit reached",
        retryable: false,
        details: { provider_error: { code: "quota_exhausted" } },
      };
    assert.equal(ctx.attempt.agent_provider, "codex");
    return {
      kind: "completed",
      output: { summary: "Continuation completed by fixture; verification not reported" },
    };
  },
});
const run = await startRun({
  definitionKey: "handoff-smoke",
  ownerId: owner.id,
  profile: "STANDARD",
});
const first = await claimJob("smoke", 120);
assert.ok(first);
await processJob(first, "smoke", { leaseSeconds: 120, heartbeatSeconds: 1 });
const server = createServer(handle);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const output = resolve("docs/orchestration/phase5/screenshots");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const evidence: string[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  await context.addInitScript(() => {
    if (!localStorage.getItem("hasaki.uiLocale")) localStorage.setItem("hasaki.uiLocale", "en");
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/#/runs/${run.id}/implement`);
  await page.locator('input[name="username"]').fill("handoff-smoke");
  await page.locator('input[name="password"]').fill("handoff-password");
  await page.locator('button[type="submit"]').click();
  await page.getByText("QUOTA_EXHAUSTED", { exact: false }).first().waitFor();
  await page.getByLabel("Target provider", { exact: true }).selectOption("codex");
  await page.getByText("CLI readiness confirmed.", { exact: false }).waitFor();
  const button = page.getByRole("button", { name: "Confirm resume", exact: true });
  assert.equal(await button.isDisabled(), true);
  await page.getByText("Review handoff package and checkpoint", { exact: true }).click();
  await page.screenshot({ path: resolve(output, "handoff-preview-en.png"), fullPage: true });
  await button.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "handoff-confirmation-en.png"), fullPage: true });
  evidence.push(
    "PASS English: quota pause, original provider, handoff checkpoint and availability; confirmation disabled until review acknowledged.",
  );
  await page.getByRole("button", { name: "VI", exact: true }).click();
  await page.getByText("Bàn giao agent", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, "handoff-preview-vi.png"), fullPage: true });
  await page.getByRole("checkbox", { name: /Tôi đã xem checkpoint/ }).check();
  const resumed = page.waitForResponse(
    (r) => r.url().endsWith("/handoff-resume") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Xác nhận tiếp tục", exact: true }).click();
  assert.equal((await resumed).status(), 200);
  const next = await claimJob("smoke-continuation", 120);
  assert.ok(next);
  await processJob(next, "smoke-continuation", { leaseSeconds: 120, heartbeatSeconds: 1 });
  await page.reload();
  await page.getByText("Lịch sử bàn giao và dòng thời gian agent", { exact: true }).waitFor();
  await page.getByText("Lịch sử bàn giao và dòng thời gian agent", { exact: true }).click();
  await page.screenshot({ path: resolve(output, "handoff-history-vi.png"), fullPage: true });
  const handoff = await one(pool, "SELECT * FROM provider_handoffs WHERE run_id=$1", [run.id]);
  assert.equal(handoff.status, "RESUMED");
  assert.equal(handoff.target_provider, "codex");
  assert.ok(handoff.target_attempt_id);
  assert.deepEqual(errors, []);
  evidence.push(
    "PASS Vietnamese: explicit confirmation resumes one Codex attempt in the same run; provider history renders.",
  );
  evidence.push("PASS Browser: no uncaught page errors. Fixture adapters only; no paid calls.");
  writeFileSync(resolve(output, "smoke-results.txt"), evidence.join("\n") + "\n");
  console.log(evidence.join("\n"));
} finally {
  await browser.close();
  server.close();
  setHandoffReadinessForTests(undefined);
  await pool.end();
}
