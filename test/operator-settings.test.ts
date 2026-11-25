import { test, after } from "node:test";
import assert from "node:assert/strict";
import { config, antigravityConfig, codexConfig, copilotConfig } from "../src/config.ts";
import { nextHealthyProvider } from "../src/agent/health.ts";
import { substituteEnabledProvider } from "../src/agent/provider.ts";
import { applyOperator, resetOperatorForTests } from "../src/platform/operatorSettings.ts";
import { modelFor } from "../src/agent/stepAgent.ts";

const prev = {
  model: config.model,
  models: config.agent.models,
  maxTurns: config.maxTurns,
  provider: config.agent.defaultProvider,
  codex: { ...config.agent.codex },
  agy: { ...config.agent.antigravity },
  copilot: { ...config.agent.copilot },
  sandbox: process.env.AGY_SANDBOX,
  agyModel: config.agentEnv.agyModel,
  codexModel: config.agentEnv.codexModel,
  copilotModel: config.agentEnv.copilotModel,
  copilotSandbox: config.agentEnv.copilotSandbox,
};

after(() => {
  resetOperatorForTests();
  config.model = prev.model;
  config.agent.models = prev.models;
  config.maxTurns = prev.maxTurns;
  config.agent.defaultProvider = prev.provider;
  config.agent.enabledProviders = undefined;
  config.agent.codex = prev.codex;
  config.agent.antigravity = prev.agy;
  config.agent.copilot = prev.copilot;
  if (prev.sandbox == null) delete process.env.AGY_SANDBOX;
  else process.env.AGY_SANDBOX = prev.sandbox;
  if (prev.agyModel == null) config.agentEnv.agyModel = undefined;
  else config.agentEnv.agyModel = prev.agyModel;
  if (prev.codexModel == null) config.agentEnv.codexModel = undefined;
  else config.agentEnv.codexModel = prev.codexModel;
  if (prev.copilotModel == null) config.agentEnv.copilotModel = undefined;
  else config.agentEnv.copilotModel = prev.copilotModel;
  if (prev.copilotSandbox == null) config.agentEnv.copilotSandbox = undefined;
  else config.agentEnv.copilotSandbox = prev.copilotSandbox;
});

test("saved settings win over env and config.json; clearing restores the startup values", () => {
  resetOperatorForTests();
  process.env.AGY_SANDBOX = "true";
  config.agentEnv.agyModel = "from-env";
  config.agentEnv.codexModel = "codex-env";
  config.agentEnv.copilotModel = "copilot-env";
  config.agentEnv.copilotSandbox = "true";
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

test("Claude model routing per profile and role is saved in Settings and restored on clear", () => {
  resetOperatorForTests();
  config.agent.models = { "*": { agent: "from-config" } };
  config.model = "";
  applyOperator({});
  const plan = { type: "agent", config: {} };
  const coding = { type: "coding_agent", config: {} };
  assert.equal(modelFor(plan, "DEEP").model, "from-config");

  applyOperator({ models: { DEEP: { agent: "opus" } } });
  assert.deepEqual(modelFor(plan, "DEEP"), { model: "opus", source: "routing DEEP/agent" });
  assert.equal(
    modelFor(plan, "STANDARD").model,
    "",
    "the saved routing replaces config.json routing",
  );
  assert.equal(modelFor(coding, "DEEP").model, "");

  applyOperator({});
  assert.equal(modelFor(plan, "DEEP").model, "from-config");
});

test("attachment URL, related projects and Bitbucket access policy are Settings-owned", () => {
  resetOperatorForTests();
  const prev = {
    fileBaseUrl: config.fileBaseUrl,
    related: config.relatedProjects,
    access: config.bitbucket.accessVerification,
  };
  try {
    config.fileBaseUrl = "https://files.example/a";
    config.relatedProjects = { OMS: ["Payment"] };
    config.bitbucket.accessVerification = "personal";
    applyOperator({});
    applyOperator({
      fileBaseUrl: "https://files.example/b",
      relatedProjects: { OMS: ["Payment", "Warranty"] },
      bitbucketAccess: "strict",
    });
    assert.equal(config.fileBaseUrl, "https://files.example/b");
    assert.deepEqual(config.relatedProjects, { OMS: ["Payment", "Warranty"] });
    assert.equal(config.bitbucket.accessVerification, "strict");
    applyOperator({});
    assert.equal(config.fileBaseUrl, "https://files.example/a");
    assert.deepEqual(config.relatedProjects, { OMS: ["Payment"] });
    assert.equal(config.bitbucket.accessVerification, "personal");
  } finally {
    resetOperatorForTests();
    config.fileBaseUrl = prev.fileBaseUrl;
    config.relatedProjects = prev.related;
    config.bitbucket.accessVerification = prev.access;
  }
});

test("GitLab instances are Settings-owned and gate which GitLab URLs are accepted", async () => {
  const { repositoryRemote } = await import("../src/repos/remote.ts");
  resetOperatorForTests();
  const prev = structuredClone(config.gitlab.instances);
  try {
    config.gitlab.instances = [{ host: "gitlab.com" }];
    applyOperator({});
    assert.throws(() => repositoryRemote("https://gitlab.example.work/payment/payment-paypal.git"));
    applyOperator({ gitlabInstances: [{ host: "gitlab.example.work", sshPort: 2222 }] });
    const r = repositoryRemote("https://gitlab.example.work/payment/payment-paypal.git");
    assert.equal(r.provider, "gitlab");
    assert.equal(r.host, "gitlab.example.work");
    assert.deepEqual(config.gitlab.instances, [{ host: "gitlab.example.work", sshPort: 2222 }]);
    applyOperator({});
    assert.deepEqual(config.gitlab.instances, [{ host: "gitlab.com" }]);
  } finally {
    resetOperatorForTests();
    config.gitlab.instances = prev;
  }
});

test("a GitLab instance can be entered as a URL; only the bare host is kept", async () => {
  const { gitlabHostFrom } = await import("../src/platform/operatorSettings.ts");
  assert.equal(gitlabHostFrom("http://gitlab.example.work/"), "gitlab.example.work");
  assert.equal(
    gitlabHostFrom(" HTTPS://user@GitLab.Example.com:8443/group/project.git "),
    "gitlab.example.com",
  );
  assert.equal(gitlabHostFrom("gitlab.example.work"), "gitlab.example.work");
  for (const bad of ["", "localhost", "http://", "not a host"])
    assert.throws(() => gitlabHostFrom(bad), bad);
});
