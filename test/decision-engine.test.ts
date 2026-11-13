import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DecisionEngine,
  DecisionUnavailable,
  type DecisionStore,
  type DecisionRequest,
  type DecisionResult,
} from "../src/decision/engine.ts";
import { DecisionConfig } from "../src/decision/config.ts";
import {
  DecisionProviderError,
  flashModel,
  type DecisionTransport,
} from "../src/decision/providers.ts";

export function harness(overrides: Record<string, unknown> = {}) {
  const config = DecisionConfig.parse({ enabled: true, ...overrides });
  const cache = new Map<string, DecisionResult>();
  const audits: Record<string, unknown>[] = [];
  const calls: Array<{ provider: string; model: string; effort: string }> = [];
  let answer: unknown = { profile: "STANDARD", explanation: "bounded risk" };
  let behavior: (provider: string) => void | Promise<void> = () => {};
  const locks = new Map<string, Promise<unknown>>();
  const store: DecisionStore = {
    async exclusive(key, _signal, fn) {
      const prior = locks.get(key) ?? Promise.resolve();
      const next = prior.catch(() => {}).then(fn);
      locks.set(key, next);
      try {
        return await next;
      } finally {
        if (locks.get(key) === next) locks.delete(key);
      }
    },
    async get(k) {
      return cache.get(k) ?? null;
    },
    async put(k, r) {
      cache.set(k, structuredClone(r));
    },
    async audit(_request, r) {
      audits.push(r);
    },
  };
  const transport: DecisionTransport = {
    async resolve(t) {
      return {
        ...t,
        model: t.model === "gemini-flash" ? `gemini-3.8-flash-${t.effort}` : t.model || "fallback",
      };
    },
    async execute(t) {
      calls.push(t);
      await behavior(t.provider);
      return {
        text:
          typeof answer === "string"
            ? answer
            : JSON.stringify({
                decision: answer,
                reasoningSummary: "Small validated recommendation",
              }),
        tokens: null,
      };
    },
  };
  return {
    config,
    cache,
    audits,
    calls,
    transport,
    store,
    engine: new DecisionEngine(transport, store, () => config),
    answer(v: unknown) {
      answer = v;
    },
    behavior(fn: typeof behavior) {
      behavior = fn;
    },
  };
}
const request: DecisionRequest<"workflow_routing"> = {
  type: "workflow_routing",
  input: { risk: "medium" },
  scope: { runId: 1, revision: 1 },
  constraints: { allowedProfiles: ["STANDARD", "DEEP"] },
};
const fail = (code: string) => {
  throw new DecisionProviderError(code, code);
};

