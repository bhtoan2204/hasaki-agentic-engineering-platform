import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { providerDraftPatch } from "../web/src/agentConfiguration.ts";
import { previewAgentValues } from "../src/agent/configuration.ts";
import { providerControlState } from "../src/agent/providerCapabilities.ts";

test("profile-only saves retain environment defaults while explicit edits pin only their fields", () => {
  const previous = process.env.CURSOR_AGENT_TIMEOUT_MS;
  try {
    process.env.CURSOR_AGENT_TIMEOUT_MS = "10000";
    const document = legacyAgentConfiguration();
    const provider = "cursor";
    const draft = {
      ...document.providers[provider],
      profiles: { FAST: { agent: { timeout_ms: 30000 } } },
    };
    const patch = providerDraftPatch(draft, []);
    assert.equal(Object.hasOwn(patch, "defaults"), false);
    const saved = patchProviderConfiguration(document, provider, 0, patch);
    process.env.CURSOR_AGENT_TIMEOUT_MS = "20000";
    assert.equal(refreshEnvironmentDefaults(saved).providers[provider].defaults.timeout_ms, 20000);
    const edited = providerDraftPatch(
      { ...draft, defaults: { ...draft.defaults, timeout_ms: 40000 } },
      ["timeout_ms"],
    );
    const pinned = patchProviderConfiguration(document, provider, 0, edited);
    assert.equal(refreshEnvironmentDefaults(pinned).providers[provider].defaults.timeout_ms, 40000);
  } finally {
    if (previous === undefined) delete process.env.CURSOR_AGENT_TIMEOUT_MS;
    else process.env.CURSOR_AGENT_TIMEOUT_MS = previous;
  }
});

test("draft preview and saved values use the same per-field provenance", () => {
  const document = legacyAgentConfiguration();
  const provider = "claude";
  document.providers[provider].defaults = { model: "haiku", timeout_ms: 10000 };
  document.providers[provider].default_sources = {
    model: "environment FIXTURE_MODEL",
    timeout_ms: "provider default",
  };
  const patch = { defaults: { model: "opus", timeout_ms: 10000 }, default_fields: ["model"] };
  const preview = previewAgentValues(document, provider, "STANDARD", "agent", patch);
  assert.equal(preview.values.model, "opus");
  assert.equal(preview.sources.model, "provider default");
  assert.equal(preview.sources.timeout_ms, "provider default");
  const saved = patchProviderConfiguration(document, provider, 0, patch);
  assert.deepEqual(preview, resolveAgentValues(saved, provider, "STANDARD", "agent"));
});

test("Cursor model controls follow confirmed CLI support and keep unavailable discovery distinct", () => {
  assert.equal(
    providerControlState("cursor", { available: true, supportsModel: false }).model,
    false,
  );
  assert.equal(
    providerControlState("cursor", { available: true, supportsModel: true }).model,
    true,
  );
  assert.equal(providerControlState("cursor", { available: false }).model, null);
  assert.equal(providerControlState("claude", { available: false }).model, true);
});

test("editing one provider option preserves other environment fallbacks", () => {
  const previous = process.env.COPILOT_MAX_CONCURRENT;
  try {
    process.env.COPILOT_MAX_CONCURRENT = "2";
    const document = legacyAgentConfiguration();
    const provider = "copilot";
    const entry = document.providers[provider];
    const draft = {
      ...entry,
      defaults: { ...entry.defaults, options: { ...entry.defaults.options, sandbox: false } },
    };
    const saved = patchProviderConfiguration(
      document,
      provider,
      entry.revision,
      providerDraftPatch(draft, ["options.sandbox"]),
    );
    assert.equal(saved.providers[provider].defaults.options?.sandbox, false);
    assert.equal(
      saved.providers[provider].default_sources?.["options.sandbox"],
      "provider default",
    );
    assert.equal(saved.providers[provider].default_sources?.model, entry.default_sources?.model);
    process.env.COPILOT_MAX_CONCURRENT = "3";
    const fresh = refreshEnvironmentDefaults(saved);
    assert.equal(fresh.providers[provider].defaults.options?.max_concurrent, 3);
    assert.equal(fresh.providers[provider].defaults.options?.sandbox, false);
  } finally {
    if (previous === undefined) delete process.env.COPILOT_MAX_CONCURRENT;
    else process.env.COPILOT_MAX_CONCURRENT = previous;
  }
});

