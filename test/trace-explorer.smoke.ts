/** Exercise the trace UI against local fixtures; never connect to a database or provider. */
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
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 9, minute)).toISOString();
const makeNode = (
  id: string,
  type: string,
  label: string,
  status: string,
  start: number,
  duration: number,
  stepId?: number,
  attemptId?: number,
  children: unknown[] = [],
) => ({
  id,
  type,
  label,
  status,
  startedAt: at(start),
  durationMs: duration,
  ids: { runId: 42, stepId, attemptId, jobId: attemptId ? attemptId + 100 : null },
  attrs: {
    provider: attemptId ? "antigravity" : null,
    model: attemptId ? "Gemini 3.8 Flash (High)" : null,
    ...(status === "FAILED"
      ? { error: { message: "Repository workspace is held by another run" } }
      : {}),
  },
  children,
});
const tool = makeNode("tool:202:read", "tool", "read_file", "COMPLETED", 7, 120, 2, 202);
const trace = makeNode("run:42", "run", "Run #42", "FAILED", 0, 600000, undefined, undefined, [
  makeNode("step:1", "step", "analyze", "COMPLETED", 0, 120000, 1, undefined, [
    makeNode("attempt:101", "attempt", "Attempt 1", "COMPLETED", 0, 120000, 1, 101),
  ]),
  makeNode("step:2", "step", "implement", "FAILED", 2, 480000, 2, undefined, [
    makeNode("attempt:201", "attempt", "Attempt 1", "COMPLETED", 2, 240000, 2, 201),
    makeNode("attempt:202", "attempt", "Attempt 2", "FAILED", 6, 240000, 2, 202, [tool]),
  ]),
  makeNode("step:3", "step", "review", "PENDING", 10, 0, 3),
]);
const logs = [
  {
    id: 1,
    step_id: 1,
    attempt_id: 101,
    level: "INFO",
    content: "Requirements analysis completed",
    data: { trace: { event: "attempt.finished", provider: "antigravity" } },
    created_at: at(2),
  },
  {
    id: 2,
    step_id: 2,
    attempt_id: 201,
    level: "WARN",
    content: "Retrying workspace preparation",
    data: { trace: { event: "job.retry", provider: "antigravity" } },
    created_at: at(6),
  },
  {
    id: 3,
    step_id: 2,
    attempt_id: 202,
    level: "INFO",
    content: "Reading repository configuration",
    data: { trace: { event: "tool.read_file", provider: "antigravity" } },
    created_at: at(7),
  },
  {
    id: 4,
    step_id: 2,
    attempt_id: 202,
    level: "ERROR",
    content: "Repository workspace is held by another run",
    data: {
      trace: { event: "tool.prepare_branch", provider: "antigravity" },
      details: { repo: "oms-background", conflict: true },
    },
    created_at: at(10),
  },
];
const steps = ["analyze", "implement", "review"].map((key, i) => ({
  id: i + 1,
  key,
  name: key,
  type: "agent",
  config: {},
  status: i === 0 ? "COMPLETED" : i === 1 ? "FAILED" : "PENDING",
  depends_on: i ? ["analyze"] : [],
}));
const run = {
  id: 42,
  title: "Investigate duplicate payment notifications",
  status: "FAILED",
  profile: "STANDARD",
  agent_provider: "antigravity",
  inputs: {},
  graph: { steps },
  steps,
  attempts: [],
  questions: [],
  artifacts: [],
  workspaces: [],
  pull_requests: [],
  allowed_repositories: [],
  selected_repositories: [],
  checkpoints: [],
};
try {
  for (const sample of [
    { locale: "vi", width: 1440, theme: "light" },
    { locale: "en", width: 1440, theme: "dark" },
    { locale: "vi", width: 390, theme: "light" },
  ]) {
    const context = await browser.newContext({ viewport: { width: sample.width, height: 1100 } });
    try {
      await context.addInitScript(({ locale, theme }) => {
        localStorage.setItem("hasaki.uiLocale", locale);
        localStorage.setItem("hasaki.theme", theme);
      }, sample);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url()),
          path = url.pathname;
        assert.ok(
          route.request().method() === "GET" || path.endsWith("/diagnose"),
          "Only read-only diagnosis is permitted",
        );
        let body: unknown = [];
        if (path === "/api/auth/me")
          body = { user: { id: 1, username: "smoke", role: "member" }, csrf: "test" };
        else if (path === "/api/runs/42") body = run;
        else if (path === "/api/runs/42/trace") body = trace;
        else if (path === "/api/runs/42/logs")
          body = logs.filter((row) => row.id > Number(url.searchParams.get("after") ?? 0));
        else if (path === "/api/runs/42/diagnose")
          body = {
            findings: [
              {
                kind: "git_worktree_conflict",
                source: "workflow_engine",
                category: null,
                summary: "Workspace preparation failed",
                suggestion: "Inspect the existing branch lease before retrying.",
                evidence: ["attempt:202", "step:2"],
              },
            ],
          };
        else if (path === "/api/metrics/runs/42")
          body = {
            totals: { attempts: 3, tool_calls: 1, failed: 1, retries: 1 },
            per_step: {},
            wall_ms: 600000,
          };
        else if (path === "/api/runs/42/worker") body = {};
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });
      await page.goto(`${base}/#/runs/42/~trace`);
      await page.locator(".tx-node-pick").filter({ hasText: "Attempt 2" }).waitFor();
      await page.locator(".tx-log-entry").nth(3).waitFor();
      if (sample.width > 900)
        assert.equal(
          await page.locator(".canvas").isVisible(),
          true,
          "Workflow canvas stays beside the trace sidebar",
        );
      assert.equal(await page.locator(".tx-logs").count(), 0, "There is no separate log panel");
      assert.deepEqual(
        await page
          .locator(".tx-log-entry")
          .evaluateAll((nodes) => nodes.map((el) => el.getAttribute("data-log-id"))),
        ["1", "2", "3", "4"],
        "Events are chronological within the tree",
      );
      await page.locator(".rv-inspector").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({
        path: `/tmp/trace-overview-${sample.locale}-${sample.width}-${sample.theme}.png`,
        fullPage: true,
      });
      await page.locator(".tx-overview .tx-problems").click();
      assert.equal(
        await page.locator(".tx-log-entry").count(),
        2,
        "Selecting an attempt scopes its logs",
      );
      assert.equal(await page.locator(".tx-details").count(), 1);
      assert.equal(
        await page
          .locator(".tx-details")
          .evaluate((element) => element.parentElement?.classList.contains("tx-node")),
        true,
        "Details open inside the selected timeline row, before its nested events",
      );
      const selectedAttempt = page.locator('.tx-node-pick[aria-pressed="true"]');
      assert.equal(await selectedAttempt.getAttribute("aria-expanded"), "true");
      assert.equal(
        await page.locator(".tx-details").getAttribute("id"),
        await selectedAttempt.getAttribute("aria-controls"),
      );
      await page.locator(".tx-search input").fill("workspace");
      assert.equal(await page.locator(".tx-log-entry").count(), 1);
      await page.locator(".tx-log-toolbar select").selectOption("ERROR");
      await page.locator(".tx-log-entry > summary").click();
      assert.ok((await page.locator(".tx-log-expanded").innerText()).includes("oms-background"));
      await page.locator(".tx-search input").fill("not-a-real-event");
      assert.equal(await page.locator(".tx-log-entry").count(), 0);
      await page.locator(".tx-log-empty button").click();
      assert.equal(
        await page.locator(".tx-log-entry").count(),
        4,
        "Reset clears text, level and selected scope",
      );
      await page.locator(".tx-actions button").last().click();
      await page.locator(".tx-findings article").waitFor();
      await page.locator(".tx-findings article button").click();
      assert.ok(
        (await page.locator(".tx-details").innerText()).includes("Gemini 3.8 Flash (High)"),
      );
      await page.getByRole("button", { name: /^(Thu gọn|Collapse) Attempt 2$/ }).click();
      assert.equal(
        await page.locator(".tx-log-entry").count(),
        0,
        "Collapsing an attempt hides its nested events",
      );
      await page.getByRole("button", { name: /^(Mở rộng|Expand) Attempt 2$/ }).click();
      assert.deepEqual(
        await page
          .locator(".tx-log-entry")
          .evaluateAll((nodes) => nodes.map((el) => el.getAttribute("data-log-id"))),
        ["3", "4"],
      );
      await page.locator(".tx-node-pick").filter({ hasText: "read_file" }).waitFor();
      await page.locator(".tx-node-pick").filter({ hasText: "read_file" }).click();
      assert.equal(
        await page.locator(".tx-details").count(),
        1,
        "Selecting another row moves the inline details",
      );
      assert.ok(
        await page
          .locator(".tx-node")
          .filter({ has: page.locator('.tx-node-pick[aria-pressed="true"]') })
          .locator(".tx-details")
          .isVisible(),
      );
      await page.locator(".tx-node-pick").filter({ hasText: "read_file" }).click();
      assert.equal(
        await page.locator(".tx-details").count(),
        0,
        "Clicking the selected row again closes details",
      );

      const fits = await page
        .locator(".trace-explorer")
        .evaluate(
          (element) =>
            element.getBoundingClientRect().right <= window.innerWidth + 1 &&
            element.scrollWidth <= element.clientWidth + 1,
        );
      assert.equal(
        fits,
        true,
        "Trace layout stays within the viewport; timeline scroll is contained",
      );
      assert.deepEqual(errors, []);
      await page.screenshot({
        path: `/tmp/trace-explorer-${sample.locale}-${sample.width}-${sample.theme}.png`,
        fullPage: true,
      });
      console.log(
        `PASS trace ${sample.locale} ${sample.width}px ${sample.theme}: selection, search, level, empty state, diagnosis, expand, responsive layout`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
