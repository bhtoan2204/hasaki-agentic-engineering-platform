/** Run on a disposable PostgreSQL database: node --import ./test/setup.ts test/replay.bench.ts */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { pool } from "../src/db/pool.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { reexecuteStep, startRun, getRun } from "../src/workflow/engine.ts";
import { conditionExecutor } from "../src/workflow/executors/builtin.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { drain } from "../src/workflow/scheduler.ts";

const sampleCount = 7;
const descendants = 8;
let invocations = 0;
let tokens = 0;
registerExecutor("condition", conditionExecutor);
registerExecutor("agent", {
  async execute(ctx) {
    invocations++;
    tokens += 500;
    await delay(20);
    return { kind: "completed", output: { summary: ctx.step.key } };
  },
});

try {
  await definitions.create({
    key: "replay-benchmark",
    spec: {
      name: "Replay benchmark",
      steps: [
        { key: "root", type: "condition", config: { path: "inputs.enabled", equals: true } },
        ...Array.from({ length: descendants }, (_, i) => ({
          key: `analysis-${i}`,
          type: "agent",
          depends_on: [i === 0 ? "root" : `analysis-${i - 1}`],
          config: {
            replay: "context_only",
            agent: { provider: "claude", allowed_tools: ["platform.submit_result"] },
          },
        })),
      ],
    },
  });
  const run = await startRun({ definitionKey: "replay-benchmark", inputs: { enabled: true } });
  assert.equal(run.allowed_repositories.length, 0);
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  invocations = tokens = 0;
  const times = [];
  for (let i = 0; i < sampleCount; i++) {
    const started = performance.now();
    await reexecuteStep(run.id, "root");
    await drain();
    assert.equal((await getRun(run.id)).status, "COMPLETED");
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const eligible = sampleCount * descendants;
  console.log(
    JSON.stringify({
      samples: sampleCount,
      eligible_steps: eligible,
      median_ms: Math.round(times[Math.floor(times.length / 2)]),
      agent_invocations: invocations,
      simulated_tokens: tokens,
      step_reuse_rate: (eligible - invocations) / eligible,
    }),
  );
} finally {
  await settleBackground();
  await pool.end();
}
