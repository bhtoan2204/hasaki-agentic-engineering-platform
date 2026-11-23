import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser } from "../src/auth/users.ts";
import { registerInstance } from "../src/instances.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, cancelRun } from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { setHandoffReadinessForTests } from "../src/agent/handoff.ts";
import { saveRoutingPreference, loadOutcomes } from "../src/routing/adaptive.ts";

/** Production-like history (stubbed agents, real engine rows) → routing decisions at run start. No model is called. */
let ownerId = 0;
const runs: number[] = [];

before(async () => {
  await migrate();
  await registerInstance();
  ownerId = (
    await createUser({
      username: "routing-owner",
      password: "routing-test-password",
      role: "member",
    })
  ).id;
  setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
  registerExecutor("agent", {
    async execute(ctx) {
      return /fail/.test(ctx.run.title)
        ? { kind: "failed", error: "analysis failed", retryable: false }
        : { kind: "completed", output: { summary: "ok" } };
    },
  });
  await definitions.create({
    key: "route-wf",
    spec: { name: "Routing workflow", steps: [{ key: "analyze", type: "agent" }] },
  });
  // History: claude analyses succeed half the time, codex analyses nearly always (provider recorded per attempt).
  const history: Array<[string, boolean]> = [
    ...Array.from({ length: 16 }, (_, i): [string, boolean] => ["claude", i % 2 === 0]),
    ...Array.from({ length: 16 }, (_, i): [string, boolean] => ["codex", i !== 0]),
  ];
  for (const [provider, ok] of history) {
    // The engine records the provider on each attempt (attempt agent configuration is immutable afterwards).
    const run = await startRun({
      definitionKey: "route-wf",
      title: `${provider} ${ok ? "ok" : "fail"}`,
      ownerId,
      agentProvider: provider as "claude",
    });
    runs.push(Number((run as { id: number }).id));
    await drain();
  }
});
after(async () => {
  setHandoffReadinessForTests(undefined);
  for (const id of runs) await cancelRun(id).catch(() => {});
  await settleBackground();
  await pool.end();
});

const stepConfig = async (runId: number) =>
  (await one<{ config: Record<string, unknown> }>(
    pool,
    "SELECT config FROM workflow_steps WHERE run_id=$1 AND key='analyze'",
    [runId],
  ))!.config;

test("history is read from platform outcomes (completed vs failed attempts), excluding nothing it should not", async () => {
  const outcomes = await loadOutcomes({ stepType: "agent" });
  const by = (p: string) => outcomes.filter((o) => o.provider === p);
  assert.equal(by("claude").length, 16);
  assert.equal(by("claude").filter((o) => o.verified).length, 8);
  assert.equal(by("codex").filter((o) => o.verified).length, 15);
});

test("without an opt-in preference nothing changes; with it the better measured provider is chosen and recorded", async () => {
  const plain = await startRun({
    definitionKey: "route-wf",
    title: "no preference",
    ownerId,
    start: false,
  });
  runs.push(Number(plain.id));
  assert.equal((await stepConfig(Number(plain.id))).routing_decision, undefined);

  await saveRoutingPreference(ownerId, { enabled: true, preference: "balanced", min_samples: 10 });
  const routed = await startRun({
    definitionKey: "route-wf",
    title: "routed",
    ownerId,
    start: false,
  });
  runs.push(Number(routed.id));
  const cfg = await stepConfig(Number(routed.id));
  const decision = cfg.routing_decision as {
    applied: boolean;
    chosen: { provider: string };
    eligible: string[];
    evidence: unknown[];
    confidence: string;
    reason: string;
  };
  assert.equal(decision.applied, true, decision.reason);
  assert.equal(decision.chosen.provider, "codex");
  assert.equal((cfg.agent as { provider: string }).provider, "codex");
  assert.ok(decision.eligible.includes("codex") && decision.evidence.length >= 2);
  const recorded = await one(
    pool,
    "SELECT source, provenance FROM agent_optimization_decisions WHERE run_id=$1 AND step_key='analyze'",
    [routed.id],
  );
  assert.equal(recorded!.source, "adaptive_routing");
  assert.equal(recorded!.provenance.chosen.provider, "codex");
});

test("an explicit provider is a manual override: routing never touches it", async () => {
  const manual = await startRun({
    definitionKey: "route-wf",
    title: "manual",
    ownerId,
    agentProvider: "claude",
    start: false,
  });
  runs.push(Number(manual.id));
  const cfg = await stepConfig(Number(manual.id));
  assert.equal(cfg.routing_decision, undefined);
  assert.equal(cfg.agent, undefined);
  assert.equal(
    (await q(pool, "SELECT 1 FROM agent_optimization_decisions WHERE run_id=$1", [manual.id]))
      .length,
    0,
  );
});

test("a chosen provider that is not usable now falls back to the default, with the reason recorded", async () => {
  setHandoffReadinessForTests(async (a) =>
    a.provider === "codex"
      ? { ok: false, error: "codex CLI missing", quota: "unknown", cost: "unknown" }
      : { ok: true, quota: "unknown", cost: "unknown" },
  );
  try {
    const r = await startRun({
      definitionKey: "route-wf",
      title: "unhealthy",
      ownerId,
      start: false,
    });
    runs.push(Number(r.id));
    const cfg = await stepConfig(Number(r.id));
    assert.equal((cfg.routing_decision as { applied: boolean }).applied, false);
    assert.match(String((cfg.routing_decision as { reason: string }).reason), /not usable now/);
    assert.equal(cfg.agent, undefined);
  } finally {
    setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
  }
});

test("an explicit step model or effort (no provider) is not replaced by routing", async () => {
  await definitions.create({
    key: "route-wf-model",
    spec: {
      name: "pinned model",
      steps: [{ key: "analyze", type: "agent", config: { agent: { model: "claude-opus-5-5" } } }],
    },
  });
  const r = await startRun({
    definitionKey: "route-wf-model",
    title: "pinned",
    ownerId,
    start: false,
  });
  runs.push(Number(r.id));
  const cfg = (await one<{ config: Record<string, unknown> }>(
    pool,
    "SELECT config FROM workflow_steps WHERE run_id=$1",
    [r.id],
  ))!.config;
  assert.equal(cfg.routing_decision, undefined);
  assert.equal((cfg.agent as { provider?: string }).provider, undefined);
});