test("Gemini Flash decides independently of coding provider; medium default, high only for high complexity", async () => {
  const h = harness();
  const a = await h.engine.decide({ ...request, context: { codingProvider: "claude" } });
  assert.equal(a.provider, "antigravity");
  assert.equal(a.model, "gemini-3.8-flash-medium");
  assert.equal(a.effort, "medium");
  assert.equal(a.confidence, null);
  assert.equal(a.fallbackUsed, false);
  const b = await h.engine.decide({ ...request, complexity: "high" });
  assert.equal(b.effort, "high");
});
test("per-type model/effort override is applied", async () => {
  const h = harness({
    overrides: { workflow_routing: { provider: "codex", model: "permitted", effort: "medium" } },
  });
  const r = await h.engine.decide({ ...request, complexity: "high" });
  assert.equal(r.provider, "codex");
  assert.equal(r.model, "permitted");
  assert.equal(r.effort, "medium");
});
test("Flash effort mapping selects latest published variant and rejects invented support", () => {
  const slugs = [
    "gemini-3.5-flash-medium",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-high",
    "gemini-4-pro-high",
  ];
  assert.equal(flashModel(slugs, "gemini-flash", "medium"), "gemini-3.8-flash-medium");
  assert.equal(flashModel(slugs, "gemini-3.8-flash", "high"), "gemini-3.8-flash-high");
  assert.throws(() => flashModel(slugs, "gemini-3.8-flash-medium", "high"), /conflicts/);
  assert.throws(() => flashModel(["gemini-3.8-flash"], "gemini-flash", "medium"), /No catalog/);
});
test("quota switches only the decision provider", async () => {
  const h = harness();
  h.behavior((p) => {
    if (p === "antigravity") fail("QUOTA_EXHAUSTED");
  });
  const r = await h.engine.decide(request);
  assert.equal(r.provider, "codex");
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.attempts.length, 2);
});
test("rate limiting retries within bounded budget then falls back", async () => {
  const h = harness();
  h.behavior((p) => {
    if (p === "antigravity") fail("RATE_LIMIT");
  });
  await h.engine.decide(request);
  assert.deepEqual(
    h.calls.map((c) => c.provider),
    ["antigravity", "antigravity", "codex"],
  );
});
test("unavailable providers stop after maxSwitches; duplicates cannot loop", async () => {
  const h = harness({
    fallback: { providers: ["antigravity", "codex", "codex", "claude"], maxSwitches: 1 },
  });
  h.behavior(() => fail("PROVIDER_UNAVAILABLE"));
  await assert.rejects(h.engine.decide(request), DecisionUnavailable);
  assert.equal(h.calls.length, 2);
});
for (const code of [
  "AUTHENTICATION",
  "PERMISSION_DENIED",
  "UNSUPPORTED",
  "UNKNOWN",
  "EXECUTION_TIMEOUT",
])
  test(`${code} never triggers fallback`, async () => {
    const h = harness();
    h.behavior(() => fail(code));
    await assert.rejects(h.engine.decide(request));
    assert.equal(h.calls.length, 1);
  });
for (const value of [
  "not JSON",
  '{"decision":{"profile":"STANDARD","explanation":"ok","extra":1},"reasoningSummary":"ok"}',
  '{"decision":{"profile":"FAST","explanation":"ok"},"reasoningSummary":"ok"}',
])
  test("schema and business-rule rejection never switch providers", async () => {
    const h = harness();
    h.answer(value);
    await assert.rejects(h.engine.decide(request));
    assert.equal(h.calls.length, 1);
    assert.equal(h.cache.size, 0);
    assert.equal(h.audits.at(-1)?.outcome, "rejected");
  });
test("canonical cache supports resume, concurrent callers and new engine instances; policies invalidate", async () => {
  const h = harness();
  const r = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      h.engine.decide({ ...request, scope: { ...request.scope, attemptId: i } }),
    ),
  );
  assert.equal(h.calls.length, 1);
  assert.ok(r.every((x) => x.fingerprint === r[0].fingerprint));
  const resumed = new DecisionEngine(h.transport, h.store, () => h.config);
  await resumed.decide(request);
  assert.equal(h.calls.length, 1);
  h.config.highComplexityEffort = "medium";
  await resumed.decide(request);
  assert.equal(h.calls.length, 2);
});
test("cache-off still persists audit evidence but performs fresh decisions", async () => {
  const h = harness({ cache: false, observability: false });
  await h.engine.decide(request);
  await h.engine.decide(request);
  assert.equal(h.calls.length, 2);
  assert.equal(h.cache.size, 1);
  assert.equal(h.audits.length, 0);
});
test("explicit agent/model overrides and availability are mandatory", async () => {
  const h = harness();
  h.answer({ provider: "codex", model: "m", effort: "medium", explanation: "ok" });
  const r: DecisionRequest<"provider_selection"> = {
    ...request,
    type: "provider_selection",
    constraints: {
      permittedAgents: [{ provider: "codex", model: "m", efforts: ["medium"], available: true }],
      agentOverride: { provider: "claude" },
    },
  };
  await assert.rejects(h.engine.decide(r), /override/);
  await assert.rejects(h.engine.decide({ ...r, constraints: {} }), /permitted/);
});
test("effort, recovery and baseline acceptance cannot exceed deterministic permissions", async () => {
  const h = harness();
  h.answer({ effort: "high", explanation: "ok" });
  await assert.rejects(
    h.engine.decide({
      ...request,
      type: "reasoning_effort",
      constraints: { supportedEfforts: ["medium"] },
    }),
    /unsupported/,
  );
  h.answer({ action: "retry", explanation: "ok" });
  await assert.rejects(
    h.engine.decide({
      ...request,
      type: "recovery",
      constraints: { allowedActions: ["human", "stop"] },
    }),
    /policy/,
  );
  h.answer({ kind: "accept_baseline", confirmed: true });
  await assert.rejects(
    h.engine.decide({ ...request, type: "test_recovery", constraints: {} }),
    /human confirmation/,
  );
});
test("explicit user effort cannot be overridden even if another tier is supported", async () => {
  const h = harness();
  h.answer({ effort: "high", explanation: "supported but pinned" });
  await assert.rejects(
    h.engine.decide({
      ...request,
      type: "reasoning_effort",
      constraints: { supportedEfforts: ["medium", "high"], agentOverride: { effort: "medium" } },
    }),
    /user effort override/,
  );
});

