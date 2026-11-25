/**
 * Unified Incident Workbench in the production bundle (Incidents accordion), against mocked APIs: the Unified RCA
 * summary renders first, progress refreshes while a workflow is active, contradictions / missing evidence / excluded
 * evidence are shown with links, "Create Fix Task" appears only for an eligible cause and posts only after the user
 * confirms, and re-running a completed workflow needs an explicit confirmation. Desktop and phone widths, en and vi.
 * No database, session or provider calls. Screenshots: docs/validation/unified-incident-*.png.
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
    if (!path.startsWith(root + sep)) return void res.writeHead(403).end();
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

const FP = "a".repeat(20);
const now = new Date().toISOString();
const list = {
  day: now.slice(0, 10),
  today: now.slice(0, 10),
  scanning: false,
  progress: null,
  lastScan: {
    ok: true,
    started_at: now,
    finished_at: now,
    groups: 1,
    trigger: "manual",
    error: null,
  },
  lastOk: { started_at: now, finished_at: now },
  ignored: 0,
  settings: { schedule: [], notify: false },
  splunk: { connected: true, expired: false },
  signoz: { connected: true },
  namespaces: [{ namespace: "shop-prod", project: "Shop" }],
  shown: null,
  maxCustomHours: 72,
  groups: [
    {
      fingerprint: FP,
      namespace: "shop-prod",
      service: "pricing",
      level: "ERROR",
      caller: "pricing/discount.go:9",
      signature: "discount applied twice",
      sample: "discount applied twice",
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
    },
  ],
};
const metrics = {
  llm_attempts: 4,
  turns: 8,
  input_tokens: 4000,
  output_tokens: 800,
  cache_read_tokens: 0,
  cost_usd: 0.04,
  cost_availability: "reported",
  attempt_ms: 1000,
  latency_ms: 5000,
};
const loc = { repository: "shop", file: "pricing/discount.go", line_start: 9, function: "Apply" };
const running = {
  investigation_id: 1,
  owner_id: 1,
  fingerprint: FP,
  rca: {
    version: null,
    status: "UNKNOWN",
    reasons: ["no investigation has finished"],
    causes: [],
    conflicts: [],
    verified_defects: [],
    runtime_findings: [],
    missing_evidence: [],
    next_actions: [],
    impact: [],
    excluded: [],
  },
  runtime: {
    run_id: 20,
    status: "RUNNING",
    active: true,
    steps_done: 2,
    steps_total: 10,
    current: "Search Initial Logs",
    outcome: null,
    metrics,
  },
  bug_hunt: null,
  runs: [],
  evidence: [],
  fix_tasks: [],
  versions: [],
  metrics: {
    ...metrics,
    verified_rcas: 0,
    cost_per_verified_rca: null,
    reconciliation_llm_calls: 0,
  },
};
const done = {
  ...running,
  rca: {
    version: 3,
    status: "CONFLICTED",
    reasons: [
      "supported by bug_hunt:1:finding:7 but not supported/disproved by run:20:hypothesis:H9",
    ],
    causes: [
      {
        key: "shop:pricing/discount.go",
        location: loc,
        statement: "business_logic: discount applied twice for stacked coupons",
        level: "confirmed",
        code_fixable: true,
        supporting: ["bug_hunt:1:finding:7"],
        contradicting: ["run:20:hypothesis:H9"],
        defect: "CONFIRMED",
        sources: ["bug_hunt", "runtime"],
      },
      {
        key: "text:abc",
        location: null,
        statement: "partner API returned 503",
        level: "probable",
        code_fixable: false,
        supporting: ["run:20:hypothesis:H2"],
        contradicting: [],
        defect: "UNVERIFIED",
        sources: ["runtime"],
      },
    ],
    conflicts: [
      {
        cause: "shop:pricing/discount.go",
        detail:
          "supported by bug_hunt:1:finding:7 but not supported/disproved by run:20:hypothesis:H9",
        refs: ["bug_hunt:1:finding:7", "run:20:hypothesis:H9"],
      },
    ],
    verified_defects: [
      {
        ref: "bug_hunt:1:finding:7",
        location: loc,
        causality: "CONFIRMED",
        statement: "discount applied twice",
      },
    ],
    runtime_findings: [
      { ref: "run:20:finding:0", statement: "[confirmed] checkout errors started 06:00" },
    ],
    missing_evidence: ["state impact: order DB state for the affected orders"],
    next_actions: [
      { kind: "resolve_conflict", detail: "Cross-check: …", cause: "shop:pricing/discount.go" },
      {
        kind: "create_fix",
        detail: "Create a fix task for shop:pricing/discount.go",
        cause: "shop:pricing/discount.go",
      },
    ],
    impact: ["order_code: 3 (5 failure log lines)"],
    excluded: [
      { ref: "bug_hunt:9:finding:2", reason: "repository not accessible to the workspace owner" },
    ],
  },
  runtime: {
    ...running.runtime,
    status: "COMPLETED",
    active: false,
    steps_done: 10,
    current: null,
    outcome: "UNKNOWN",
  },
  bug_hunt: {
    run_id: 10,
    hunt_id: 1,
    status: "COMPLETED",
    active: false,
    steps_done: 9,
    steps_total: 9,
    current: null,
    outcome: "completed",
    metrics,
  },
  evidence: [{ ref: "bug_hunt:1:finding:7", run_id: 10, stale: false, valid: true }],
  versions: [
    { version: 3, status: "CONFLICTED", created_at: now },
    { version: 2, status: "PROBABLE", created_at: now },
    { version: 1, status: "UNKNOWN", created_at: now },
  ],
  metrics: {
    ...metrics,
    llm_attempts: 9,
    verified_rcas: 0,
    cost_per_verified_rca: null,
    reconciliation_llm_calls: 0,
  },
};

try {
  for (const [locale, width] of [
    ["en", 1280],
    ["vi", 390],
  ] as const) {
    const context = await browser.newContext({ bypassCSP: true, viewport: { width, height: 900 } });
    try {
      await context.addInitScript(
        (value) => localStorage.setItem("hasaki.uiLocale", value),
        locale,
      );
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      let gets = 0;
      const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
      await page.route("**/api/**", async (route) => {
        const req = route.request();
        const path = new URL(req.url()).pathname;
        const reply = (body: unknown, status = 200) =>
          route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
        if (req.method() === "POST") {
          const body = JSON.parse(req.postData() || "{}");
          posts.push({ path, body });
          if (path.endsWith("/workbench/runtime") && !body.force)
            return reply(
              {
                error:
                  "runtime RCA run #20 already completed for this incident; re-run explicitly to refresh it",
              },
              409,
            );
          if (path.endsWith("/workbench/runtime")) return reply({ created: true, run_id: 21 });
          if (path.endsWith("/workbench/fix"))
            return reply({ created: true, run_id: 30, work_item_id: 5 });
          return reply({ error: "unexpected" }, 400);
        }
        if (path === "/api/auth/me")
          return reply({ user: { id: 1, username: "smoke", role: "member" }, csrf: "test" });
        if (path === "/api/prod-errors") return reply(list);
        if (path === `/api/prod-errors/${FP}/workbench`)
          return reply(++gets === 1 ? running : done);
        return reply([]);
      });

      await page.goto(`${base}/#/prod-errors/incidents?list_focus=${FP}`);
      const wb = page.getByTestId("incident-workbench");
      await wb.waitFor();
      // The Unified RCA summary is the first thing in the accordion body.
      assert.equal(
        await page.locator(".pe-body > *").first().getAttribute("data-testid"),
        "incident-workbench",
      );
      assert.equal(await wb.locator("> *").first().getAttribute("data-testid"), "wb-summary");
      assert.match(await page.getByTestId("wb-runtime").innerText(), /2\/10/);
      // Polling while a workflow is active refreshes progress and findings without a reload.
      await page
        .getByTestId("wb-status")
        .filter({ hasText: locale === "en" ? "CONFLICTED" : "MÂU THUẪN" })
        .waitFor({ timeout: 12_000 });
      assert.match(await page.getByTestId("wb-runtime").innerText(), /10\/10/);
      assert.match(await page.getByTestId("wb-hunt").innerText(), /COMPLETED/);
      assert.match(await page.getByTestId("wb-conflicts").innerText(), /run:20:hypothesis:H9/);
      assert.match(await page.getByTestId("wb-missing").innerText(), /order DB state/);
      assert.equal(await page.getByTestId("wb-cause").count(), 2);
      assert.ok(
        await wb.locator('a[href="#/runs/20"]').count(),
        "evidence links to its source run",
      );
      assert.ok(await wb.locator('a[href="#/runs/10"]').count());
      assert.match(
        await page.getByTestId("wb-total").innerText(),
        locale === "en" ? /0 LLM calls/ : /0 lượt gọi LLM/,
      );
      // Create Fix Task: only on the eligible cause; nothing posted until the user confirms.
      const fixLabel = locale === "en" ? "Create Fix Task" : "Tạo task sửa lỗi";
      assert.equal(
        await page.getByTestId("wb-cause").nth(0).getByRole("button", { name: fixLabel }).count(),
        1,
      );
      assert.equal(
        await page.getByTestId("wb-cause").nth(1).getByRole("button", { name: fixLabel }).count(),
        0,
        "provider cause: no fix button",
      );
      await page.getByTestId("wb-cause").nth(0).getByRole("button", { name: fixLabel }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      assert.equal(posts.length, 0, "no request before confirmation");
      await dialog.getByRole("button", { name: locale === "en" ? "Cancel" : "Huỷ" }).click();
      assert.equal(posts.length, 0, "cancel posts nothing");
      await page.getByTestId("wb-cause").nth(0).getByRole("button", { name: fixLabel }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: locale === "en" ? "Create task" : "Tạo task" })
        .click();
      await page.waitForFunction(() => true);
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(posts.at(-1), {
        path: `/api/prod-errors/${FP}/workbench/fix`,
        body: { cause_key: "shop:pricing/discount.go", confirm: true },
      });
      // Re-running a completed workflow asks first, then sends force.
      await wb
        .getByRole("button", { name: locale === "en" ? "Run Runtime RCA" : "Chạy Runtime RCA" })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: locale === "en" ? "Re-run" : "Chạy lại" })
        .click();
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(
        posts.slice(-2).map((p) => p.body),
        [{}, { force: true }],
      );
      // No horizontal page overflow at this width.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.ok(overflow <= 1, `horizontal overflow ${overflow}px at ${width}px`);
      // The workbench itself fits its container (a clipped parent would hide overflow from the page check).
      const fit = await wb.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const p = el.parentElement!.getBoundingClientRect();
        const wide = [...el.querySelectorAll("*")].filter(
          (c) => c.getBoundingClientRect().right > r.right + 1,
        ).length;
        return { right: r.right, parent: p.right, wide };
      });
      assert.ok(fit.right <= fit.parent + 1, `workbench wider than its container at ${width}px`);
      assert.equal(fit.wide, 0, `${fit.wide} element(s) overflow the workbench at ${width}px`);
      await wb.screenshot({ path: `docs/validation/unified-incident-${locale}-${width}.png` });
      assert.deepEqual(errors, [], locale);
      console.log(
        `PASS ${locale} @${width}px: summary first, live progress, conflicts/missing/excluded with links, confirmed fix and re-run`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
