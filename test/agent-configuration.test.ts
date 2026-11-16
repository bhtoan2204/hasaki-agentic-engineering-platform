import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { resolveStepAgent } from "../src/agent/stepAgent.ts";
import { convertLegacyConfiguration, patchProviderConfiguration } from "../src/agent/configuration.ts";

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
  const next = patchProviderConfiguration(original, "copilot", 0, { defaults: { model: "selected-model" }, enabled: false });
  assert.deepEqual(next.providers.claude, original.providers.claude);
  assert.equal(next.providers.copilot.revision, 1);
  assert.throws(() => patchProviderConfiguration(next, "copilot", 0, { enabled: true }), /revision conflict/);
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
  assert.throws(() => resolveAgentValues(document, "cursor", "DEEP", "agent", { options: { sandbox: true } }), /does not support/);
});

import { completionAgent } from "../src/agent/complete.ts";
test("auxiliary completion resolves the frozen analysis mapping rather than mutable defaults", () => {
  const snapshot = legacyAgentConfiguration();
  snapshot.providers.claude.profiles.DEEP = { agent: { model: "haiku", timeout_ms: 12345 } };
  const agent = completionAgent({ agent_provider: "claude", profile: "DEEP", agent_configuration: snapshot });
  assert.equal(agent.model, "haiku");
  assert.equal(agent.timeout_ms, 12345);
  assert.throws(() => completionAgent({ agent_provider: "claude", agent_configuration: null }), /recovery/);
});