test("decomposition recommendation stays a plan, with repository scope enforced", async () => {
  const h = harness();
  h.answer({ decompose: false, explanation: "small task", plan: null });
  const result = await h.engine.decide({ ...request, type: "decomposition" });
  assert.equal(result.decision.decompose, false);
  h.answer({ decompose: true, explanation: "split", plan: null });
  await assert.rejects(
    h.engine.decide({ ...request, type: "decomposition", input: "changed" }),
    /mismatch/,
  );
});
test("timeout/input budget/disabled engine prevent uncontrolled work", async () => {
  const h = harness({ timeoutMs: 100 });
  h.behavior(() => new Promise((resolve) => setTimeout(resolve, 150)));
  await assert.rejects(h.engine.decide(request));
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.engine.decide({ ...request, input: "x".repeat(25000) }), /input budget/);
  h.config.enabled = false;
  await assert.rejects(h.engine.decide(request), /disabled/);
});

test("repository ranking cannot add foreign repositories or duplicate candidates", async () => {
  const h = harness();
  h.answer([{ repo: "outside", score: 10, reasons: ["rate_limit"] }]);
  await assert.rejects(
    h.engine.decide({
      ...request,
      type: "repository_ranking",
      constraints: { allowedRepositories: ["allowed"] },
    }),
    /scope/,
  );
  assert.equal(h.calls.length, 1);
  h.answer([
    { repo: "allowed", score: 5, reasons: [] },
    { repo: "allowed", score: 4, reasons: [] },
  ]);
  await assert.rejects(
    h.engine.decide({
      ...request,
      type: "repository_ranking",
      constraints: { allowedRepositories: ["allowed"] },
    }),
    /duplicate/,
  );
});

test("invalid enum containing provider failure text is terminal validation, never provider fallback", async () => {
  const h = harness();
  h.answer({ profile: "quota_exhausted", explanation: "bad output" });
  await assert.rejects(h.engine.decide(request));
  assert.equal(h.calls.length, 1);
  assert.equal(
    (h.audits.at(-1)?.attempts as Array<{ outcome: string }>)[0].outcome,
    "validation_rejected",
  );
});

test("a persistence failure never causes a provider switch", async () => {
  const h = harness();
  h.store.put = async () => {
    throw new Error("database unavailable");
  };
  await assert.rejects(h.engine.decide(request), /database/);
  assert.equal(h.calls.length, 1);
});

test("decomposition reuses DAG validation before persisting a recommendation", async () => {
  const h = harness();
  const sub = (id: string, dep: string) => ({
    id,
    title: id,
    description: "d",
    objective: "o",
    expected_output: "e",
    acceptance_criteria: ["passes"],
    target_repos: ["repo"],
    depends_on: [dep],
  });
  h.answer({
    decompose: true,
    explanation: "split",
    plan: { summary: "plan", subtasks: [sub("a", "b"), sub("b", "a")] },
  });
  await assert.rejects(
    h.engine.decide({
      ...request,
      type: "decomposition",
      constraints: {
        allowedRepositories: ["repo"],
        expansion: {
          existingKeys: [],
          allowedRepositories: ["repo"],
          limits: { max_subtasks: 8, max_depth: 1, max_replans: 2 },
        },
      },
    }),
    /cycle/,
  );
  assert.equal(h.cache.size, 0);
});
