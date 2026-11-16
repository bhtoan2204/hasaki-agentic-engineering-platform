import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool, q } from "../src/db/pool.ts";
import {
  loadAgentConfiguration,
  saveProviderConfiguration,
} from "../src/agent/configurationStore.ts";

after(() => pool.end());
test("persistent provider patches serialize and retain independent provider updates", async () => {
  await q(pool, "DELETE FROM settings WHERE key='agent_configuration'");
  const original = await loadAgentConfiguration();
  await Promise.all([
    saveProviderConfiguration("claude", original.providers.claude.revision, {
      defaults: { model: "sonnet" },
    }),
    saveProviderConfiguration("copilot", original.providers.copilot.revision, {
      defaults: { model: "selected-model" },
    }),
  ]);
  const next = await loadAgentConfiguration();
  assert.equal(next.providers.claude.defaults.model, "sonnet");
  assert.equal(next.providers.copilot.defaults.model, "selected-model");
  await assert.rejects(
    () => saveProviderConfiguration("claude", 0, { defaults: {} }),
    /revision conflict/,
  );
  await q(pool, "UPDATE settings SET value='{}' WHERE key='agent_configuration'");
  await assert.rejects(() => loadAgentConfiguration());
});

import { definitions } from "../src/workflow/definitions.ts";
import { createUser } from "../src/auth/users.ts";
import { startRun, getRun } from "../src/workflow/engine.ts";
import { resolveStepAgent } from "../src/agent/stepAgent.ts";

test("new runs capture updated defaults while existing runs retain their routing snapshot", async () => {
  await q(pool, "DELETE FROM settings WHERE key='agent_configuration'");
  const initial = await loadAgentConfiguration();
  await saveProviderConfiguration("claude", initial.providers.claude.revision, {
    defaults: { model: "haiku", timeout_ms: 10000 },
  });
  const owner = await createUser({
    username: "configuration-owner",
    password: "local-test-password",
    role: "member",
  });
  await definitions.create({
    key: "configuration-snapshot",
    spec: {
      name: "Configuration snapshot",
      steps: [
        { key: "analysis", type: "agent", config: { instructions: "Analyze the fixture" } },
        {
          key: "verify",
          type: "agent",
          depends_on: ["analysis"],
          config: { independent: true, instructions: "Verify the fixture" },
        },
      ],
    },
  });
  const input = {
    definitionKey: "configuration-snapshot",
    ownerId: owner.id,
    agentProvider: "claude",
    profile: "STANDARD" as const,
    start: false,
  };
  const first = await startRun(input);
  const saved = await loadAgentConfiguration();
  await saveProviderConfiguration("claude", saved.providers.claude.revision, {
    defaults: { model: "opus", timeout_ms: 20000 },
  });
  const second = await startRun(input);
  const old = await getRun(first.id),
    fresh = await getRun(second.id);
  for (const independent of [false, true]) {
    assert.equal(resolveStepAgent(old, { type: "agent", config: { independent } })?.model, "haiku");
    assert.equal(
      resolveStepAgent(fresh, { type: "agent", config: { independent } })?.model,
      "opus",
    );
  }
  await assert.rejects(
    () =>
      q(pool, "UPDATE workflow_runs SET agent_configuration=$2 WHERE id=$1", [
        first.id,
        JSON.stringify(fresh.agent_configuration),
      ]),
    /immutable/,
  );
});

import { saveOperatorSettings } from "../src/platform/operatorSettings.ts";
test("legacy Settings edits delegate to canonical routing after initial import", async () => {
  const before = await loadAgentConfiguration();
  await saveOperatorSettings({ model: "sonnet" });
  const next = await loadAgentConfiguration();
  assert.equal(next.providers.claude.defaults.model, "sonnet");
  assert.deepEqual(next.providers.copilot, before.providers.copilot);
  await saveOperatorSettings({ fileBaseUrl: "https://files.example.invalid" });
  assert.equal((await loadAgentConfiguration()).providers.claude.defaults.model, "sonnet");
});

import { saveDefaultProvider } from "../src/agent/configurationStore.ts";
import { previewAgentConfiguration } from "../src/api/agentConfiguration.ts";
test("default changes and disable/re-enable preserve independent provider values and preview routing", async () => {
  const before = await loadAgentConfiguration();
  await saveDefaultProvider({ provider: "copilot", revision: before.default_revision ?? 0 });
  const changed = await loadAgentConfiguration();
  assert.deepEqual(changed.providers, before.providers);
  await assert.rejects(
    () => saveDefaultProvider({ provider: "claude", revision: before.default_revision ?? 0 }),
    /revision conflict/,
  );
  await saveDefaultProvider({ provider: "claude", revision: changed.default_revision });
  const disabled = await saveProviderConfiguration("copilot", changed.providers.copilot.revision, {
    enabled: false,
  });
  const reenabled = await saveProviderConfiguration(
    "copilot",
    disabled.providers.copilot.revision,
    { enabled: true },
  );
  assert.deepEqual(reenabled.providers.copilot.defaults, changed.providers.copilot.defaults);
  const preview = await previewAgentConfiguration({
    provider: "copilot",
    scope: "FAST",
    role: "verifier",
    draft: {
      profiles: {
        "*": { verifier: { model: "any-model" } },
        FAST: { verifier: { reasoning_effort: "high" } },
      },
    },
  });
  assert.equal(preview.values.model, "any-model");
  assert.equal(preview.values.reasoning_effort, "high");
  assert.equal(preview.sources.model, "profile */verifier");
});
