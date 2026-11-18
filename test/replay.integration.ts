import { knowledge } from "../src/knowledge/service.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pool, q } from "../src/db/pool.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { definitions } from "../src/workflow/definitions.ts";
import {
  approveStep,
  getRun,
  previewReplay,
  reexecuteStep,
  startRun,
} from "../src/workflow/engine.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { decisionsOf } from "../src/workflow/decisions.ts";

after(async () => {
  await settleBackground();
  await pool.end();
});

test("replay reuses semantic descendants, recomputes changes and fences earlier generations", async () => {
  let value = 1;
  let rootCalls = 0;
  const calls = new Map<string, number>();
  registerExecutor("condition", {
    async execute() {
      rootCalls++;
      return {
        kind: "completed",
        output: rootCalls % 2 ? { value, ok: true } : { ok: true, value },
      };
    },
  });
  registerExecutor("agent", {
    async execute(ctx) {
      calls.set(ctx.step.key, (calls.get(ctx.step.key) ?? 0) + 1);
      return { kind: "completed", output: { value: ctx.input.upstream.root?.output?.value ?? 0 } };
    },
  });
  const config = {
    replay: "context_only",
    agent: { provider: "claude", allowed_tools: ["platform.submit_result"] },
  };
  await definitions.create({
    key: "replay-behavior",
    spec: {
      name: "Replay behavior",
      steps: [
        { key: "root", type: "condition", config: { path: "inputs.value" } },
        { key: "child", type: "agent", depends_on: ["root"], config },
        { key: "grandchild", type: "agent", depends_on: ["child"], config },
        { key: "outside", type: "agent", config },
        {
          key: "unrestricted",
          type: "agent",
          depends_on: ["root"],
          config: { replay: "context_only" },
        },
      ],
    },
  });
  const run = await startRun({ definitionKey: "replay-behavior" });
  await drain();
  const before = await getRun(run.id);

  const preview = await previewReplay(run.id, "root");
  assert.equal(preview.can_reexecute, true);
  assert.deepEqual(
    preview.steps.map(({ key, action, invalidated }) => [key, action, invalidated]),
    [
      ["root", "FORCE_REEXECUTE", true],
      ["outside", "REUSE", false],
      ["child", "REUSE", true],
      ["unrestricted", "REEXECUTE", true],
      ["grandchild", "REUSE", true],
    ],
  );
  assert.equal((await getRun(run.id)).steps[1].generation, before.steps[1].generation);
  assert.deepEqual(preview.summary.actions, { FORCE_REEXECUTE: 1, REUSE: 3, REEXECUTE: 1 });
  assert.ok("estimated_avoided" in preview.summary);
  assert.equal(
    (await q(pool, "SELECT 1 FROM execution_decisions WHERE run_id=$1 AND kind='replay'", [run.id]))
      .length,
    0,
    "a preview records nothing",
  );
  await reexecuteStep(run.id, "root");
  await drain();
  const replayed = await getRun(run.id);
  assert.equal(rootCalls, 2);
  assert.equal(calls.get("child"), 1);
  assert.equal(calls.get("grandchild"), 1);
  assert.equal(calls.get("outside"), 1);
  assert.equal(calls.get("unrestricted"), 2);
  const step = replayed.steps.find((s) => s.key === "child")!;
  const original = before.steps.find((s) => s.key === "child")!;
  assert.equal(step.generation, original.generation + 1);
  assert.notEqual(step.current_attempt_id, original.current_attempt_id);
  assert.deepEqual(
    await q(
      pool,
      "SELECT id,reused_from_attempt_id FROM workflow_step_attempts WHERE step_id=$1 ORDER BY id",
      [step.id],
    ),
    [
      { id: original.current_attempt_id, reused_from_attempt_id: null },
      { id: step.current_attempt_id, reused_from_attempt_id: original.current_attempt_id },
    ],
  );
  assert.equal(
    replayed.steps.find((s) => s.key === "outside")?.current_attempt_id,
    before.steps.find((s) => s.key === "outside")?.current_attempt_id,
  );
  const decisions = await decisionsOf(run.id);
  assert.deepEqual(
    decisions
      .filter((d) => d.kind === "replay" && d.outcome === "planned")
      .map((d) => [d.step_key, d.action]),
    [
      ["root", "FORCE_REEXECUTE"],
      ["outside", "REUSE"],
      ["child", "REUSE"],
      ["unrestricted", "REEXECUTE"],
      ["grandchild", "REUSE"],
    ],
  );
  const applied = decisions.find(
    (d) => d.kind === "replay" && d.outcome === "applied" && d.step_key === "child",
  );
  assert.equal(applied?.action, "REUSE");
  assert.equal(Number(applied?.source_attempt_id), Number(original.current_attempt_id));
  assert.ok(applied?.latency_ms != null && applied.latency_ms >= 0);
  assert.ok(
    decisions.some((d) => d.kind === "checkpoint" && Number(d.checkpoint_bytes) > 0),
    "executor returns record their checkpoint size",
  );

  value = 2;
  await reexecuteStep(run.id, "root");
  await drain();
  assert.equal(calls.get("child"), 2);
  assert.equal(calls.get("grandchild"), 2);
  await reexecuteStep(run.id, "root", { force: true });
  await drain();
  assert.equal(calls.get("child"), 3);
  assert.equal(calls.get("grandchild"), 3);
});

test("changed knowledge invalidates the replay fingerprint and a forced step gets fresh approval", async () => {
  const key = "replay-pinned-guidance";
  await knowledge.create({
    key,
    category: "business_rule",
    scope_type: "GLOBAL",
    title: "Replay guidance",
    content: "Version one.",
  });
  let calls = 0;
  registerExecutor("agent", {
    async execute() {
      calls++;
      return { kind: "completed", output: { summary: "answer" } };
    },
  });
  await definitions.create({
    key: "replay-knowledge",
    spec: {
      name: "Replay knowledge",
      steps: [
        { key: "root", type: "condition", requires_approval: true, config: { path: "inputs.ok" } },
        {
          key: "analysis",
          type: "agent",
          depends_on: ["root"],
          config: {
            replay: "context_only",
            knowledge: [key],
            agent: { provider: "claude", allowed_tools: ["platform.submit_result"] },
          },
        },
      ],
    },
  });
  const run = await startRun({ definitionKey: "replay-knowledge" });
  await approveStep(run.id, "root");
  await drain();
  assert.equal(calls, 1);
  await knowledge.update(key, { content: "Version two." });
  await reexecuteStep(run.id, "root");
  const pending = await getRun(run.id);
  assert.equal(pending.steps[0].status, "WAITING_APPROVAL");
  assert.notEqual(pending.steps[0].approval?.granted, true);
  await approveStep(run.id, "root");
  await drain();
  assert.equal(calls, 2);
  const audited = await q<{ execution_fingerprint: { parts: { knowledge: string } } }>(
    pool,
    "SELECT execution_fingerprint FROM workflow_step_attempts WHERE step_id=$1 ORDER BY id",
    [pending.steps[1].id],
  );
  assert.notEqual(
    audited[0].execution_fingerprint.parts.knowledge,
    audited[1].execution_fingerprint.parts.knowledge,
  );
});
