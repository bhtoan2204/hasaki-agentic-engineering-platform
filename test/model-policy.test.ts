import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { assertModelAllowed, isModelBlocked } from "../src/agent/modelPolicy.ts";
import {
  legacyAgentConfiguration,
  validateConfigurationValues,
} from "../src/agent/configuration.ts";
import { StepAgentConfig, resolveStepAgent } from "../src/agent/stepAgent.ts";
import { DiscoveryCache } from "../src/agent/providerDiscovery.ts";
import { completeForRun, type CompletionRunner } from "../src/agent/complete.ts";
import { classifyProviderError } from "../src/chat/failures.ts";
import { AGENT_PROVIDERS, type AgentProvider } from "../src/agent/provider.ts";

const FABLE = "claude-fable-5-2";

test("Fable is blocked by default, case-insensitively; other models are not", () => {
  assert.equal(isModelBlocked(FABLE), true);
  assert.equal(isModelBlocked("Claude-FABLE-5-2"), true);
  assert.equal(isModelBlocked("fable"), true);
  assert.equal(isModelBlocked("claude-opus-5-5"), false);
  assert.equal(isModelBlocked(""), false);
  assert.throws(() => assertModelAllowed(FABLE, "test"), /blocked by platform policy/);
});

test("no configuration document, step or run override can select it", () => {
  for (const provider of AGENT_PROVIDERS)
    assert.throws(
      () => validateConfigurationValues(provider, { model: FABLE }),
      /blocked by platform policy/,
      provider,
    );
  assert.throws(() => StepAgentConfig.parse({ model: FABLE }), /blocked by platform policy/);
  assert.throws(
    () =>
      resolveStepAgent(
        { agent_provider: "claude" },
        { type: "agent", config: {}, agent_override: { model: FABLE } },
      ),
    /blocked by platform policy/,
  );
});

test("provider catalogs never offer it", async () => {
  const cache = new DiscoveryCache();
  const d = await cache.get("k", async () => ({
    ok: true,
    models: [
      { slug: FABLE, name: "Fable 5.2" },
      { slug: "claude-opus-5-5", name: "Opus 5.5" },
      { slug: "auto-x", name: "Claude Fable (auto)" },
    ],
  }));
  assert.deepEqual(
    d.models.map((m) => m.slug),
    ["claude-opus-5-5"],
  );
});

test("a completion whose provider actually runs it (e.g. an account default) is refused; a requested one never starts", async () => {
  let calls = 0;
  const runner =
    (model: string): CompletionRunner =>
    async () => (calls++, { text: "x", model, tokens: null });
  const run = () => ({ agent_provider: "claude", agent_configuration: legacyAgentConfiguration() });
  const all = (r: CompletionRunner) =>
    Object.fromEntries(AGENT_PROVIDERS.map((p) => [p, r])) as Record<
      AgentProvider,
      CompletionRunner
    >;
  await assert.rejects(
    completeForRun(run(), "hi", undefined, all(runner(FABLE))),
    /blocked by platform policy/,
  );
  assert.equal(
    (await completeForRun(run(), "hi", undefined, all(runner("claude-opus-5-5")))).text,
    "x",
  );
  calls = 0;
  await assert.rejects(
    completeForRun(run(), "hi", undefined, all(runner("claude-opus-5-5")), { model: FABLE }),
    /blocked by platform policy/,
  );
  assert.equal(calls, 0, "never sent to the provider");
  assert.equal(
    classifyProviderError(new Error(`model "${FABLE}" is blocked by platform policy`)).code,
    "MODEL_UNAVAILABLE",
  );
});

test("the blocklist is configuration (agent.blockedModels)", () => {
  const saved = config.agent.blockedModels;
  config.agent.blockedModels = ["opus"];
  try {
    assert.equal(isModelBlocked(FABLE), false);
    assert.equal(isModelBlocked("claude-opus-5-5"), true);
  } finally {
    config.agent.blockedModels = saved;
  }
});
