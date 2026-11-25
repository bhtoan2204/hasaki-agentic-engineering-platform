/**
 * Child workflows on the parent's DAG (production bundle, mocked API; no database or provider): the delegating step
 * carries a badge and says it waits for child workflows (not for the user), each child is a card in a lane under the
 * steps with its mini step strip, and the card's actions (open, start a proposal, cancel, open the pending approval)
 * post only after confirmation. Screenshots: docs/validation/run-delegation-*.png.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
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
    if (!path.startsWith(root + sep)) return void res.writeHead(403).end();
    res
      .writeHead(200, { "Content-Type": mime[extname(path)] ?? "application/octet-stream" })
      .end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const step = (
  key: string,
  name: string,
  status: string,
  depends_on: string[] = [],
  extra: Record<string, unknown> = {},
) => ({
  id: key.length,
  key,
  name,
  type: "agent",
  config: {},
  status,
  depends_on,
  ...extra,
});
const steps = [
  step("analyze", "Analyze incident", "COMPLETED"),
  step("plan", "Plan fixes", "WAITING_INPUT", ["analyze"], {
    pending_input: { child_workflows: [1, 2] },
  }),
  step("report", "Report", "PENDING", ["plan"]),
];
const childSteps = (...st: string[]) =>
  st.map((s, i) => ({ key: `s${i}`, name: `Step ${i + 1}`, type: "agent", status: s }));
const child = (over: Record<string, unknown>) => ({
  workflow: "bug-investigation",
  delegation_status: "started",
  reason: "independent fix with its own review and PR",
  error: null,
  step_key: "plan",
  grandchildren: 0,
  ...over,
});
const run = {
  id: 42,
  title: "Incident REQ-135 — return shipment scan",
  status: "WAITING",
  profile: "STANDARD",
  agent_provider: "claude",
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
  delegation: {
    parent: null,
    children: [
      child({
        id: 1,
        mode: "blocking",
        child_run_id: 101,
        run_status: "RUNNING",
        title: "↳ #42 Fix ListReturnShipment window",
        steps: childSteps("COMPLETED", "COMPLETED", "RUNNING", "PENDING", "PENDING"),
      }),
      child({
        id: 2,
        mode: "blocking",
        child_run_id: 102,
        run_status: "WAITING",
        title: "↳ #42 Verify V1 cron scan scope",
        workflow: "incident-investigation",
        grandchildren: 1,
        steps: childSteps("COMPLETED", "WAITING_APPROVAL", "PENDING"),
      }),
      child({
        id: 3,
        mode: "propose",
        delegation_status: "proposed",
        child_run_id: 103,
        run_status: "PENDING",
        title: "↳ #42 Add VAT adjustment alert",
        steps: childSteps("PENDING", "PENDING"),
      }),
      child({
        id: 4,
        mode: "detached",
        child_run_id: 104,
        run_status: "FAILED",
        title: "↳ #42 Backfill audit",
        error: "child failed: tests red",
        steps: childSteps("COMPLETED", "FAILED"),
      }),
    ],
  },
};
const totals = {
  attempts: 0,
  exec_ms: 0,
  queue_ms: 0,
  human_ms: 0,
  claude_sessions: 0,
  claude_ms: 0,
  turns: 0,
  cost_usd: null,
  cost_unknown: 0,
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  tool_calls: 0,
  tool_ms: 0,
  command_ms: 0,
  integration_calls: 0,
  skills_loaded: 0,
  retries: 0,
  failed: 0,
};
const cost = {
  run_id: 42,
  total: {
    cost_usd: null,
    attempts: 0,
    attempts_without_cost: 0,
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, reasoning: 0 },
  },
  availability: "none",
  wasted: { cost_usd: 0, pct: null, by_reason: {} },
  by_step: [],
  by_model: [],
  budget: {
    run: { limit_usd: null, source: null, used_usd: 0, pct: null, status: "none" },
    work_item: null,
    work_item_id: null,
  },
};

try {
  for (const [locale, width] of [
    ["en", 1440],
    ["vi", 1366],
  ] as const) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      await context.addInitScript(
        (value) => localStorage.setItem("hasaki.uiLocale", value),
        locale,
      );
      const page = await context.newPage();
      const errors: string[] = [];
      const posts: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/api/**", async (route) => {
        const req = route.request();
        const path = new URL(req.url()).pathname;
        if (req.method() === "POST") {
          posts.push(path);
          return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        }
        const body =
          path === "/api/auth/me"
            ? { user: { id: 1, username: "smoke", role: "member" }, csrf: "test" }
            : path === "/api/runs/42"
              ? run
              : path === "/api/metrics/runs/42"
                ? { totals, per_step: {}, agent_provider: "claude", wall_ms: 0 }
                : path === "/api/runs/42/worker"
                  ? {}
                  : path === "/api/runs/42/cost"
                    ? cost
                    : [];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });
      await page.goto(`${base}/#/runs/42`);
      const cards = page.getByTestId("child-workflow-node");
      await cards.first().waitFor();
      assert.equal(await cards.count(), 4, "every child is on the parent's DAG");
      // The delegating step: badge (done/total) and "waiting for child workflows", not "waiting for input".
      const plan = page.locator(".react-flow__node-step", { hasText: "Plan fixes" });
      assert.match(await plan.innerText(), /0\/4/);
      assert.match(
        await plan.innerText(),
        locale === "en" ? /Waiting for child workflows/ : /Chờ workflow con/,
      );
      // Not listed as waiting for the user.
      assert.equal(
        await page
          .locator(".rv-banner", { hasText: locale === "en" ? "Waiting for you" : "Đang chờ bạn" })
          .count(),
        0,
      );
      // Cards: mini strip per child step, progress, mode, grandchildren, error.
      const first = cards.filter({ hasText: "Fix ListReturnShipment window" });
      assert.equal(await first.locator(".gc-seg").count(), 5);
      assert.match(await first.innerText(), locale === "en" ? /2\/5 steps/ : /2\/5 bước/);
      assert.match(
        await cards.filter({ hasText: "Backfill audit" }).innerText(),
        /child failed: tests red/,
      );
      assert.equal(
        await page.locator(".react-flow__edge").count(),
        3,
        "2 step edges + 1 dashed trunk from the delegating step to the lane",
      );
      // Lane under the steps: every card below every step node, no overlap.
      const boxes = await page.evaluate(() => {
        const r = (sel: string) =>
          [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect());
        return { steps: r(".react-flow__node-step"), cards: r(".react-flow__node-child") };
      });
      const lowestStep = Math.max(...boxes.steps.map((b) => b.bottom));
      assert.ok(
        boxes.cards.every((c) => c.top > lowestStep),
        "child lane is under the steps",
      );
      for (let i = 0; i < boxes.cards.length; i++)
        for (let j = i + 1; j < boxes.cards.length; j++) {
          const a = boxes.cards[i],
            b = boxes.cards[j];
          assert.ok(
            a.right <= b.left + 1 ||
              b.right <= a.left + 1 ||
              a.bottom <= b.top ||
              b.bottom <= a.top,
            "cards do not overlap",
          );
        }
      // Actions: approval opens the child at its step; start / cancel post only after confirmation.
      await cards
        .filter({ hasText: "Verify V1 cron scan scope" })
        .getByRole("button", { name: locale === "en" ? /Needs approval/ : /Cần duyệt/ })
        .click();
      await page.waitForURL((u) => u.hash === "#/runs/102/s1");
      await page.goBack();
      await cards.first().waitFor();
      await cards
        .filter({ hasText: "Add VAT adjustment alert" })
        .getByRole("button", { name: locale === "en" ? "Start" : "Bắt đầu" })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      assert.deepEqual(posts, [], "nothing posted before confirmation");
      await dialog.getByRole("button", { name: locale === "en" ? "Start" : "Bắt đầu" }).click();
      await page.waitForFunction(() => true);
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(posts, ["/api/runs/103/start"]);
      await cards
        .filter({ hasText: "Fix ListReturnShipment window" })
        .getByRole("button", { name: locale === "en" ? "Cancel" : "Huỷ" })
        .click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: locale === "en" ? "Cancel" : "Huỷ" })
        .last()
        .click();
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(posts.at(-1), "/api/runs/101/cancel");
      assert.equal(
        await cards
          .filter({ hasText: "Backfill audit" })
          .getByRole("button", { name: locale === "en" ? "Cancel" : "Huỷ" })
          .count(),
        0,
        "no cancel on a finished child",
      );
      await page
        .locator(".canvas")
        .screenshot({ path: `docs/validation/run-delegation-${locale}-${width}.png` });
      assert.deepEqual(errors, [], locale);
      console.log(
        `PASS ${locale} @${width}px: children on the DAG, badge and wait state, mini strips, confirmed actions`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