test("provider defaults remain identical across persistence and disable/re-enable", () => {
  const stored = legacyAgentConfiguration();
  const provider = "copilot";
  stored.providers[provider].defaults = {
    model: null,
    reasoning_effort: null,
    timeout_ms: 10000,
    options: { sandbox: true, max_concurrent: 2 },
  };
  stored.providers[provider].default_sources = {
    model: "provider default",
    reasoning_effort: "provider default",
    timeout_ms: "provider default",
    max_turns: "legacy provider default",
    "options.sandbox": "provider default",
    "options.max_concurrent": "provider default",
  };
  const before = refreshEnvironmentDefaults(stored);
  const persisted = JSON.parse(JSON.stringify(before));
  const disabled = patchProviderConfiguration(persisted, provider, 0, { enabled: false });
  const enabled = patchProviderConfiguration(disabled, provider, 1, { enabled: true });
  assert.deepEqual(enabled.providers[provider].defaults, before.providers[provider].defaults);
  assert.deepEqual(before.providers[provider].defaults, {
    model: null,
    reasoning_effort: null,
    timeout_ms: 10000,
    options: { sandbox: true, max_concurrent: 2 },
  });
});
import { resolveStepAgent } from "../src/agent/stepAgent.ts";
import {
  convertLegacyConfiguration,
  patchProviderConfiguration,
} from "../src/agent/configuration.ts";

test("legacy conversion is idempotent and canonical provider values win", () => {
  const legacy = legacyAgentConfiguration();
  const converted = convertLegacyConfiguration(legacy, { model: "sonnet", maxTurns: 33 });
  assert.equal(converted.providers.claude.defaults.model, "sonnet");
  assert.equal(converted.providers.claude.defaults.max_turns, 33);
  converted.providers.claude.defaults.model = "opus";
  assert.deepEqual(convertLegacyConfiguration(legacy, { model: "haiku" }, converted), converted);
});

test("provider patches preserve other providers and reject stale revisions", () => {
  const original = legacyAgentConfiguration();
  const next = patchProviderConfiguration(original, "copilot", 0, {
    defaults: { model: "selected-model" },
    enabled: false,
  });
  assert.deepEqual(next.providers.claude, original.providers.claude);
  assert.equal(next.providers.copilot.revision, 1);
  assert.throws(
    () => patchProviderConfiguration(next, "copilot", 0, { enabled: true }),
    /revision conflict/,
  );
  const enabled = patchProviderConfiguration(next, "copilot", 1, { enabled: true });
  assert.equal(enabled.providers.copilot.defaults.model, "selected-model");
  assert.equal(original.providers.copilot.revision, 0);
});

test("explicit account default does not inherit a configured Claude model", () => {
  const previous = config.model;
  try {
    config.model = "sonnet";
    const result = resolveStepAgent(
      { agent_provider: "claude", profile: "STANDARD" },
      { type: "agent", config: { agent: { model: null } } },
    );
    assert.equal(result?.model, null);
  } finally {
    config.model = previous;
  }
});

test("run snapshot keeps later steps independent of mutable global routing", () => {
  const previous = config.model;
  try {
    config.model = "opus";
    const snapshot = {
      version: 1 as const,
      default_provider: "claude" as const,
      providers: {
        claude: {
          revision: 0,
          enabled: true,
          defaults: { model: "haiku", timeout_ms: 10000 },
          profiles: {},
        },
        codex: { revision: 0, enabled: true, defaults: {}, profiles: {} },
        cursor: { revision: 0, enabled: true, defaults: {}, profiles: {} },
        antigravity: { revision: 0, enabled: true, defaults: {}, profiles: {} },
        copilot: { revision: 0, enabled: true, defaults: {}, profiles: {} },
      },
    };
    const result = resolveStepAgent(
      { agent_provider: "claude", profile: "STANDARD", agent_configuration: snapshot },
      { type: "coding_agent", config: {} },
    );
    assert.equal(result?.model, "haiku");
    assert.equal(result?.timeout_ms, 10000);
  } finally {
    config.model = previous;
  }
});

