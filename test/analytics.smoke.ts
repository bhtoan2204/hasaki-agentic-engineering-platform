/** Real HTTP + isolated PostgreSQL + Chromium verification of production consolidation. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { pool } from "../src/db/pool.ts";
import { analyticsFixtures } from "./analytics.fixtures.ts";
import { handle } from "../src/http/app.ts";
const fixture = await analyticsFixtures();
// The aggregate fixtures also represent one latest scanner result for operational UI checks.
await pool.query("UPDATE prod_error_scans SET preset='custom',namespaces=ARRAY['oms'],groups=2");
await pool.query(
  "UPDATE prod_error_groups SET last_scan_id=(SELECT max(id) FROM prod_error_scans)",
);
const server = createServer(handle);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const out = resolve(process.env.ANALYTICS_SCREENSHOTS || "docs/validation/production-errors");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const results: string[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(() => localStorage.setItem("hasaki.uiLocale", "en"));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/analytics/")) requests.push(r.url());
  });
  const query = "from=2026-11-01&to=2026-11-03&timezone=UTC&bucket=day&project=OMS";
  const go = async (path: string) => {
    await page.goto(`${base}/#${path}`);
  };
  const shot = async (name: string) => {
    // Expand the app's scroll container only while capturing the full document.
    const style = await page.addStyleTag({
      content:
        ".app,.shell,.page{height:auto!important;max-height:none!important;overflow:visible!important}body{overflow:visible!important}",
    });
    await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
    await style.evaluate((el) => el.parentNode?.removeChild(el));
  };
  const active = async () =>
    assert.equal(
      await page.locator('.sb-nav a[href="#/prod-errors"]').getAttribute("aria-current"),
      "page",
    );
  await go(`/insights/health?${query}`);
  await page.locator('input[name="username"]').fill("analytics-a");
  await page.locator('input[name="password"]').fill("analytics-password");
  await page.locator('button[type="submit"]').click();
  await page.locator(".an-health-freshness").waitFor();
  assert.ok(page.url().includes("/prod-errors/overview?"));
  assert.ok(page.url().includes("project=OMS"));
  await active();
  assert.equal(await page.locator(".an-health-kpi").count(), 10);
  await shot("overview-en");
  results.push(
    "PASS legacy Health redirect, ten KPI metrics, all existing charts, active Production Errors sidebar",
  );
  const overviewRequests = requests.filter((url) => url.includes("/health?")).length;
  await page.getByRole("button", { name: "Services", exact: true }).click();
  await page.locator(".an-health-donut").waitFor();
  await active();
  await shot("services-en");
  assert.equal(
    requests.filter((url) => url.includes("/health?")).length,
    overviewRequests,
    "switching Overview to Services reuses analytics data",
  );
  const serviceRequests = requests.filter((url) => url.includes("/health-service?")).length;
  await page.locator(".an-health-donut-legend button").filter({ hasText: "oms-api" }).click();
  await page.getByRole("heading", { name: "oms-api", exact: true }).waitFor();
  assert.ok(page.url().includes("/prod-errors/service?"));
  assert.equal(
    requests.filter((url) => url.includes("/health-service?")).length - serviceRequests,
    1,
    "single service request",
  );
  const serviceUrl = page.url();
  await active();
  await shot("service-details-en");
  await page.locator(".an-service-details button.link-button.mono").first().click();
  await page.locator(".an-prod-incident").waitFor();
  await active();
  await shot("incident-details-en");
  await page.locator(".an-service-back-row a").click();
  await page.getByRole("heading", { name: "oms-api", exact: true }).waitFor();
  assert.equal(page.url(), serviceUrl, "incident return preserves the complete service query");
  await page.locator(".an-service-back-row button").click();
  await page.locator(".an-health-donut").waitFor();
  assert.ok(page.url().includes("/prod-errors/services?"));
  await page.goBack();
  await page.getByRole("heading", { name: "oms-api", exact: true }).waitFor();
  await page.goForward();
  await page.locator(".an-health-donut").waitFor();
  results.push(
    "PASS services comparisons, service and fingerprint drilldowns, one service request, return filters, browser back/forward",
  );
  await page.getByRole("button", { name: "Incidents", exact: true }).click();
  await page
    .locator(".pe-filters")
    .waitFor()
    .catch(async (e) => {
      console.error(await page.locator("body").innerText());
      await shot("failure");
      throw e;
    });
  await page.locator(".pe-head").first().click();
  await page.locator(".pe-body").waitFor();
  await shot("incidents-en");
  await page.locator(".pe-filters input[type=search]").fill("oms");
  await page.waitForURL((url) => url.hash.includes("list_search=oms"));
  await page.reload();
  await page.locator(".pe-filters").waitFor();
  assert.equal(await page.locator(".pe-filters input[type=search]").inputValue(), "oms");
  await page.getByRole("button", { name: "Scan & Settings", exact: true }).click();
  await page.locator(".pe-schedule").waitFor();
  await page.locator(".pe-schedule summary").click();
  await shot("settings-en");
  assert.equal(await page.locator(".pe-filters").count(), 0);
  results.push(
    "PASS operational Incidents, URL list search, scanner status and schedule/notification settings",
  );
  for (const path of [
    `/prod-errors/${fixture.fingerprint}`,
    `/prod-errors/incident/${fixture.fingerprint}`,
  ]) {
    await go(`${path}?${query}`);
    await page.locator(".an-prod-incident").waitFor();
    await active();
  }
  await go(`/insights/health?${query}&view=service&namespace=oms&service=oms-api`);
  await page.locator(".an-service-details").waitFor();
  assert.ok(page.url().includes("/prod-errors/service?"));
  await go(
    `/prod-errors/incident/${fixture.fingerprint}?return_to=${encodeURIComponent("//evil.test")}`,
  );
  await page.locator(".an-prod-incident").waitFor();
  assert.equal(
    await page.locator(".an-service-back-row a").getAttribute("href"),
    "#/prod-errors/incidents",
  );
  results.push(
    "PASS both fingerprint bookmarks, legacy service bookmark, unsafe return URL rejection",
  );
  for (const locale of ["vi", "en"]) {
    await page.getByRole("button", { name: locale.toUpperCase(), exact: true }).click();
    for (const [route, selector] of [
      ["overview", ".an-health-freshness"],
      ["services", ".an-health-donut"],
      ["incidents", ".pe-filters"],
      ["settings", ".pe-schedule"],
      [`service?${query}&namespace=oms&service=oms-api`, ".an-service-details"],
      [`incident/${fixture.fingerprint}`, ".an-prod-incident"],
    ]) {
      await go(`/prod-errors/${route}${route.includes("?") ? "" : `?${query}`}`);
      await page.locator(selector).waitFor();
      if (route === "incidents") {
        await page.locator(".pe-head").first().click();
        await page.locator(".pe-body").waitFor();
      }
      assert.ok(
        !/an\.incident_status|an\.productionTab/.test(await page.locator("main").innerText()),
        "all production labels translated",
      );
      await shot(`${route.split("?")[0].split("/")[0]}-${locale}`);
      for (const width of [1440, 1280, 1024, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth > innerWidth ||
              (!!document.querySelector("main") &&
                document.querySelector("main")!.scrollWidth >
                  document.querySelector("main")!.clientWidth),
          ),
          false,
          `${route} ${locale} overflow at ${width}`,
        );
      }
      await shot(`${route.split("?")[0].split("/")[0]}-${locale}-mobile`);
      await page.setViewportSize({ width: 1440, height: 1100 });
    }
  }
  results.push("PASS all six production views in VI/EN at 1440, 1280, 1024, 768 and 390px");
  // Exercise scanner UI against simulated connection/progress; never start an external Splunk scan.
  let scanning = false;
  let scanPayload: any;
  await page.route("**/api/prod-errors", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.splunk.connected = true;
    data.scanning = scanning;
    data.progress = scanning
      ? {
          phase: "search",
          pct: 40,
          searchPct: 50,
          scanned: 100,
          matched: 12,
          startedAt: new Date().toISOString(),
        }
      : null;
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/prod-errors/scan", async (route) => {
    scanPayload = route.request().postDataJSON();
    scanning = true;
    await route.fulfill({ json: { ok: true } });
  });
  await go(`/prod-errors/settings?${query}`);
  await page.locator(".pe-scan-actions button").click();
  await page.locator(".pe-scanpanel").waitFor();
  for (const locale of ["vi", "en"]) {
    await page.getByRole("button", { name: locale.toUpperCase(), exact: true }).click();
    await shot(`scan-controls-${locale}`);
    await page.setViewportSize({ width: 390, height: 1000 });
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth > innerWidth ||
          (!!document.querySelector("main") &&
            document.querySelector("main")!.scrollWidth >
              document.querySelector("main")!.clientWidth),
      ),
      false,
      "scan controls mobile overflow",
    );
    await shot(`scan-controls-${locale}-mobile`);
    await page.setViewportSize({ width: 1440, height: 1100 });
  }
  await page.locator(".pe-scanpanel").getByRole("button", { name: "Scan", exact: true }).click();
  await page.locator(".sp-card").waitFor();
  assert.equal(
    scanPayload.preset,
    "today",
    "analytics date range must not become scan configuration",
  );
  await shot("scan-progress-en");
  scanning = false;
  await page.unroute("**/api/prod-errors/scan");
  await page.unroute("**/api/prod-errors");
  results.push(
    "PASS manual scan controls, namespace and range choices, progress UI with simulated Splunk connection; scanner range is independent of analytics",
  );
  await go(`/insights?${query}`);
  await page.locator(".an-refresh").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Production health", exact: true }).count(),
    0,
  );
  for (const tab of ["usage", "performance", "workflows"]) {
    await go(`/insights/${tab}?${query}`);
    await page.locator(".an-refresh").waitFor();
    await shot(`insights-${tab}-en`);
  }
  await page.getByRole("button", { name: "VI", exact: true }).click();
  await shot("insights-workflows-vi");
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await page.getByRole("link", { name: "Agent evaluation", exact: true }).click();
  await page.waitForURL("**/insights/evaluation");
  await page.getByRole("heading", { name: /Agent evaluation/i }).waitFor();
  await go("/insights/quality");
  await page.locator(".ins-stats").waitFor();
  results.push(
    "PASS Insights defaults to Usage, contains no Health tab, retains usage/performance/workflows, evaluation and quality navigation",
  );
  await go(`/prod-errors/overview?${query}`);
  await page.locator(".an-health-freshness").waitFor();
  let scanPosts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/prod-errors/scan")) scanPosts++;
  });
  await page.getByLabel("Namespace", { exact: true }).selectOption("oms");
  const filtered = page.waitForResponse(
    (r) => r.url().includes("/api/analytics/health?") && r.url().includes("namespace=oms"),
  );
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  const filteredData = await (await filtered).json();
  assert.equal(Number(filteredData.summary.total_errors), 12);
  assert.equal(Number(filteredData.services[0].error_share_pct), 100);
  assert.equal(scanPosts, 0, "analytics filters must not trigger a scanner request");
  assert.ok(page.url().includes("namespace=oms"));
  results.push(
    "PASS applied production filters, deterministic event/share values, no scan triggered by analytics",
  );
  await page.route("**/api/analytics/health?**", async (route) => {
    await new Promise((r) => setTimeout(r, 250));
    await route.continue();
  });
  const before = await page.locator(".an-health-kpi").count();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  assert.equal(
    await page.locator(".an-health-kpi").count(),
    before,
    "refresh keeps prior metrics visible",
  );
  await page.unroute("**/api/analytics/health?**");
  await go(`/insights/usage?${query}&provider=codex&model=missing-model`);
  await page.locator(".an-refresh").waitFor();
  assert.ok((await page.locator(".an").innerText()).includes("No data"));
  await page.route("**/api/analytics/performance?**", (route) =>
    route.fulfill({ status: 503, json: { error: "Smoke test temporary outage" } }),
  );
  await go(`/insights/performance?${query}`);
  await page.getByText("Smoke test temporary outage", { exact: false }).waitFor();
  await page.unroute("**/api/analytics/performance?**");
  await page.reload();
  await page.locator(".an-refresh").waitFor();
  results.push("PASS unmatched-filter empty state and HTTP error recovery");
  assert.deepEqual(
    errors.filter((e) => e !== "Smoke test temporary outage"),
    [],
  );
  results.push("PASS no full-page refresh flicker or browser errors");
  writeFileSync(resolve(out, "smoke-results.txt"), results.join("\n") + "\n");
  process.stdout.write(results.join("\n") + "\n");
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
}
