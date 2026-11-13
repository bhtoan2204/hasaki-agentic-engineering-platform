import { performance } from "node:perf_hooks";
import {
  DecisionEngine,
  type DecisionResult,
  type DecisionStore,
  type DecisionRequest,
} from "../src/decision/engine.ts";
import { DecisionConfig } from "../src/decision/config.ts";
import type { DecisionTransport } from "../src/decision/providers.ts";
const values = new Map<string, DecisionResult>();
const store: DecisionStore = {
  async exclusive(_k, _s, fn) {
    return fn();
  },
  async get(k) {
    return values.get(k) ?? null;
  },
  async put(k, v) {
    values.set(k, v);
  },
  async audit() {},
};
let calls = 0;
const text = JSON.stringify({
  decision: { profile: "STANDARD", explanation: "bounded risk" },
  reasoningSummary: "Use existing profile",
});
const transport: DecisionTransport = {
  async resolve(t) {
    return { ...t, model: "mock-flash-medium" };
  },
  async execute() {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 2));
    return { text, tokens: { input: 100, output: 20 } };
  },
};
const engine = new DecisionEngine(transport, store, () =>
  DecisionConfig.parse({ enabled: true, observability: false }),
);
const request: DecisionRequest<"workflow_routing"> = {
  type: "workflow_routing",
  input: { risk: "medium" },
  constraints: { allowedProfiles: ["STANDARD"] },
  scope: { runId: 1 },
};
const n = 200;
const measure = async (fn: (i: number) => Promise<unknown>) => {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await fn(i);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    n,
    p50_ms: +samples[Math.floor(n * 0.5)].toFixed(3),
    p95_ms: +samples[Math.floor(n * 0.95)].toFixed(3),
    total_ms: +samples.reduce((a, b) => a + b, 0).toFixed(2),
  };
};
const legacy = await measure(async () => {
  JSON.parse(
    (
      await transport.execute(
        { provider: "antigravity", model: "mock", effort: "medium" },
        "",
        "",
        AbortSignal.timeout(1000),
      )
    ).text,
  );
});
calls = 0;
const cold = await measure((i) => engine.decide({ ...request, scope: { runId: 1, revision: i } }));
const coldCalls = calls;
await engine.decide(request);
calls = 0;
const cached = await measure(() => engine.decide(request));
console.log(
  JSON.stringify(
    {
      note: "Mock 2ms inference, in-memory persistence. Legacy completion+JSON parse versus validated engine; excludes CLI startup and PostgreSQL.",
      legacy,
      cold: { ...cold, provider_calls: coldCalls },
      cached: { ...cached, provider_calls: calls },
    },
    null,
    2,
  ),
);
