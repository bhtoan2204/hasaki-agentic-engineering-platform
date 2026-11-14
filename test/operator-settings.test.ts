import { test, after } from "node:test";
import assert from "node:assert/strict";
import { config, antigravityConfig, codexConfig, copilotConfig } from "../src/config.ts";
import { nextHealthyProvider } from "../src/agent/health.ts";
import { substituteEnabledProvider } from "../src/agent/provider.ts";
import { applyOperator, resetOperatorForTests } from "../src/platform/operatorSettings.ts";

const prev = {
  model: config.model,
  maxTurns: config.maxTurns,
  provider: config.agent.defaultProvider,
  codex: { ...config.agent.codex },
  agy: { ...config.agent.antigravity },
  copilot: { ...config.agent.copilot },
  sandbox: process.env.AGY_SANDBOX,
  agyModel: process.env.AGY_MODEL,
  codexModel: process.env.CODEX_MODEL,
  copilotModel: process.env.COPILOT_MODEL,
  copilotSandbox: process.env.COPILOT_SANDBOX,
};

after(() => {
  resetOperatorForTests();
  config.model = prev.model;
  config.maxTurns = prev.maxTurns;
  config.agent.defaultProvider = prev.provider;
  config.agent.enabledProviders = undefined;
  config.agent.codex = prev.codex;
  config.agent.antigravity = prev.agy;
  config.agent.copilot = prev.copilot;
  if (prev.sandbox == null) delete process.env.AGY_SANDBOX;
  else process.env.AGY_SANDBOX = prev.sandbox;
  if (prev.agyModel == null) delete process.env.AGY_MODEL;
  else process.env.AGY_MODEL = prev.agyModel;
  if (prev.codexModel == null) delete process.env.CODEX_MODEL;
  else process.env.CODEX_MODEL = prev.codexModel;
  if (prev.copilotModel == null) delete process.env.COPILOT_MODEL;
  else process.env.COPILOT_MODEL = prev.copilotModel;
  if (prev.copilotSandbox == null) delete process.env.COPILOT_SANDBOX;
  else process.env.COPILOT_SANDBOX = prev.copilotSandbox;
});

test("saved settings win over env and config.json; clearing restores the startup values", () => {
  resetOperatorForTests();
  process.env.AGY_SANDBOX = "true";
  process.env.AGY_MODEL = "from-env";
  process.env.CODEX_MODEL = "codex-env";
  process.env.COPILOT_MODEL = "copilot-env";
  process.env.COPILOT_SANDBOX = "true";
  applyOperator({});
  assert.equal(antigravityConfig().sandbox, true);
  assert.equal(antigravityConfig().model, "from-env");
  assert.equal(codexConfig().model, "codex-env");
  assert.equal(copilotConfig().model, "copilot-env");
  assert.equal(copilotConfig().sandbox, true);

  applyOperator({
    antigravity: { model: "gemini-flash", effort: "low", sandbox: false, maxConcurrent: 2 },
    codex: { model: "gpt-ui", reasoningEffort: "low" },
    copilot: { model: "gpt-4.1", effort: "high", sandbox: false, maxConcurrent: 3 },
  });
  const agy = antigravityConfig();
  assert.equal(agy.sandbox, false);
  assert.equal(agy.model, "gemini-flash");
  assert.equal(agy.effort, "low");
  assert.equal(agy.maxConcurrent, 2);
  assert.equal(codexConfig().model, "gpt-ui");
  assert.equal(codexConfig().reasoningEffort, "low");
  const copilot = copilotConfig();
  assert.equal(copilot.model, "gpt-4.1");
  assert.equal(copilot.effort, "high");
  assert.equal(copilot.sandbox, false);
  assert.equal(copilot.maxConcurrent, 3);

  applyOperator({});
  assert.equal(antigravityConfig().sandbox, true);
  assert.equal(antigravityConfig().model, "from-env");
  assert.equal(codexConfig().model, "codex-env");
  assert.equal(copilotConfig().model, "copilot-env");
  assert.equal(copilotConfig().sandbox, true);
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
    enabledProviders: {
      claude: false,
      cursor: false,
      codex: false,
      antigravity: false,
      copilot: false,
    },
  });
  assert.throws(() => substituteEnabledProvider("claude"), /enabled in Settings/);
});