import { AGENT_PROVIDERS } from "../src/agent/provider.ts";
import {
  legacyAgentConfiguration,
  resolveAgentValues,
  parseAgentConfiguration,
  ROUTING_SCOPES,
  ROUTING_ROLES,
} from "../src/agent/configuration.ts";

// A wrong layer order, whole-object inheritance, or cross-provider lookup breaks this matrix.
for (const provider of AGENT_PROVIDERS) {
  for (const scope of ROUTING_SCOPES) {
    for (const role of ROUTING_ROLES) {
      test(`${provider}/${scope}/${role}: fields inherit independently and null stops inheritance`, () => {
        const document = legacyAgentConfiguration();
        const entry = document.providers[provider];
        entry.defaults = { model: "default-model", timeout_ms: 10000 };
        entry.profiles = { "*": { [role]: { model: "any-model", timeout_ms: 20000 } } };
        entry.profiles[scope] = { [role]: { model: "profile-model" } };
        const resolved = resolveAgentValues(document, provider, scope, role, { model: null });
        assert.equal(resolved.values.model, null);
        assert.equal(resolved.sources.model, "step");
        assert.equal(resolved.values.timeout_ms, scope === "*" ? 10000 : 20000);
        assert.equal(
          resolveAgentValues(document, provider, scope, role).values.model,
          "profile-model",
        );
        delete entry.profiles[scope];
        assert.equal(
          resolveAgentValues(document, provider, scope, role).values.model,
          scope === "*" ? "default-model" : "any-model",
        );
        entry.profiles = {};
        assert.equal(
          resolveAgentValues(document, provider, scope, role).values.model,
          "default-model",
        );
        entry.defaults = {};
        assert.equal(
          resolveAgentValues(document, provider, scope, role).sources.model,
          "account/CLI default (external)",
        );
      });
    }
  }
}

test("provider switch discards legacy model, effort and unsupported turns", () => {
  const result = resolveStepAgent(
    { agent_provider: "claude" },
    {
      type: "coding_agent",
      config: {
        model: "opus",
        max_turns: 12,
        agent: { model: "sonnet", max_turns: 10, reasoning_effort: "max" },
      },
      agent_override: { provider: "codex" },
    },
  );
  assert.equal(result?.provider, "codex");
  assert.notEqual(result?.model, "opus");
  assert.notEqual(result?.model, "sonnet");
  assert.equal(result?.max_turns, undefined);
  assert.notEqual(result?.reasoning_effort, "max");
});

test("unsupported controls, incompatible models and credential fields fail closed", () => {
  const document = legacyAgentConfiguration();
  assert.throws(
    () => resolveAgentValues(document, "cursor", "DEEP", "agent", { reasoning_effort: "high" }),
    /does not support/,
  );
  assert.throws(
    () => resolveAgentValues(document, "codex", "DEEP", "agent", { model: "claude-sonnet" }),
    /cannot use/,
  );
  assert.throws(
    () => resolveAgentValues(document, "copilot", "DEEP", "agent", { max_turns: 5 }),
    /does not support/,
  );
  assert.throws(() => parseAgentConfiguration({ ...document, token: "invalid-field" }));
});

test("provider options inherit independently and incompatible options are rejected", () => {
  const document = legacyAgentConfiguration();
  document.providers.copilot.defaults = { options: { sandbox: true, max_concurrent: 2 } };
  document.providers.copilot.profiles.DEEP = { agent: { options: { max_concurrent: 3 } } };
  const resolved = resolveAgentValues(document, "copilot", "DEEP", "agent");
  assert.deepEqual(resolved.values.options, { sandbox: true, max_concurrent: 3 });
  assert.throws(
    () => resolveAgentValues(document, "cursor", "DEEP", "agent", { options: { sandbox: true } }),
    /does not support/,
  );
});

