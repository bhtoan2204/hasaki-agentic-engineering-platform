/**
 * Render the production bundle's overview with attendance from a stubbed /api/timesheet: balance, forgotten-punch
 * warning, the in-progress day and month navigation; and the connect hint without a Hasaki Work token. No database,
 * session or HR calls; every request must be a GET.
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

const IN = Date.UTC(2026, 10, 2, 1, 30) / 1000;
const day = (date: string, over: Record<string, unknown> = {}) => ({
  date,
  shift: "HC 7",
  check_in: IN,
  check_out: IN + 9 * 3600 + 600,
  kind: "full",
  missing: null,
  session: null,
  late_by: 0,
  early_by: 0,
  worked_seconds: 9 * 3600 + 600,
  target_seconds: 9 * 3600,
  diff_seconds: 600,
  ...over,
});
const sheet = {
  connected: true,
  days: [
    day("2026-11-02"),
    day("2026-11-03", {
      kind: "missing_punch",
      missing: "out",
      check_out: null,
      worked_seconds: 32400,
      diff_seconds: 0,
    }),
    day("2026-11-04", { in_progress: true, check_out: null }),
  ],
  summary: {
    valid_days: 2,
    day_counts: { full: 1, half_leave: 0, missing_punch: 1 },
    half_leave_days: [],
    missing_punch_days: ["2026-11-03"],
    total_worked_seconds: 65400,
    total_target_seconds: 64800,
    difference_seconds: 600,
  },
};

try {
  for (const locale of ["vi", "en"]) {
    for (const connected of [true, false]) {
      const context = await browser.newContext({
        bypassCSP: true,
        viewport: { width: 1280, height: 1000 },
      });
      try {
        await context.addInitScript(
          (value) => localStorage.setItem("hasaki.uiLocale", value),
          locale,
        );
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const months: string[] = [];
        await page.route("**/api/**", async (route) => {
          assert.equal(route.request().method(), "GET", "Smoke must never mutate state");
          const url = new URL(route.request().url());
          if (url.pathname === "/api/timesheet")
            months.push(`${url.searchParams.get("year")}-${url.searchParams.get("month")}`);
          const body =
            url.pathname === "/api/auth/me"
              ? { user: { id: 1, username: "smoke", role: "member" }, csrf: "test" }
              : url.pathname === "/api/timesheet"
                ? connected
                  ? sheet
                  : { connected: false }
                : url.pathname === "/api/metrics/summary"
                  ? {}
                  : [];
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
          });
        });
        await page.goto(`${base}/#/`);
        const card = page.locator(".ov-timesheet");
        await card.waitFor();
        if (!connected) {
          await card.getByRole("link").waitFor();
          assert.match(await card.innerText(), /Hasaki Work/);
          assert.deepEqual(errors, [], locale);
          continue;
        }
        await card.locator(".ts-balance").waitFor();
        assert.match(await card.locator(".ts-balance").innerText(), /\+0h10/);
        assert.match(await card.locator(".ts-alert").innerText(), /03\/11/);
        await card.locator("tbody tr").first().waitFor();
        assert.equal(await card.locator("tbody tr").count(), 3);
        assert.match(
          await card.locator("tbody tr").nth(2).innerText(),
          locale === "vi" ? /Đang trong ca/ : /in progress/i,
        );
        if (process.env.SHOT_DIR)
          await page.screenshot({ path: `${process.env.SHOT_DIR}/timesheet-${locale}.png` });
        const before = months.length;
        await card
          .getByRole("button", { name: locale === "vi" ? "Tháng trước" : "Previous month" })
          .click();
        for (let i = 0; i < 50 && months.length <= before; i++) await page.waitForTimeout(50);
        assert.ok(months.length > before, "the previous month is requested");
        assert.notEqual(months.at(-1), months[0]);
        assert.deepEqual(errors, [], locale);
        console.log(
          `PASS ${locale}: attendance balance, forgotten punch, in-progress day and month navigation`,
        );
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
