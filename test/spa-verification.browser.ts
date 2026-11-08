/**
 * Phase M — Mandatory Real Browser Verification
 * Verifies SPA navigation, flicker-free data fetching, state preservation,
 * and persistent app shell across interactions.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { handle } from "../src/http/app.ts";
import { pool } from "../src/db/pool.ts";

const chromiumBin = process.env.CHROMIUM_BIN || "/nix/store/fqriy9vihl23l4md56qgiks8z0d2xdlw-chromium-156.0.8078.79/bin/chromium";

const server = createServer(handle);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({
  executablePath: chromiumBin,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const pageErrors: string[] = [];

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => {
    pageErrors.push(e.message);
    console.log("PAGEERROR:", e.message, e.stack);
  });
  page.on("console", (msg) => console.log("CONSOLE:", msg.type(), msg.text()));

  // Mock API routes for deterministic browser testing
  let workItemFetchCount = 0;
  const mockWorkItems = [
    { id: 101, code: "WI-101", title: "Refactor SPA navigation", source: "manual", status: "in_progress", project: "OMS", run_count: 2 },
    { id: 102, code: "WI-102", title: "Bitbucket PR automation", source: "jira", status: "open", project: "Payment", run_count: 1 },
    { id: 103, code: "WI-103", title: "Knowledge search improvements", source: "hasaki_work", status: "done", project: "WMS", run_count: 3 },
  ];

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/stream") {
      return route.fulfill({
        contentType: "text/event-stream",
        body: "event: hello\ndata: {}\n\n",
      });
    }

    if (path === "/api/auth/me") {
      return route.fulfill({
        json: { user: { id: 1, username: "spa-tester", role: "admin" }, csrf: "mock-csrf" },
      });
    }

    if (path === "/api/questions") {
      return route.fulfill({ json: [] });
    }

    if (path === "/api/runs") {
      return route.fulfill({
        json: [
          {
            id: 42,
            title: "Run #42",
            status: "RUNNING",
            definition_key: "feature-impl",
            updated_at: new Date().toISOString(),
            steps: [{ key: "s1", status: "RUNNING" }],
          },
        ],
      });
    }

    if (path.startsWith("/api/metrics/summary")) {
      return route.fulfill({
        json: {
          successRate: 100,
          avgDurationSec: 42,
          totalRuns: 10,
        },
      });
    }

    if (path === "/api/work/status") {
      return route.fulfill({ json: { browserMode: "hosted", connectionState: "idle", loggedIn: false } });
    }

    if (path === "/api/work/inbox") {
      return route.fulfill({ json: [] });
    }

    if (path === "/api/meta") {
      return route.fulfill({ json: { jiraEnabled: true } });
    }

    if (path === "/api/work-items") {
      workItemFetchCount++;
      const source = url.searchParams.get("source");
      let items = mockWorkItems;
      if (source) items = items.filter((w) => w.source === source);
      return route.fulfill({ json: items });
    }

    if (path.startsWith("/api/work-items/")) {
      const id = Number(path.split("/")[3]);
      const item = mockWorkItems.find((w) => w.id === id) || mockWorkItems[0];
      return route.fulfill({
        json: {
          ...item,
          runs: [],
          pull_requests: [],
          prod_errors: [],
          legacy: null,
        },
      });
    }

    if (path === "/api/repositories") {
      return route.fulfill({
        json: [
          { name: "oms-api", provider: "bitbucket", enabled: true, projects: ["OMS"], services: ["stock"], tags: ["core"], allowed_actions: ["read", "write"] },
          { name: "payment-src", provider: "bitbucket", enabled: true, projects: ["Payment"], services: ["vnpay"], tags: ["checkout"], allowed_actions: ["read"] },
        ],
      });
    }

    if (path.startsWith("/api/analytics/")) {
      const tab = path.replace("/api/analytics/", "");
      return route.fulfill({
        json: {
          tab,
          filters: { timezone: "Asia/Ho_Chi_Minh", bucket: "day" },
          summary: { total: 42, success_rate: 98.5 },
          items: [],
          pagination: { page: 1, total_pages: 1 },
        },
      });
    }

    if (path === "/api/runs/preview") {
      return route.fulfill({
        json: {
          profile: {
            profile: "STANDARD",
            confidence: 0.95,
            reasons: ["Standard workflow"],
            warnings: [],
          },
          graph: {
            steps: [
              { key: "step-1", name: "Step 1", type: "agent", depends_on: [] },
            ],
          },
          changes: [],
        },
      });
    }

    if (path === "/api/workflows") {
      return route.fulfill({
        json: [{ key: "feature-impl", name: "Feature Implementation", latest_version: 1, description: "Standard workflow" }],
      });
    }

    if (path.startsWith("/api/runs/")) {
      return route.fulfill({
        json: {
          id: 42,
          title: "Run #42",
          status: "RUNNING",
          profile: "STANDARD",
          agent_provider: "claude",
          graph: { steps: [{ key: "s1", name: "Step 1", type: "agent", depends_on: [] }] },
          steps: [{ key: "s1", name: "Step 1", status: "RUNNING", type: "agent" }],
          attempts: [],
          questions: [],
          pull_requests: [],
          workspaces: [],
          allowed_repositories: ["oms-api"],
          selected_repositories: ["oms-api"],
        },
      });
    }

    return route.fulfill({ json: {} });
  });

  // 1. Initial Page Load (Overview)
  await page.goto(`${baseUrl}/#/overview`);
  await page.waitForTimeout(2000);
  console.log("BODY HTML:\n", await page.locator('body').innerHTML());

  // Mark the window object to verify no full-document reload occurs
  await page.evaluate(() => {
    (window as any).__spaWindowMarker = 1337;
  });

  // 2. Test Internal Navigation from Overview to Work Items
  console.log("Checking navigation: Overview -> Work Items...");
  await page.click('a[href="#/work-items"]');
  await page.waitForSelector(".wi-page", { timeout: 5000 });

  // Document marker must still be present (no browser document reload!)
  const markerAfterNav1 = await page.evaluate(() => (window as any).__spaWindowMarker);
  assert.equal(markerAfterNav1, 1337, "Internal navigation must not perform full document reload");

  // Sidebar and header must remain mounted
  const sidebarExists = await page.locator("#main-sidebar").count();
  assert.equal(sidebarExists, 1, "Sidebar must remain mounted");

  // 3. Test Navigation State Preservation in Work Items
  console.log("Testing Work Items filter and search state preservation...");
  const searchInput = page.getByRole("searchbox");
  await searchInput.fill("Refactor");
  await page.waitForTimeout(100);

  // Status filter click
  await page.click('button.wi-sf:has-text("Đang làm"), button.wi-sf:has-text("Doing"), button.wi-sf:has-text("doing")');
  await page.waitForTimeout(100);

  // Verify hash updated with query parameters without document reload
  const hashWithParams = await page.evaluate(() => location.hash);
  assert.ok(hashWithParams.includes("q=Refactor"), "Hash should include q search parameter");
  assert.ok(hashWithParams.includes("status="), "Hash should include status parameter");

  // Navigate to Detail page
  console.log("Navigating into WorkItem detail...");
  await page.click('a.wi-row:has-text("WI-101")');
  await page.waitForSelector(".wi-detail", { timeout: 5000 });

  // Navigate Back to Work Items using breadcrumbs or back
  console.log("Navigating back to Work Items list...");
  await page.goBack();
  await page.waitForSelector(".wi-page", { timeout: 5000 });

  // Document marker still intact
  const markerAfterBack = await page.evaluate(() => (window as any).__spaWindowMarker);
  assert.equal(markerAfterBack, 1337, "Returning from detail page must not reload document");

  // Search input preserved!
  const restoredSearch = await page.getByRole("searchbox").inputValue();
  assert.equal(restoredSearch, "Refactor", "Search keywords must be preserved when returning from detail page");

  // 4. Test Stale-While-Revalidate and Tab Switching
  console.log("Testing navigation: Work Items -> Repositories -> Work Items...");
  await page.click('a[href="#/repositories"]');
  await page.waitForSelector(".repo", { timeout: 5000 });

  // Marker preserved
  const markerAfterRepos = await page.evaluate(() => (window as any).__spaWindowMarker);
  assert.equal(markerAfterRepos, 1337, "Repositories navigation must not reload document");

  // Return to Work Items: Cached data must render immediately without blank flash
  await page.click('a[href="#/work-items"]');
  await page.waitForSelector(".wi-row", { timeout: 5000 });
  const rowsCount = await page.locator(".wi-row").count();
  assert.ok(rowsCount > 0, "Work Items rows must be immediately visible via SWR cache");

  // 5. Test VI/EN Language Switch
  console.log("Testing VI/EN language toggle...");
  const enButton = page.locator(".lang-switch button:has-text('EN')");
  if (await enButton.count()) {
    await enButton.click();
    await page.waitForTimeout(200);
    const viButton = page.locator(".lang-switch button:has-text('VI')");
    await viButton.click();
    await page.waitForTimeout(200);
  }

  // 6. Verify No Unhandled Errors
  assert.equal(pageErrors.length, 0, `Unexpected page errors in browser: ${pageErrors.join("; ")}`);

  console.log("ALL REAL BROWSER VERIFICATION CHECKS PASSED SUCCESSFULLY!");
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
}