import { completionAgent } from "../src/agent/complete.ts";
test("auxiliary completion resolves the frozen analysis mapping rather than mutable defaults", () => {
  const snapshot = legacyAgentConfiguration();
  snapshot.providers.claude.profiles.DEEP = { agent: { model: "haiku", timeout_ms: 12345 } };
  const agent = completionAgent({
    agent_provider: "claude",
    profile: "DEEP",
    agent_configuration: snapshot,
  });
  assert.equal(agent.model, "haiku");
  assert.equal(agent.timeout_ms, 12345);
  assert.throws(
    () => completionAgent({ agent_provider: "claude", agent_configuration: null }),
    /recovery/,
  );
});

import { completeForRun, type CompletionRunner } from "../src/agent/complete.ts";
import { effectiveStepConfig } from "../src/agent/stepAgent.ts";
test("actual auxiliary completions forward frozen routing to each provider runner", async () => {
  const snapshot = legacyAgentConfiguration();
  for (const provider of AGENT_PROVIDERS) {
    snapshot.providers[provider].defaults = {
      model: "frozen-model",
      timeout_ms: 12345,
      ...(provider === "cursor" ? {} : { reasoning_effort: "high" as const }),
    };
    const runner: CompletionRunner = async (_prompt, opts) => ({
      text: `${opts.model}/${opts.effort}/${opts.timeoutMs}`,
      model: opts.model,
      tokens: null,
    });
    const result = await completeForRun(
      { agent_provider: provider, agent_configuration: snapshot },
      "fixture",
      undefined,
      { claude: runner, codex: runner, cursor: runner, antigravity: runner, copilot: runner },
    );
    assert.equal(result.text, `frozen-model/${provider === "cursor" ? "" : "high"}/12345`);
    assert.equal(result.provider, provider);
  }
});

test("effective step config carries resolved execution limits for all executor consumers", () => {
  const snapshot = legacyAgentConfiguration();
  snapshot.providers.claude.defaults = { model: "haiku", max_turns: 7, timeout_ms: 12345 };
  const effective = resolveStepAgent(
    { agent_provider: "claude", agent_configuration: snapshot },
    { type: "agent", config: {} },
  );
  const cfg = effectiveStepConfig({ max_turns: 99 }, effective);
  assert.equal(cfg.max_turns, 7);
  assert.equal(cfg.timeout_ms, 12345);
});

import { refreshEnvironmentDefaults } from "../src/agent/configuration.ts";
test("environment defaults refresh for new snapshots without overriding configured profiles or saved defaults", () => {
  const previous = process.env.CURSOR_AGENT_TIMEOUT_MS;
  try {
    process.env.CURSOR_AGENT_TIMEOUT_MS = "10000";
    const started = legacyAgentConfiguration();
    process.env.CURSOR_AGENT_TIMEOUT_MS = "20000";
    const fresh = refreshEnvironmentDefaults(started);
    assert.equal(started.providers.cursor.defaults.timeout_ms, 10000);
    assert.equal(fresh.providers.cursor.defaults.timeout_ms, 20000);
    fresh.providers.cursor.profiles.FAST = { agent: { timeout_ms: 30000 } };
    assert.equal(resolveAgentValues(fresh, "cursor", "FAST", "agent").values.timeout_ms, 30000);
    const saved = patchProviderConfiguration(fresh, "cursor", 0, {
      defaults: { timeout_ms: 40000 },
    });
    assert.equal(refreshEnvironmentDefaults(saved).providers.cursor.defaults.timeout_ms, 40000);
    assert.match(
      resolveAgentValues(fresh, "cursor", "DEEP", "agent").sources.timeout_ms!,
      /environment/,
    );
  } finally {
    if (previous === undefined) delete process.env.CURSOR_AGENT_TIMEOUT_MS;
    else process.env.CURSOR_AGENT_TIMEOUT_MS = previous;
  }
});

