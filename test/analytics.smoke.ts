/** Isolated, deterministic UI smoke. Run after build with the same local PostgreSQL setup as npm test. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { pool } from "../src/db/pool.ts";
import { analyticsFixtures } from "./analytics.fixtures.ts";
import { handle } from "../src/http/app.ts";

await analyticsFixtures();
const server = createServer(handle);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const out = resolve(process.env.ANALYTICS_SCREENSHOTS || "docs/observability/phase2/screenshots");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const results: string[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1300 } });
  await context.addInitScript(() => {
    if (!localStorage.getItem("hasaki.uiLocale")) localStorage.setItem("hasaki.uiLocale", "en");
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const query = "from=2026-11-01&to=2026-11-03&timezone=UTC&bucket=day&project=OMS";
  await page.goto(`${base}/#/insights/health?${query}`);
  await page.locator('input[name="username"]').fill("analytics-a");
  await page.locator('input[name="password"]').fill("analytics-password");
  await page.locator('button[type="submit"]').click();
  await page.locator(".an-refresh").waitFor();
  for (const tab of ["health", "usage", "performance", "workflows"]) {
    await page.goto(`${base}/#/insights/${tab}?${query}`);
    await page.reload();
    await page.locator(".an-refresh").waitFor();
    assert.equal(await page.getByLabel("Project", { exact: true }).inputValue(), "OMS");
    await page.locator(".an-filter summary").click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `desktop overflow: ${tab}`);
    await page.screenshot({ path: resolve(out, `${tab}-en-desktop.png`), fullPage: true });
    results.push(`PASS ${tab}: rendered aggregate data at 1440px without page overflow`);
  }
  // Applied filters survive tab navigation and refresh through URL state.
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/analytics/usage?")),
    page.getByRole("button", { name: "AI usage & cost", exact: true }).click(),
  ]);
  await page.locator(".an-refresh").waitFor();
  assert.ok(page.url().includes("project=OMS"));
  await page.getByLabel("Agent provider", { exact: true }).selectOption("codex");
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/analytics/usage?") && r.url().includes("provider=codex")),
    page.getByRole("button", { name: "Apply filters", exact: true }).click(),
  ]);
  await page.locator(".an-refresh").waitFor();
  const text = await page.locator(".an .ins-stats").innerText();
  assert.ok(!text.includes("$0"));
  assert.ok(text.includes("—"));
  results.push("PASS filters: Codex keeps missing cost unavailable; filters remain in tab URLs");
  // Responsive and Vietnamese render from the actual application locale switch.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "VI", exact: true }).click();
  await page.locator(".an-refresh").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "mobile overflow");
  await page.locator(".an-filter summary").click();
  await page.screenshot({ path: resolve(out, "usage-vi-mobile.png"), fullPage: true });
  results.push("PASS Vietnamese at 390px without page overflow");
  // Empty and error states use the same real route and retry controls.
  await page.goto(`${base}/#/insights/usage?${query}&provider=codex&model=missing-model`);
  await page.reload();
  await page.locator(".an-refresh").waitFor();
  assert.ok((await page.locator(".an").innerText()).includes("Chưa có dữ liệu"));
  results.push("PASS empty state for an unmatched model filter");
  await page.route("**/api/analytics/performance?**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Smoke test temporary outage" }),
    }),
  );
  await page.goto(`${base}/#/insights/performance?${query}`);
  await page.getByText("Smoke test temporary outage", { exact: false }).waitFor();
  await page.unroute("**/api/analytics/performance?**");
  await page.reload();
  await page.locator(".an-refresh").waitFor();
  results.push("PASS error state and recovery after a simulated HTTP 503");
  assert.deepEqual(errors, []);
  results.push("PASS no browser page errors");
  writeFileSync(resolve(out, "smoke-results.txt"), results.join("\n") + "\n");
  process.stdout.write(results.join("\n") + "\n");
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
}
