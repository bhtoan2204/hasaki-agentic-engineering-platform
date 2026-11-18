/**
 * Render the production bundle with harness, checkpoint and replay data: run view pills and reuse card, step inspector
 * cards, and the replay preview overlay. No database, real session or provider calls; every request must be a GET.
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

const at = (s: number) => new Date(Date.UTC(2026, 10, 18, 3, 0, s)).toISOString();
const steps = [
  {
    id: 1,
    key: "analyze",
    name: "Analyze",
    type: "agent",
    config: {},
    status: "COMPLETED",
    depends_on: [],
    generation: 2,
    current_attempt_id: 11,
  },
  {
    id: 2,
    key: "implement",
    name: "Implement",
    type: "agent",
    config: {},
    status: "PENDING",
    depends_on: ["analyze"],
    generation: 1,
    current_attempt_id: 20,
  },
];
const decision = (id: number, over: Record<string, unknown>) => ({
  id,
  step_id: 1,
  step_key: "analyze",
  attempt_id: 11,
  generation: 2,
  kind: "replay",
  action: "REUSE",
  outcome: "applied",
  reason: "compatible execution result reused",
  source_attempt_id: 10,
  latency_ms: 42,
  checkpoint_bytes: null,
  saved_invocations: 2,
  saved_tokens: 1500,
  saved_cost_usd: 0.01,
  saved_ms: null,
  details: {},
  created_at: at(5),
  ...over,
});
const decisions = [
  decision(1, {}),
  decision(2, {
    kind: "checkpoint",
    action: "RECORD",
    checkpoint_bytes: 4096,
    saved_invocations: null,
    saved_tokens: null,
  }),
  decision(3, {
    step_id: 2,
    step_key: "implement",
    attempt_id: 20,
    generation: 1,
    kind: "recovery",
    action: "REQUIRES_RECONCILIATION",
    reason: "worker lease expired",
    source_attempt_id: null,
    saved_invocations: null,
    saved_tokens: null,
  }),
];
const run = {
  id: 42,
  title: "Execution observability",
  status: "RUNNING",
  profile: "STANDARD",
  agent_provider: "codex",
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
  decisions,
  worker: { local: true, available: true, health: "ONLINE" },
};
const envelopeView = {
  id: 7,
  attempt_id: 11,
  reason: "executor_returned",
  kind: "recoverable",
  created_at: at(4),
  compatibility: "compatible",
  note: null,
  evidence: {
    workspace: {
      fingerprint: "fp-0123456789abcdef",
      unavailable: false,
      artifact_id: 9,
      bytes: 2048,
    },
    context: { snapshot_id: 3, context_hash: "ctx-0123456789" },
    verification: { digest: "ver-0123456789", artifact_ids: [], passed: true },
    completed_actions: [],
  },
};
const stepDetail = {
  step: steps[0],
  attempts: [
    {
      id: 11,
      number: 1,
      generation: 2,
      status: "COMPLETED",
      started_at: at(1),
      finished_at: at(5),
      metrics: {},
      input: {},
      reused_from_attempt_id: 10,
    },
  ],
  questions: [],
  checkpoints: [
    {
      id: 6,
      attempt_id: 11,
      reason: "progress",
      data: { note: "read the spec" },
      created_at: at(2),
    },
    { id: 7, attempt_id: 11, reason: "executor_returned", data: {}, created_at: at(4) },
  ],
  checkpoint_view: [
    {
      id: 6,
      attempt_id: 11,
      reason: "progress",
      kind: "note",
      created_at: at(2),
      compatibility: null,
      note: "read the spec",
      evidence: null,
    },
    envelopeView,
  ],
  latest_recoverable: envelopeView,
  recovery_action: null,
  artifacts: [
    {
      id: 30,
      attempt_id: 11,
      kind: "harness_evidence",
      name: "agent lifecycle evidence",
      size: 400,
      created_at: at(5),
      data: {
        stages: [
          { stage: "preflight", ms: 120, outcome: "continue" },
          { stage: "execute", ms: 3400, outcome: "continue" },
          { stage: "finalize", ms: 20, outcome: "completed" },
        ],
        checkpoint: { source: "session_resume" },
        tool_calls: { used: 12, limit: 400 },
        guarantees: { unmet: [], degraded: [] },
      },
    },
  ],
  sessions: [],
  snapshots: [],
  jobs: [],
  handoffs: [],
  decisions: decisions.filter((d) => d.step_id === 1),
};
const preview = {
  can_reexecute: true,
  continuation: null,
  steps: [
    {
      key: "analyze",
      action: "FORCE_REEXECUTE",
      reason: "target",
      invalidated: true,
      estimate: null,
    },
    {
      key: "implement",
      action: "REUSE",
      reason: "unchanged inputs",
      conditional: true,
      invalidated: true,
      source_attempt_id: 20,
      estimate: { invocations: 3, tokens: 9000, cost_usd: 0.1 },
    },
  ],
  summary: {
    actions: { FORCE_REEXECUTE: 1, REUSE: 1 },
    estimated_avoided: { invocations: 3, tokens: 9000, cost_usd: 0.1 },
  },
};

const totals = {
  attempts: 1,
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
        assert.equal(route.request().method(), "GET", "Smoke must never mutate execution state");
        const path = new URL(route.request().url()).pathname;
        const body =
          path === "/api/auth/me"
            ? { user: { id: 1, username: "smoke", role: "member" }, csrf: "test" }
            : path === "/api/runs/42"
              ? run
              : path === "/api/runs/42/steps/analyze"
                ? stepDetail
                : path === "/api/runs/42/steps/analyze/replay-preview"
                  ? preview
                  : path === "/api/metrics/runs/42"
                    ? { totals, per_step: {}, agent_provider: "codex", wall_ms: 0 }
                    : path === "/api/runs/42/worker"
                      ? { health: "ONLINE" }
                      : path === "/api/runs/42/cost"
                        ? null
                        : [];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });

      // Run view: decision pills on nodes and the reuse card in the overview.
      await page.goto(`${base}/#/runs/42`);
      await page.locator(".ec-reuse").waitFor();
      assert.match(await page.locator(".ec-reuse").innerText(), /1500|1,500|1\.500/);
      await page.locator(".gn-pill-decision").first().waitFor();
      const pills = await page.locator(".gn-pill-decision").allInnerTexts();
      assert.equal(
        pills.length,
        2,
        `${locale}: one pill per decided step, checkpoint records excluded`,
      );

      // Step inspector: milestones vs notes, evidence, harness stages, decisions.
      await page.goto(`${base}/#/runs/42/analyze`);
      await page.locator(".ec-checkpoints").waitFor();
      assert.equal(
        await page.locator(".ec-milestone").count(),
        1,
        "only recoverable checkpoints are milestones",
      );
      assert.equal(
        await page.locator(".ec-notes .ec-note").count(),
        1,
        "progress notes stay in the notes group",
      );
      assert.match(await page.locator(".ec-latest").innerText(), /2\.0 KB/);
      assert.equal(await page.locator(".ec-harness-stage").count(), 3);
      assert.ok((await page.locator(".ec-decision").count()) >= 1);

      // Replay preview: opening the dialog colours DAG nodes by their planned decision.
      assert.equal(await page.locator(".gn-pill-preview").count(), 0);
      await page
        .getByRole("button", { name: locale === "en" ? /re-execute/i : /chạy lại/i })
        .first()
        .click();
      await page.locator(".ec-preview-step").first().waitFor();
      await page.locator(".gn-pill-preview").first().waitFor();
      assert.equal(await page.locator(".gn-pill-preview").count(), 2);
      assert.match(await page.locator(".ec-preview-summary").innerText(), /9[.,]?000/);

      assert.deepEqual(errors, [], locale);
      console.log(
        `PASS ${locale}: decisions, checkpoints, harness stages and replay preview are visible`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
