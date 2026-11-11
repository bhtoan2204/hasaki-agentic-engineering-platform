/** Isolated UI smoke: synthetic data, no provider calls. Run after npm run build. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { createUser } from "../src/auth/users.ts";
import { startRun } from "../src/workflow/engine.ts";
import { handle } from "../src/http/app.ts";

await migrate();
const owner = await createUser({
  username: "orchestration-smoke",
  password: "orchestration-password",
  role: "admin",
});
await definitions.create({
  key: "mixed-provider-smoke",
  spec: {
    name: "Mixed provider workflow",
    steps: [
      {
        key: "research",
        name: "Research",
        type: "agent",
        config: { agent: { provider: "claude", model: "sonnet" } },
      },
      {
        key: "implement",
        name: "Implement",
        type: "coding_agent",
        depends_on: ["research"],
        config: { agent: { provider: "codex", model: null, execution_profile: "STANDARD" } },
      },
      {
        key: "verify",
        name: "Verify",
        type: "agent",
        depends_on: ["implement"],
        config: { agent: { provider: "cursor" } },
      },
    ],
  },
});
const run = await startRun({
  definitionKey: "mixed-provider-smoke",
  ownerId: owner.id,
  start: false,
  profile: "STANDARD",
});
const server = createServer(handle);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const output = resolve("docs/orchestration/phase4/screenshots");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const evidence: string[] = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await ctx.addInitScript(() => localStorage.setItem("hasaki.uiLocale", "en"));
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/#/workflows/mixed-provider-smoke`);
  await page.locator('input[name="username"]').fill("orchestration-smoke");
  await page.locator('input[name="password"]').fill("orchestration-password");
  await page.locator('button[type="submit"]').click();
  await page.locator('.react-flow__node[data-id="implement"]').waitFor();
  assert.match(await page.locator('.react-flow__node[data-id="research"]').innerText(), /Claude/);
  assert.match(await page.locator('.react-flow__node[data-id="implement"]').innerText(), /Codex/);
  assert.match(await page.locator('.react-flow__node[data-id="verify"]').innerText(), /Cursor/);
  await page.locator('.react-flow__node[data-id="implement"]').click();
  await page.getByLabel("Agent provider", { exact: true }).selectOption("codex");
  await page.getByLabel("Provider model", { exact: true }).fill("gpt-test");
  await page
    .getByLabel("Agent provider", { exact: true })
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.locator(".wfe-inspector").evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollTop - 60);
  });
  await page.screenshot({ path: resolve(output, "studio-en.png"), fullPage: true });
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/workflows/mixed-provider-smoke/draft") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  assert.equal((await saved).status(), 200);
  const d = await definitions.get("mixed-provider-smoke");
  assert.equal(d.draft_spec.steps[1].config.agent.model, "gpt-test");
  evidence.push(
    "PASS Studio: Claude, Codex and Cursor DAG labels; provider/model controls persist to a validated draft.",
  );
  await page.goto(`${base}/#/runs/${run.id}/implement`);
  await page.getByText("Agent settings for the next attempt", { exact: true }).waitFor();
  await page.getByText("Agent settings for the next attempt", { exact: true }).click();
  await page.getByLabel("Agent provider", { exact: true }).selectOption("cursor");
  const override = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/runs/${run.id}/steps/implement/agent`) &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save override", exact: true }).click();
  assert.equal((await override).status(), 200);
  await page.getByText("Attempt agent: cursor", { exact: false }).waitFor();
  await page.screenshot({ path: resolve(output, "run-override-en.png"), fullPage: true });
  evidence.push("PASS Run inspector: owner saves pending Cursor override without starting a job.");
  await page.getByRole("button", { name: "VI", exact: true }).click();
  await page.getByText("Cấu hình agent cho lần thử tiếp theo", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, "run-vi.png"), fullPage: true });
  evidence.push(
    "PASS Vietnamese: provider controls and attempt labels render in the existing locale system.",
  );
  assert.deepEqual(errors, []);
  evidence.push("PASS Browser: no uncaught page errors.");
  writeFileSync(resolve(output, "smoke-results.txt"), evidence.join("\n") + "\n");
  console.log(evidence.join("\n"));
} finally {
  await browser.close();
  server.close();
  await pool.end();
}
