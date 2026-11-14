import { test, after } from "node:test";
import assert from "node:assert/strict";
import { config, antigravityConfig, codexConfig } from "../src/config.ts";
import { nextHealthyProvider } from "../src/agent/health.ts";
import { substituteEnabledProvider } from "../src/agent/provider.ts";
import { applyOperator, resetOperatorForTests } from "../src/platform/operatorSettings.ts";

const prev = {
  model: config.model,
  maxTurns: config.maxTurns,
  provider: config.agent.defaultProvider,
  codex: { ...config.agent.codex },
  agy: { ...config.agent.antigravity },
  sandbox: process.env.AGY_SANDBOX,
  agyModel: process.env.AGY_MODEL,
  codexModel: process.env.CODEX_MODEL,
};

after(() => {
  resetOperatorForTests();
  config.model = prev.model;
  config.maxTurns = prev.maxTurns;
  config.agent.defaultProvider = prev.provider;
  config.agent.enabledProviders = undefined;
  config.agent.codex = prev.codex;
  config.agent.antigravity = prev.agy;
  if (prev.sandbox == null) delete process.env.AGY_SANDBOX;
  else process.env.AGY_SANDBOX = prev.sandbox;
  if (prev.agyModel == null) delete process.env.AGY_MODEL;
  else process.env.AGY_MODEL = prev.agyModel;
  if (prev.codexModel == null) delete process.env.CODEX_MODEL;
  else process.env.CODEX_MODEL = prev.codexModel;
});

test("saved settings win over env and config.json; clearing restores the startup values", () => {
  resetOperatorForTests();
  process.env.AGY_SANDBOX = "true";
  process.env.AGY_MODEL = "from-env";
  process.env.CODEX_MODEL = "codex-env";
  applyOperator({});
  assert.equal(antigravityConfig().sandbox, true);
  assert.equal(antigravityConfig().model, "from-env");
  assert.equal(codexConfig().model, "codex-env");

  applyOperator({
    antigravity: { model: "gemini-flash", effort: "low", sandbox: false, maxConcurrent: 2 },
    codex: { model: "gpt-ui", reasoningEffort: "low" },
  });
  const agy = antigravityConfig();
  assert.equal(agy.sandbox, false);
  assert.equal(agy.model, "gemini-flash");
  assert.equal(agy.effort, "low");
  assert.equal(agy.maxConcurrent, 2);
  assert.equal(codexConfig().model, "gpt-ui");
  assert.equal(codexConfig().reasoningEffort, "low");

  applyOperator({});
  assert.equal(antigravityConfig().sandbox, true);
  assert.equal(antigravityConfig().model, "from-env");
  assert.equal(codexConfig().model, "codex-env");
});

test("an off provider is replaced by one that is on, and health fallback skips it", () => {
  resetOperatorForTests();
  applyOperator({
    defaultProvider: "claude",
    enabledProviders: { claude: true, cursor: false, codex: true, antigravity: false },
  });
  assert.equal(substituteEnabledProvider("antigravity"), "claude");
  assert.equal(substituteEnabledProvider("cursor"), "claude");
  assert.equal(substituteEnabledProvider("codex"), "codex");
  applyOperator({
    defaultProvider: "codex",
    enabledProviders: { claude: false, cursor: false, codex: true, antigravity: false },
  });
  assert.equal(substituteEnabledProvider("claude"), "codex");
  assert.equal(
    nextHealthyProvider(["claude", "codex"], new Set(), [
      { provider: "claude", connected: true, quota: "ok" },
      { provider: "codex", connected: true, quota: "ok" },
    ]),
    "codex",
  );
  applyOperator({
    enabledProviders: { claude: false, cursor: false, codex: false, antigravity: false },
  });
  assert.throws(() => substituteEnabledProvider("claude"), /enabled in Settings/);
});
