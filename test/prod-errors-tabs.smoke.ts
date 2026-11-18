/**
 * Render the production bundle's incident list with log and trace groups: the Logs and Traces tabs split them, the
 * Traces tab lists every severity by default, and a trace group shows span labels and its trace id. No database,
 * session or provider calls; every request must be a GET.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";

const root = resolve("web/dist");
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  try {
    const path = resolve(
      root,
      "." + (req.url === "/" ? "/index.html" : new URL(req.url!, "http://local").pathname),
    );
    if (!path.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    res
      .writeHead(200, { "Content-Type": mime[extname(path)] ?? "application/octet-stream" })
      .end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const now = new Date().toISOString();
const group = (fingerprint: string, over: Record<string, unknown>) => ({
  fingerprint,
  namespace: "oms-prod",
  service: "oms-api",
  level: "ERROR",
  caller: "usecases/order.go:88",
  signature: "create order failed",
  sample: "create order failed",
  detail: { sources: ["splunk"] },
  today_count: 40,
  yesterday_count: 2,
  first_at: now,
  last_at: now,
  severity: "high",
  reasons: [],
  status: "open",
  work_item_id: null,
  work_item_code: null,
  work_item_title: null,
  work_item_status: null,
  run_id: null,
  run_status: null,
  pull_requests: [],
  ...over,
});
const data = {
  day: now.slice(0, 10),
  today: now.slice(0, 10),
  scanning: false,
  progress: null,
  lastScan: {
    ok: true,
    started_at: now,
    finished_at: now,
    groups: 3,
    trigger: "manual",
    error: null,
  },
  lastOk: { started_at: now, finished_at: now },
  ignored: 0,
  settings: { schedule: [], notify: false },
  splunk: { connected: true, expired: false },
  signoz: { connected: true },
  namespaces: [{ namespace: "oms-prod", project: "OMS" }],
  shown: null,
  maxCustomHours: 72,
  groups: [
    group("a".repeat(20), {}),
    group("b".repeat(20), {
      service: "oms-background",
      caller: "redis.pipeline client",
      signature: "redis.pipeline client :: ERR unknown subcommand 'setinfo'",
      sample: "redis.pipeline client: ERR unknown subcommand 'setinfo'",
      detail: { sources: ["signoz"], trace_id: "trace-0123456789", no_baseline: true },
      severity: "medium",
      today_count: 75163,
      yesterday_count: 0,
    }),
    group("c".repeat(20), {
      service: "oms-gateway",
      caller: "google.firestore.v1.Firestore/Commit",
      signature: "google.firestore.<n>.Firestore/Commit [<n>] :: Quota exceeded.",
      detail: { sources: ["signoz"], no_baseline: true },
      severity: "low",
      today_count: 200,
      yesterday_count: 0,
    }),
  ],
};

try {
  for (const locale of ["en", "vi"]) {
    const context = await browser.newContext();
    try {
      await context.addInitScript(
        (value) => localStorage.setItem("hasaki.uiLocale", value),
        locale,
      );
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/api/**", async (route) => {
        assert.equal(route.request().method(), "GET", "Smoke must never mutate state");
        const path = new URL(route.request().url()).pathname;
        const body =
          path === "/api/auth/me"
            ? { user: { id: 1, username: "smoke", role: "member" }, csrf: "test" }
            : path === "/api/prod-errors"
              ? data
              : [];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });

      await page.goto(`${base}/#/prod-errors/incidents`);
      await page.locator(".pe-list").waitFor();
      const tabs = page
        .getByRole("group", { name: locale === "en" ? "Error source" : "Nguồn lỗi" })
        .getByRole("button");
      assert.deepEqual(await tabs.allInnerTexts(), ["Logs (1)", "Traces (2)"], locale);
      assert.equal(await page.locator(".pe-row").count(), 1, "the Logs tab lists log groups only");

      await tabs.nth(1).click();
      await page.waitForURL((u) => u.hash.includes("list_source=traces"));
      await page.locator(".pe-row").nth(1).waitFor();
      assert.equal(
        await page.locator(".pe-row").count(),
        2,
        "the Traces tab lists low and medium trace groups",
      );
      await page.locator(".pe-row .pe-head").first().click();
      const body = await page.locator(".pe-body").innerText();
      assert.match(body, /trace-0123456789/);
      assert.match(body, /Span/);
      assert.doesNotMatch(body, /SPL/, "no Splunk query for a trace group");
      assert.ok(
        await page
          .locator(".pe-body")
          .getByRole("button", { name: locale === "en" ? /investigate/i : /điều tra/i })
          .count(),
      );

      await page.goto(`${base}/#/prod-errors/incidents?list_focus=${"c".repeat(20)}`);
      await page.waitForURL((u) => u.hash.includes("list_source=traces"));
      await page.locator(`#pe-${"c".repeat(20)}.is-open`).waitFor();

      assert.deepEqual(errors, [], locale);
      console.log(
        `PASS ${locale}: log and trace groups are split into tabs; trace groups show span details`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
