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
import { legacyAgentConfiguration } from "../src/agent/configuration.ts";
import {
  loadAgentConfiguration,
  saveProviderConfiguration,
} from "../src/agent/configurationStore.ts";
import { applyOptimizationDefaults } from "../src/eval/optimization.ts";
import { WorkflowSpec } from "../src/workflow/types.ts";

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
  // Coding steps: the platform's verification result is the correctness signal. A pass is in the attempt output; a
  // failed verification fails the attempt and is recorded in its metrics (as the harness does).
  registerExecutor("coding_agent", {
    async execute(ctx) {
      if (/fail/.test(ctx.run.title)) {
        await ctx.recordMetrics({
          verification: { outcome: "failed", status: "failed", passed: false },
        });
        return { kind: "failed", error: "Mandatory verification failed", retryable: false };
      }
      return {
        kind: "completed",
        output: { summary: "ok", verification: { outcome: "passed", passed: true } },
      };
    },
  });
  await definitions.create({
    key: "route-wf",
    spec: { name: "Routing workflow", steps: [{ key: "analyze", type: "agent" }] },
  });
  await definitions.create({
    key: "route-code",
    spec: { name: "Routing coding workflow", steps: [{ key: "implement", type: "coding_agent" }] },
  });
  // History: claude analyses succeed half the time, codex analyses nearly always (provider recorded per attempt).
  const history: Array<[string, boolean]> = [
    ...Array.from({ length: 16 }, (_, i): [string, boolean] => ["claude", i % 2 === 0]),
    ...Array.from({ length: 16 }, (_, i): [string, boolean] => ["codex", i !== 0]),
  ];
  for (const key of ["route-wf", "route-code"])
    for (const [provider, ok] of history) {
      // The engine records the provider on each attempt (attempt agent configuration is immutable afterwards).
      const run = await startRun({
        definitionKey: key,
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

const stepConfig = async (runId: number, key = "analyze") =>
  (await one<{ config: Record<string, unknown> }>(
    pool,
    "SELECT config FROM workflow_steps WHERE run_id=$1 AND key=$2",
    [runId, key],
  ))!.config;

test("history keeps execution success, correctness and review apart; analysis completion is not correctness", async () => {
  const analysis = await loadOutcomes({ stepType: "agent" });
  const a = (p: string) => analysis.filter((o) => o.provider === p);
  assert.equal(a("claude").length, 16);
  assert.equal(a("claude").filter((o) => o.executed).length, 8, "execution success is recorded");
  assert.ok(
    analysis.every((o) => o.verified === null),
    "no deterministic correctness for analysis steps",
  );
  assert.ok(
    analysis.every((o) => o.reviewed === null),
    "a run-level review is not attributed to analysis steps",
  );
  const coding = await loadOutcomes({ stepType: "coding_agent" });
  const c = (p: string) => coding.filter((o) => o.provider === p);
  assert.equal(c("claude").filter((o) => o.verified === true).length, 8);
  assert.equal(
    c("claude").filter((o) => o.verified === false).length,
    8,
    "a failed verification (recorded in metrics, no output) counts as incorrect, not unknown",
  );
  assert.equal(c("codex").filter((o) => o.verified === true).length, 15);
});

test("without an opt-in preference nothing changes; with it the measured-better coding configuration is chosen; analysis keeps its default", async () => {
  const plain = await startRun({
    definitionKey: "route-wf",
    title: "no preference",
    ownerId,
    start: false,
  });
  runs.push(Number(plain.id));
  assert.equal((await stepConfig(Number(plain.id))).routing_decision, undefined);

  await saveRoutingPreference(ownerId, { enabled: true, preference: "balanced", min_samples: 10 });
  // Analysis: codex "completed" more often, but completion is not verified correctness → default kept.
  const analysis = await startRun({
    definitionKey: "route-wf",
    title: "routed analysis",
    ownerId,
    start: false,
  });
  runs.push(Number(analysis.id));
  const ad = (await stepConfig(Number(analysis.id))).routing_decision as {
    applied: boolean;
    confidence: string;
    reason: string;
  };
  assert.equal(ad.applied, false);
  assert.equal(ad.confidence, "insufficient");
  assert.match(ad.reason, /completion is not counted as correct/);
  assert.equal((await stepConfig(Number(analysis.id))).agent, undefined);

  const routed = await startRun({
    definitionKey: "route-code",
    title: "routed",
    ownerId,
    start: false,
  });
  runs.push(Number(routed.id));
  const cfg = await stepConfig(Number(routed.id), "implement");
  const decision = cfg.routing_decision as {
    applied: boolean;
    chosen: { provider: string };
    eligible: string[];
    evidence: unknown[];
    confidence: string;
    reason: string;
    incumbent: { provider: string };
    non_inferiority: { superior: boolean; non_inferior: boolean; correctness: { low: number } };
  };
  assert.equal(decision.applied, true, decision.reason);
  assert.equal(decision.chosen.provider, "codex");
  assert.equal(decision.incumbent.provider, "claude");
  assert.equal(decision.non_inferiority.superior, true);
  assert.ok(decision.non_inferiority.correctness.low > 0);
  assert.equal((cfg.agent as { provider: string }).provider, "codex");
  assert.ok(decision.eligible.includes("codex") && decision.evidence.length >= 2);
  const recorded = await one(
    pool,
    "SELECT source, provenance FROM agent_optimization_decisions WHERE run_id=$1 AND step_key='implement'",
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
      definitionKey: "route-code",
      title: "unhealthy",
      ownerId,
      start: false,
    });
    runs.push(Number(r.id));
    const cfg = await stepConfig(Number(r.id), "implement");
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

test("applyAdaptiveRouting resolves incumbent and chosen candidates from agent_configuration snapshot rather than legacy defaults", async () => {
  const previousRow = await one<{ value: string }>(
    pool,
    "SELECT value FROM settings WHERE key='agent_configuration'",
  );
  const current = await loadAgentConfiguration();
  const legacyModel = legacyAgentConfiguration().providers.claude.defaults.model;
  const customModel =
    legacyModel === "claude-snapshot-custom" ? "claude-snapshot-alt" : "claude-snapshot-custom";
  await saveProviderConfiguration("claude", current.providers.claude.revision, {
    defaults: { ...current.providers.claude.defaults, model: customModel },
  });
  try {
    const r = await startRun({
      definitionKey: "route-code",
      title: "snapshot-incumbent",
      ownerId,
      start: false,
    });
    runs.push(Number(r.id));
    const cfg = await stepConfig(Number(r.id), "implement");
    const decision = cfg.routing_decision as {
      applied: boolean;
      incumbent: { provider: string; model: string | null; effort: string | null };
    };
    assert.equal(decision.incumbent.provider, "claude");
    assert.equal(decision.incumbent.model, customModel);
    assert.equal(decision.applied, false);

    const codingSpec = WorkflowSpec.parse({
      name: "Routing coding workflow",
      steps: [{ key: "implement", type: "coding_agent", config: {} }],
    });
    const snapshot = legacyAgentConfiguration();
    snapshot.providers.claude.profiles.STANDARD = {
      coding_agent: { model: "claude-arg-model", reasoning_effort: "medium" },
    };
    const argRun = await applyOptimizationDefaults(
      pool,
      ownerId,
      codingSpec,
      {},
      false,
      "STANDARD",
      null,
      "claude",
      "route-code",
      snapshot,
    );
    const argDecision = argRun.decisions[0] as {
      incumbent: { provider: string; model: string | null; effort: string | null };
    };
    assert.deepEqual(argDecision.incumbent, {
      provider: "claude",
      model: "claude-arg-model",
      effort: "medium",
    });

    const chosenSnapshot = legacyAgentConfiguration();
    chosenSnapshot.providers.codex.defaults.timeout_ms = 12345;
    let seenTimeoutMs: number | undefined;
    setHandoffReadinessForTests(async (effective) => {
      seenTimeoutMs = effective.timeout_ms;
      return { ok: true, quota: "unknown", cost: "unknown" };
    });
    await applyOptimizationDefaults(
      pool,
      ownerId,
      codingSpec,
      {},
      false,
      "STANDARD",
      null,
      "claude",
      "route-code",
      chosenSnapshot,
    );
    assert.equal(seenTimeoutMs, 12345);
  } finally {
    setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
    if (previousRow)
      await q(pool, "UPDATE settings SET value=$1 WHERE key='agent_configuration'", [
        previousRow.value,
      ]);
    else await q(pool, "DELETE FROM settings WHERE key='agent_configuration'");
  }
});
