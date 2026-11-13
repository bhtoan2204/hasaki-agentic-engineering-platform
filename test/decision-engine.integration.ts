import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { startRun, getRun } from "../src/workflow/engine.ts";
import { decisionStore } from "../src/decision/index.ts";
import { DecisionEngine, type DecisionRequest } from "../src/decision/engine.ts";
import { DecisionConfig } from "../src/decision/config.ts";
import { runEvents } from "../src/workflow/events.ts";
import type { DecisionTransport } from "../src/decision/providers.ts";
import { decideFeedbackRoute, feedbackSignals, routeTargets } from "../src/workflow/replan.ts";

before(async () => {
  await migrate();
  await seedTemplates();
});
after(async () => {
  await pool.end();
});

test("Postgres serializes concurrent decisions, resumes from durable cache, and exposes timeline evidence without mutating workflow", async () => {
  const run = await startRun({
    definitionKey: "feature-implementation",
    title: "Decision integration",
    start: false,
    agentProvider: "claude",
  });
  const before = await getRun(run.id);
  const config = DecisionConfig.parse({ enabled: true });
  let calls = 0;
  const transport: DecisionTransport = {
    async resolve(t) {
      return { ...t, model: "gemini-catalog-flash-medium" };
    },
    async execute() {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        text: JSON.stringify({
          decision: {
            route: "replan",
            architecture_change: true,
            scope_change: false,
            requirement_change: false,
            full_review: false,
            reasons: ["Design changed"],
          },
          reasoningSummary: "Revisit design",
        }),
        tokens: { input: 10, output: 20 },
      };
    },
  };
  const engine = new DecisionEngine(transport, decisionStore, () => config);
  const request: DecisionRequest<"feedback"> = {
    type: "feedback",
    input: { feedback: "Change architecture", access_token: "secret-value" },
    scope: { runId: run.id, revision: 1 },
  };
  const results = await Promise.all(Array.from({ length: 6 }, () => engine.decide(request)));
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r.fingerprint === results[0].fingerprint));
  const resumed = new DecisionEngine(transport, decisionStore, () => config);
  await resumed.decide(request);
  assert.equal(calls, 1);
  assert.equal((await q(pool, "SELECT * FROM ai_decisions WHERE run_id=$1", [run.id])).length, 1);
  const persisted = await one<{ input_context: unknown }>(
    pool,
    "SELECT input_context FROM ai_decisions WHERE run_id=$1",
    [run.id],
  );
  assert.ok(!JSON.stringify(persisted?.input_context).includes("secret-value"));
  const events = await runEvents.list(run.id);
  const event = events.find((e) => e.kind === "decision") as {
    data: { provider: string; confidence: null; tokens: unknown };
  };
  assert.equal(event.data.provider, "antigravity");
  assert.equal(event.data.confidence, null);
  assert.deepEqual(event.data.tokens, { input: 10, output: 20 });
  const route = decideFeedbackRoute({
    mode: "auto",
    signals: feedbackSignals("design", [], []),
    judgement: results[0].decision,
  });
  assert.equal(route.route, "replan");
  assert.ok(routeTargets(before.graph, route.route).targets.length > 0);
  const after = await getRun(run.id);
  assert.deepEqual(after.graph, before.graph);
  assert.equal(after.status, before.status);
  assert.equal(after.agent_provider, "claude");
  assert.equal(
    (
      await one<{ n: number }>(
        pool,
        "SELECT count(*)::int AS n FROM workflow_step_attempts WHERE run_id=$1",
        [run.id],
      )
    )?.n,
    0,
  );
});

test("rejected response is audited and never cached or executed", async () => {
  const run = await startRun({
    definitionKey: "feature-implementation",
    title: "Invalid recommendation",
    start: false,
  });
  const transport: DecisionTransport = {
    async resolve(t) {
      return t;
    },
    async execute() {
      return {
        text: '{"decision":{"action":"retry","explanation":"quota_exhausted"},"reasoningSummary":"unsafe"}',
        tokens: null,
      };
    },
  };
  const engine = new DecisionEngine(transport, decisionStore, () =>
    DecisionConfig.parse({ enabled: true }),
  );
  await assert.rejects(
    engine.decide({
      type: "recovery",
      input: "non-idempotent PR creation failed",
      constraints: { allowedActions: ["human", "stop"] },
      scope: { runId: run.id },
    }),
    /policy/,
  );
  assert.equal((await q(pool, "SELECT * FROM ai_decisions WHERE run_id=$1", [run.id])).length, 0);
  const event = (await runEvents.list(run.id)).find((e) => e.kind === "decision") as {
    data: { outcome: string; attempts: unknown[] };
  };
  assert.equal(event.data.outcome, "rejected");
  assert.equal(event.data.attempts.length, 1);
});

test("cache-off persists each inference even with successful timeline events disabled", async () => {
  const run = await startRun({
    definitionKey: "feature-implementation",
    title: "Uncached evidence",
    start: false,
  });
  const transport: DecisionTransport = {
    async resolve(t) {
      return t;
    },
    async execute() {
      return {
        text: '{"decision":{"profile":"STANDARD","explanation":"bounded"},"reasoningSummary":"simple"}',
        tokens: null,
      };
    },
  };
  const engine = new DecisionEngine(transport, decisionStore, () =>
    DecisionConfig.parse({ enabled: true, cache: false, observability: false }),
  );
  const request: DecisionRequest<"workflow_routing"> = {
    type: "workflow_routing",
    input: "same",
    constraints: { allowedProfiles: ["STANDARD"] },
    scope: { runId: run.id },
  };
  await engine.decide(request);
  await engine.decide(request);
  assert.equal((await q(pool, "SELECT id FROM ai_decisions WHERE run_id=$1", [run.id])).length, 2);
});
