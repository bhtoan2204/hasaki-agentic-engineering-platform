/**
 * Performance invariants of the workflow critical path, as deterministic counts (no timing thresholds):
 * bounded SQL per step, one shared readiness reading per run (and a fresh probe before any provider switch), shared
 * readings invalidated by provider failures, idle workers woken by a committed job instead of the next poll, replay
 * invalidation fenced in bulk with per-step history kept, and large GET results compressed only when asked.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { brotliDecompressSync } from "node:zlib";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser } from "../src/auth/users.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, getRun, reexecuteStep } from "../src/workflow/engine.ts";
import { drain, startScheduler } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { conditionExecutor } from "../src/workflow/executors/builtin.ts";
import { setSharedHealthProber, sharedAgentHealth, type AgentHealth } from "../src/agent/health.ts";
import { setHandoffReadinessForTests } from "../src/agent/handoff.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { runtimeMetricsSnapshot } from "../src/runtimeMetrics.ts";
import { handle } from "../src/http/app.ts";
import type { ExecResult } from "../src/workflow/types.ts";
import { config } from "../src/config.ts";

const PROVIDERS = ["claude", "cursor", "codex", "antigravity", "copilot"] as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let probes = 0;
let reading: (p: string) => Pick<AgentHealth, "connected" | "reason"> = () => ({ connected: true });
const prober = async () => {
  probes++;
  return PROVIDERS.map((provider) => ({
    provider,
    quota: "unknown" as const,
    ...reading(provider),
  }));
};
/** What the next agent attempt returns. */
let agentResult: () => ExecResult = () => ({ kind: "completed", output: { summary: "ok" } });
let ownerId = 0;
const ownerName = `wf-perf-${Date.now()}`;

before(async () => {
  await migrate();
  ownerId = (
    await createUser({
      username: ownerName,
      password: "local-test-password",
      role: "admin",
    })
  ).id;
  registerExecutor("condition", conditionExecutor);
  registerExecutor("agent", { execute: async () => agentResult() });
  const steps = (n: number, extra: Record<string, unknown> = {}) => [
    { key: "root", type: "condition", config: { path: "inputs.enabled", equals: true } },
    ...Array.from({ length: n }, (_, i) => ({
      key: `step-${i}`,
      type: "agent",
      depends_on: [i === 0 ? "root" : `step-${i - 1}`],
      config: {
        replay: "context_only",
        agent: { provider: "claude", allowed_tools: ["platform.submit_result"], ...extra },
      },
    })),
  ];
  await definitions.create({
    key: "wf-perf-chain",
    spec: { name: "Perf chain", steps: steps(12) },
  } as never);
  await definitions.create({
    key: "wf-perf-one",
    spec: { name: "Perf one", steps: steps(1) },
  } as never);
  await definitions.create({
    key: "wf-perf-nofallback",
    spec: { name: "Perf no fallback", steps: steps(1, { fallback: { mode: "disabled" } }) },
  } as never);
});
beforeEach(async () => {
  await settleBackground();
  reading = () => ({ connected: true });
  agentResult = () => ({ kind: "completed", output: { summary: "ok" } });
  setHandoffReadinessForTests(undefined);
  setSharedHealthProber(prober);
  probes = 0;
});
after(async () => {
  setSharedHealthProber(undefined);
  setHandoffReadinessForTests(undefined);
  await settleBackground();
  await pool.end();
});

const counter = (name: string) => runtimeMetricsSnapshot().counters[name] as number;
const statements = () => counter("db.statements");

test("a 12-step run: bounded SQL per step, one shared readiness probe, no switch probe", async () => {
  // Warm-up run: one-time work (definition cache, first job of the instance) is not what the budget measures.
  await startRun({ definitionKey: "wf-perf-chain", inputs: { enabled: true }, ownerId });
  await drain();
  await settleBackground();
  const s0 = statements();
  const switches0 = counter("health.switch_probes");
  probes = 0;
  setSharedHealthProber(prober); // a new reading for this run
  const run = await startRun({
    definitionKey: "wf-perf-chain",
    inputs: { enabled: true },
    ownerId,
  });
  await drain();
  await settleBackground();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  const perStep = (statements() - s0) / 13;
  // Measured 2026-11-21: 53.5 statements per step through q()/one() (BEGIN/COMMIT not counted). The budget catches an
  // N+1 regression (a per-step query that grows with the run) without failing on one added check.
  assert.ok(perStep <= 60, `statements per step: ${perStep.toFixed(1)}`);
  assert.equal(probes, 1, `twelve agent admissions share one readiness probe: ${probes}`);
  assert.equal(
    counter("health.switch_probes") - switches0,
    0,
    "no fresh probe while the chosen provider is healthy",
  );
});

