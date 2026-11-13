/** Exercise long work-item settings without a database, real login or provider calls. */
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
    const body = await readFile(path);
    res
      .writeHead(200, { "Content-Type": mime[extname(path)] ?? "application/octet-stream" })
      .end(body);
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
const workflows = [
  {
    key: "feature-implementation",
    name: "Feature implementation",
    description: "Implement a reviewed change",
    latest_version: 1,
  },
];
try {
  for (const sample of [
    { locale: "vi", width: 1440 },
    { locale: "en", width: 1024 },
    { locale: "vi", width: 390 },
  ]) {
    const context = await browser.newContext({ viewport: { width: sample.width, height: 900 } });
    try {
      await context.addInitScript(
        (locale) => localStorage.setItem("hasaki.uiLocale", locale),
        sample.locale,
      );
      const page = await context.newPage();
      const errors: string[] = [];
      const updates: unknown[] = [];
      const item = {
        id: 42,
        code: "REQ-42",
        title: "Investigate a work item with a very long request and execution history",
        status: "open",
        source: "manual",
        project: "OMS",
        automation_policy: null,
        description: Array.from(
          { length: 100 },
          (_, i) =>
            `### Requirement ${i + 1}\nKeep the request readable and retain the original business behavior.\n`,
        ).join("\n"),
        description_source: "manual",
        payload: {},
        runs: [],
        pull_requests: [],
        prod_errors: [],
        legacy: {
          questions: [],
          events: Array.from({ length: 120 }, (_, i) => ({
            id: i + 1,
            kind: "note",
            content: `History entry ${i + 1}: Checked repository configuration and documented the investigation result.`,
            created_at: "2026-01-01T09:00:00Z",
          })),
        },
      };
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const method = route.request().method();
        let body: unknown = [];
        if (path === "/api/auth/me")
          body = { user: { id: 1, username: "smoke", role: "member" }, csrf: "test" };
        else if (path === "/api/work-items/42") {
          if (method !== "GET") {
            const update = route.request().postDataJSON();
            assert.deepEqual(
              update,
              { status: "done" },
              "Only the deliberate status change may update the item",
            );
            updates.push(update);
            item.status = update.status;
          }
          body = item;
        } else if (path === "/api/workflows") body = workflows;
        else if (path === "/api/workflows/route") body = { workflow: "feature-implementation" };
        else if (path === "/api/runs/preview")
          body = {
            profile: { profile: "STANDARD", confidence: 0.9, reasons: [], warnings: [] },
            graph: { steps: [] },
            published_steps: 0,
          };
        else assert.equal(method, "GET", "The smoke must not start a run or modify other state");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });
      await page.goto(`${base}/#/work-items/42`);
      const trigger = page.locator(".wi-item-toolbar button");
      await trigger.waitFor();
      assert.equal(await trigger.getAttribute("aria-haspopup"), "dialog");
      await trigger.click();
      await page.getByRole("dialog").waitFor();
      assert.equal(await page.locator(".wi-settings-body select").inputValue(), "open");
      await page.keyboard.press("Escape");
      assert.equal(await page.getByRole("dialog").count(), 0);
      assert.equal(
        await trigger.evaluate((button) => document.activeElement === button),
        true,
        "Escape returns focus to Settings",
      );
      await page.locator(".wi-legacy > summary").click();
      const scroller = page.locator(".page");
      await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const scrollTop = await scroller.evaluate((element) => element.scrollTop);
      assert.ok(scrollTop > 1000, "Fixture must contain a long scrollable page");
      const bounds = await trigger.boundingBox();
      assert.ok(
        bounds && bounds.y >= 59 && bounds.y + bounds.height <= 900,
        "Settings remains visible at the bottom of long content",
      );
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await dialog.evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );
      const drawerBounds = await dialog.boundingBox();
      assert.ok(
        drawerBounds &&
          drawerBounds.x >= 0 &&
          drawerBounds.x + drawerBounds.width <= sample.width + 1,
        "Settings fits the screen",
      );
      assert.deepEqual(updates, [], "Opening settings never changes item state");
      await page.screenshot({
        path: `/tmp/work-item-settings-${sample.locale}-${sample.width}.png`,
        fullPage: true,
      });
      const saved = page.waitForResponse(
        (response) =>
          response.url().includes("/api/work-items/42") && response.request().method() !== "GET",
      );
      await page.locator(".wi-settings-body select").selectOption("done");
      await saved;
      assert.deepEqual(updates, [{ status: "done" }]);
      await page.keyboard.press("Escape");
      assert.equal(await page.getByRole("dialog").count(), 0);
      assert.ok(
        Math.abs((await scroller.evaluate((element) => element.scrollTop)) - scrollTop) <= 1,
        "Closing Settings preserves reading position",
      );
      assert.deepEqual(errors, []);
      console.log(
        `PASS work item ${sample.locale} ${sample.width}px: sticky settings, drawer, keyboard, saved status, preserved scroll`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