import { DiscoveryCache } from "../src/agent/providerDiscovery.ts";
test("discovery separates account keys, deduplicates probes and retains stale catalogs after refresh failures", async () => {
  let now = 1000,
    probes = 0;
  const cache = new DiscoveryCache(() => now, 100);
  const probe = async () => {
    probes++;
    return { ok: true, models: [{ slug: "fixture-model", name: "Fixture", efforts: ["high"] }] };
  };
  const [first, duplicate] = await Promise.all([
    cache.get("worker/account-a", probe),
    cache.get("worker/account-a", probe),
  ]);
  assert.equal(probes, 1);
  assert.deepEqual(first.models, duplicate.models);
  assert.equal((await cache.get("worker/account-a", probe)).cache, "cache");
  await cache.get("worker/account-b", probe);
  assert.equal(probes, 2);
  now += 200;
  const failed = await cache.get("worker/account-a", async () => ({ ok: false }), true);
  assert.equal(failed.discovery, "unavailable");
  assert.equal(failed.cache, "stale");
  assert.deepEqual(failed.models[0].efforts, ["high"]);
});

test("MICRO routing keeps tighter profile deadlines while enforcing its safety cap", () => {
  const snapshot = legacyAgentConfiguration();
  snapshot.providers.claude.profiles.MICRO = { agent: { timeout_ms: 10000 } };
  const run = { agent_provider: "claude", profile: "MICRO", agent_configuration: snapshot };
  assert.equal(resolveStepAgent(run, { type: "agent", config: {} })?.timeout_ms, 10000);
  assert.equal(
    resolveStepAgent(run, { type: "agent", config: { agent: { timeout_ms: 900000 } } })?.timeout_ms,
    600000,
  );
});

import { nextHealthyProvider } from "../src/agent/health.ts";
test("handoff selection uses frozen provider enablement rather than later global changes", () => {
  const previous = config.agent.enabledProviders;
  try {
    config.agent.enabledProviders = { claude: false };
    assert.equal(
      nextHealthyProvider(
        ["claude"],
        new Set(),
        [{ provider: "claude", connected: true, quota: "ok" }],
        { claude: true },
      ),
      "claude",
    );
  } finally {
    config.agent.enabledProviders = previous;
  }
});

test("effort and turn limits inherit independently at every level", () => {
  const document = legacyAgentConfiguration();
  const entry = document.providers.claude;
  entry.defaults = { reasoning_effort: "low", max_turns: 5 };
  entry.profiles = {
    "*": { agent: { reasoning_effort: "medium", max_turns: 6 } },
    DEEP: { agent: { reasoning_effort: "high" } },
  };
  const routed = resolveAgentValues(document, "claude", "DEEP", "agent");
  assert.equal(routed.values.reasoning_effort, "high");
  assert.equal(routed.values.max_turns, 6);
  assert.equal(
    resolveAgentValues(document, "claude", "DEEP", "agent", {
      reasoning_effort: null,
      max_turns: 3,
    }).values.reasoning_effort,
    null,
  );
  assert.equal(
    resolveAgentValues(document, "claude", "DEEP", "agent", { max_turns: 3 }).values.max_turns,
    3,
  );
  delete entry.profiles.DEEP;
  assert.equal(
    resolveAgentValues(document, "claude", "DEEP", "agent").values.reasoning_effort,
    "medium",
  );
  entry.profiles = {};
  assert.equal(
    resolveAgentValues(document, "claude", "DEEP", "agent").values.reasoning_effort,
    "low",
  );
  assert.equal(resolveAgentValues(document, "claude", "DEEP", "agent").values.max_turns, 5);
});

test("canceled auxiliary calls never invoke a provider", async () => {
  const runner: CompletionRunner = async () => {
    throw new Error("provider invoked after cancellation");
  };
  await assert.rejects(
    () =>
      completeForRun(
        { agent_provider: "claude", agent_configuration: legacyAgentConfiguration() },
        "fixture",
        AbortSignal.abort(),
        { claude: runner, codex: runner, cursor: runner, antigravity: runner, copilot: runner },
      ),
    { name: "AbortError" },
  );
});