test("a reused reading that calls the provider unusable is confirmed by a fresh probe before switching", async () => {
  // The shared reading is stale: claude was logged out, now it is back. The fresh probe keeps claude.
  reading = (p) =>
    p === "claude" ? { connected: false, reason: "logged out" } : { connected: true };
  setSharedHealthProber(prober);
  setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
  setSharedHealthProber(prober); // after the readiness seam changed (it resets the reading)
  await sharedAgentHealth(); // the stale reading is now the shared one
  const switches0 = counter("health.switch_probes");
  let run = await startRun({ definitionKey: "wf-perf-one", inputs: { enabled: true }, ownerId });
  await drain();
  await settleBackground();
  assert.equal(counter("health.switch_probes") - switches0, 1, "one fresh probe before deciding");
  let [step] = await q<{ provider: string | null }>(
    pool,
    "SELECT agent_override->>'provider' AS provider FROM workflow_steps WHERE run_id = $1 AND key = 'step-0'",
    [run.id],
  );
  assert.equal(step.provider, null, "claude kept: the fresh probe found it ready");

  // Logged out for real: the fresh probe agrees, the step moves to the next healthy provider.
  setHandoffReadinessForTests(async (a) =>
    a.provider === "claude"
      ? { ok: false, error: "logged out", quota: "unknown", cost: "unknown" }
      : { ok: true, quota: "unknown", cost: "unknown" },
  );
  setSharedHealthProber(prober);
  run = await startRun({ definitionKey: "wf-perf-one", inputs: { enabled: true }, ownerId });
  await drain();
  await settleBackground();
  [step] = await q(
    pool,
    "SELECT agent_override->>'provider' AS provider FROM workflow_steps WHERE run_id = $1 AND key = 'step-0'",
    [run.id],
  );
  assert.equal(step.provider, "codex", "switched on the fresh probe's evidence");

  // Fallback disabled: never probed, never switched.
  const probes0 = probes;
  run = await startRun({ definitionKey: "wf-perf-nofallback", inputs: { enabled: true }, ownerId });
  await drain();
  await settleBackground();
  assert.equal(probes - probes0, 0);
  [step] = await q(
    pool,
    "SELECT agent_override->>'provider' AS provider FROM workflow_steps WHERE run_id = $1 AND key = 'step-0'",
    [run.id],
  );
  assert.equal(step.provider, null);
});

test("an authentication failure invalidates the shared reading: the next admission probes again", async () => {
  await sharedAgentHealth();
  assert.equal(probes, 1);
  await sharedAgentHealth();
  assert.equal(probes, 1, "reused");
  const invalidated0 = counter("health.invalidated");
  agentResult = () => ({
    kind: "failed",
    error: "authentication failed: not logged in",
    retryable: false,
    details: {
      provider_error: {
        code: "authentication_error",
        message: "Not logged in · Please run /login",
      },
    },
  });
  await startRun({ definitionKey: "wf-perf-one", inputs: { enabled: true }, ownerId });
  await drain();
  await settleBackground();
  // Each failed attempt drops it (the health failover then tries the next provider, which fails the same way here).
  assert.ok(
    counter("health.invalidated") - invalidated0 >= 1,
    "the failure dropped the shared reading",
  );
  const before = probes;
  await sharedAgentHealth();
  assert.equal(probes, before + 1, "the next reader probes");
});

test("idle workers wake on a committed job instead of waiting for the poll", async () => {
  // A 10 s poll: without the wake-up the run's first job (and every lane hand-off) would wait for it.
  const scheduler = startScheduler({
    workers: 2,
    lightWorkers: 1,
    leaseSeconds: 60,
    heartbeatSeconds: 10,
    pollMs: 10_000,
  });
  try {
    await sleep(300); // every lane is idle now
    const empty0 = counter("scheduler.claims_empty");
    const t0 = Date.now();
    const run = await startRun({
      definitionKey: "wf-perf-chain",
      inputs: { enabled: true },
      ownerId,
    });
    for (;;) {
      const r = await getRun(run.id);
      if (r.status === "COMPLETED") break;
      if (Date.now() - t0 > 9_000)
        assert.fail(`run still ${r.status} after 9 s: workers waited for the poll`);
      await sleep(20);
    }
    // Woken workers that find nothing go back to sleep: bounded wasted claims, no busy loop.
    const wasted = counter("scheduler.claims_empty") - empty0;
    assert.ok(wasted <= 3 * 13, `empty claims during the run: ${wasted}`);
  } finally {
    await scheduler.stop();
  }
});

