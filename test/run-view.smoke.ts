/** Render the production bundle with partial telemetry; no database, real session or provider calls. */
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
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const cases = [
  {
    name: "no provider sessions yet",
    input: null,
    output: null,
    cache: null,
    cost: null,
    unknown: 0,
  },
  {
    name: "missing provider usage",
    input: null,
    output: null,
    cache: null,
    cost: null,
    unknown: 1,
  },
  { name: "partial provider usage", input: 123, output: null, cache: null, cost: null, unknown: 1 },
  { name: "reported zero", input: 0, output: 0, cache: 0, cost: 0, unknown: 0 },
  { name: "reported usage", input: 600, output: 40, cache: 10, cost: 0.125, unknown: 0 },
  { name: "partially reported cost", input: 600, output: 40, cache: 10, cost: 0.04, unknown: 1 },
];
try {
  for (const locale of ["vi", "en"])
    for (const sample of cases) {
      const context = await browser.newContext();
      try {
        await context.addInitScript(
          (value) => localStorage.setItem("hasaki.uiLocale", value),
          locale,
        );
        const page = await context.newPage(),
          errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const step = {
          id: 1,
          key: "analyze",
          name: "Analyze",
          type: "agent",
          config: {},
          status: "PENDING",
          depends_on: [],
        };
        const run = {
          id: 42,
          title: "Partial telemetry regression",
          status: "RUNNING",
          profile: "STANDARD",
          agent_provider: "codex",
          inputs: {},
          graph: { steps: [step] },
          steps: [step],
          attempts: [],
          questions: [],
          artifacts: [],
          workspaces: [],
          pull_requests: [],
          allowed_repositories: [],
          selected_repositories: [],
          checkpoints: [],
        };
        const totals = {
          attempts: 0,
          exec_ms: 0,
          queue_ms: 0,
          human_ms: 0,
          claude_sessions: 0,
          claude_ms: 0,
          turns: 0,
          cost_usd: sample.cost,
          cost_unknown: sample.unknown,
          input_tokens: sample.input,
          output_tokens: sample.output,
          cache_read_tokens: sample.cache,
          tool_calls: 0,
          tool_ms: 0,
          command_ms: 0,
          integration_calls: 0,
          skills_loaded: 0,
          retries: 0,
          failed: 0,
        };
        await page.route("**/api/**", async (route) => {
          assert.equal(route.request().method(), "GET", "Smoke must never mutate execution state");
          const path = new URL(route.request().url()).pathname;
          const body =
            path === "/api/auth/me"
              ? { user: { id: 1, username: "smoke", role: "member" }, csrf: "test" }
              : path === "/api/runs/42"
                ? run
                : path === "/api/metrics/runs/42"
                  ? { totals, per_step: {}, agent_provider: "codex", wall_ms: 0 }
                  : path === "/api/runs/42/worker"
                    ? {}
                    : [];
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
          });
        });
        await page.goto(`${base}/#/runs/42`);
        const format = (n: number | null) => (n == null ? "—" : String(n));
        const tokens =
          locale === "en"
            ? `in ${format(sample.input)} · out ${format(sample.output)} · cache ${format(sample.cache)}`
            : `vào ${format(sample.input)} · ra ${format(sample.output)} · cache ${format(sample.cache)}`;
        await page.getByText(tokens, { exact: true }).waitFor();
        if (sample.cost == null || sample.unknown)
          await page
            .getByText(locale === "en" ? /cost not reported/ : /chi phí không được báo cáo/)
            .waitFor();
        else
          await page
            .getByText(new RegExp(`≈\\$${sample.cost.toFixed(3).replace(".", "\\.")}`))
            .waitFor();
        assert.deepEqual(errors, [], `${locale}: ${sample.name}`);
        assert.ok(
          (await page.locator("body").innerText()).includes("Partial telemetry regression"),
        );
        console.log(
          `PASS ${locale}: ${sample.name}; run remains visible and unknown values remain unknown`,
        );
      } finally {
        await context.close();
      }
    }
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
