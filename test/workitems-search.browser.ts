/** UI-only regression with mocked APIs; no real accounts, credentials or database queries. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { handle } from "../src/http/app.ts";
import { pool } from "../src/db/pool.ts";
const server = createServer(handle);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/stream") return route.fulfill({ contentType: "text/event-stream", body: 'event: hello\ndata: {}\n\n' });
    const body = path === "/api/auth/me" ? { user: { id: 123, username: "toan", role: "member" }, csrf: "mock" }
      : path === "/api/work/status" ? { browserMode: "hosted", connectionState: "idle", loggedIn: false }
      : path === "/api/work-items" ? [{ id: 1, code: "WI-1", title: "Search regression", source: "manual", status: "open", project: "Test", run_count: 0 }]
      : path === "/api/meta" ? {} : [];
    await route.fulfill({ json: body });
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/#/work-items`;
  await page.goto(url);
  const search = page.getByRole("searchbox");
  await search.waitFor();
  assert.equal(await search.inputValue(), "");
  assert.equal(await search.getAttribute("autocomplete"), "off");
  assert.equal(await search.getAttribute("name"), "workspace-search");
  const token = page.locator('input[name="hasaki-work-api-token"]');
  await token.waitFor();
  assert.ok(await token.evaluate((el) => !!(el as HTMLInputElement).form));
  assert.ok(await search.evaluate((el) => !(el as HTMLInputElement).form));
  await search.fill("regression");
  await page.locator(".wi-row").waitFor();
  await search.fill("no-match");
  await page.locator(".wi-row").waitFor({ state: "hidden" });
  await search.fill("");
  await page.locator(".wi-row").waitFor();
  await token.fill("mock-input-only");
  assert.equal(await search.inputValue(), "");
  await page.reload();
  await search.waitFor();
  assert.equal(await search.inputValue(), "");
  console.log("PASS: empty search after load/refresh, filtering and clear, token form isolated from search; APIs mocked.");
} finally { await browser.close(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await pool.end(); }