test("replay fences every invalidated step in bulk and keeps each step's own transition and event", async () => {
  const run = await startRun({
    definitionKey: "wf-perf-chain",
    inputs: { enabled: true },
    ownerId,
  });
  await drain();
  await settleBackground();
  const steps0 = await q<{ key: string; generation: number }>(
    pool,
    "SELECT key, generation FROM workflow_steps WHERE run_id = $1",
    [run.id],
  );
  // An open question and a queued job on a descendant are dismissed / canceled by the replay.
  const [mid] = await q<{ id: number }>(
    pool,
    "SELECT id FROM workflow_steps WHERE run_id = $1 AND key = 'step-5'",
    [run.id],
  );
  await q(
    pool,
    "INSERT INTO workflow_questions (run_id, step_id, question, status) VALUES ($1, $2, 'still relevant?', 'open')",
    [run.id, mid.id],
  );
  const events0 = (
    await q(pool, "SELECT 1 FROM workflow_events WHERE run_id = $1 AND kind = 'status'", [run.id])
  ).length;
  const s0 = statements();
  await reexecuteStep(run.id, "root");
  const replayStatements = statements() - s0;
  const [question] = await q<{ status: string }>(
    pool,
    "SELECT status FROM workflow_questions WHERE step_id = $1",
    [mid.id],
  );
  assert.equal(question.status, "dismissed");
  const steps1 = await q<{ key: string; generation: number; status: string }>(
    pool,
    "SELECT key, generation, status FROM workflow_steps WHERE run_id = $1",
    [run.id],
  );
  for (const s of steps1)
    assert.equal(
      s.generation,
      steps0.find((x) => x.key === s.key)!.generation + 1,
      `${s.key} generation bumped once`,
    );
  const invalidatedAttempts = await q(
    pool,
    "SELECT 1 FROM workflow_step_attempts WHERE run_id = $1 AND invalidated_at IS NULL",
    [run.id],
  );
  assert.equal(invalidatedAttempts.length, 0, "every earlier attempt is marked invalidated");
  const statusEvents = (
    await q(pool, "SELECT 1 FROM workflow_events WHERE run_id = $1 AND kind = 'status'", [run.id])
  ).length;
  assert.ok(statusEvents - events0 >= 13, "one status event per invalidated step (history kept)");
  // Measured: 28. Before the bulk fencing: 4 more per invalidated step (~76 for this chain).
  assert.ok(replayStatements <= 40, `replay planning statements: ${replayStatements}`);
  await drain();
  await settleBackground();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
});

test("large GET results are compressed when the client accepts it, never the session routes", async () => {
  const server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const username = ownerName; // the run's owner (another member's run is not visible)
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "local-test-password" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const run = await startRun({
      definitionKey: "wf-perf-chain",
      inputs: { enabled: true },
      ownerId,
    });
    await drain();
    await settleBackground();
    const raw = (encoding?: string) =>
      new Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer }>(
        (resolve, reject) => {
          // node:http, not fetch: fetch would decode transparently.
          import("node:http").then(({ get }) =>
            get(
              `${base}/api/runs/${run.id}`,
              { headers: { cookie, ...(encoding ? { "accept-encoding": encoding } : {}) } },
              (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
              },
            ).on("error", reject),
          );
        },
      );
    const plain = await raw();
    assert.equal(plain.headers["content-encoding"], undefined);
    const br = await raw("gzip, deflate, br");
    assert.equal(br.headers["content-encoding"], "br");
    assert.equal(br.headers.vary, "Accept-Encoding");
    assert.ok(
      br.body.length < plain.body.length / 3,
      `${br.body.length} vs ${plain.body.length} bytes`,
    );
    assert.deepEqual(
      JSON.parse(brotliDecompressSync(br.body).toString()),
      JSON.parse(plain.body.toString()),
    );
    const refused = await raw("br;q=0, gzip;q=0");
    assert.equal(refused.headers["content-encoding"], undefined);
    // Runtime metrics: admin only, fixed names (no run id, user or path in any key).
    const metrics = await fetch(`${base}/api/metrics/runtime`, { headers: { cookie } });
    assert.equal(metrics.status, 200);
    const snapshot = JSON.stringify(await metrics.json());
    assert.ok(!snapshot.includes(username) && !snapshot.includes(`/runs/${run.id}`));
    const member = `wf-perf-member-${Date.now()}`;
    await createUser({ username: member, password: "local-test-password", role: "member" });
    const memberLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: member, password: "local-test-password" }),
    });
    const memberCookie = memberLogin.headers.get("set-cookie")!.split(";")[0];
    const denied = await fetch(`${base}/api/metrics/runtime`, {
      headers: { cookie: memberCookie },
    });
    assert.equal(denied.status, 403, "members cannot read process-wide metrics");
    // The session route carries the CSRF token: never compressed (BREACH).
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie, "accept-encoding": "br" } });
    assert.equal(me.headers.get("content-encoding"), null);
    config.server.compression = "off";
    try {
      assert.equal(
        (await raw("br")).headers["content-encoding"],
        undefined,
        "HTTP_COMPRESSION=off",
      );
    } finally {
      config.server.compression = undefined;
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
