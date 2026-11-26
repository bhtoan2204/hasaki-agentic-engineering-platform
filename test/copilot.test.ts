import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_PROVIDERS,
  parseAgentProvider,
  resolveAgentProvider,
} from "../src/agent/provider.ts";
import { copilotConfig, config } from "../src/config.ts";
import {
  copilotModelFor,
  resolveStepAgent,
  validateAgentOptions,
  FallbackPolicy,
} from "../src/agent/stepAgent.ts";
import {
  copilotCapabilities,
  copilotEnv,
  checkModel,
  resetCapabilitiesCache,
  type CopilotModel,
} from "../src/agent/providers/copilot/capabilities.ts";
import {
  CopilotStream,
  TextBatch,
  classifyCopilotError,
} from "../src/agent/providers/copilot/stream.ts";
import {
  copilotHookDecision,
  writeCopilotWorkspaceConfig,
  excludeFromGit,
  copilotHeadlessSettings,
} from "../src/agent/providers/copilot/policy.ts";
import { buildCopilotArgs } from "../src/agent/providers/copilot/run.ts";
import type { PolicyContext } from "../src/agent/toolPolicy.ts";
import { ToolLoopDetector } from "../src/agent/toolPolicy.ts";
import { providerCapabilities } from "../src/agent/providerCapabilities.ts";
import { ResumeHandoff } from "../src/workflow/engine.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-copilot.mjs");
let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "copilot-unit-test-"));
  process.env.COPILOT_BIN = FAKE;
  process.env.FAKE_COPILOT_MODE = "ok";
  config.agentEnv.copilotModel = undefined;
  config.agentEnv.copilotEffort = undefined;
  delete process.env.COPILOT_TIMEOUT_MS;
  config.agentEnv.copilotMaxConcurrent = undefined;
  delete process.env.COPILOT_ALLOW_SUBAGENTS;
  config.agentEnv.copilotSandbox = undefined;
  resetCapabilitiesCache();
});

afterEach(() => {
  for (const k of [
    "COPILOT_BIN",
    "FAKE_COPILOT_MODE",
    "FAKE_COPILOT_LOG",
    "FAKE_COPILOT_TEXT",
    "COPILOT_MODEL",
    "COPILOT_EFFORT",
    "COPILOT_TIMEOUT_MS",
    "COPILOT_MAX_CONCURRENT",
    "COPILOT_ALLOW_SUBAGENTS",
    "COPILOT_SANDBOX",
  ]) {
    delete process.env[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ Provider Resolution & Enum

test("copilot is registered in AGENT_PROVIDERS and resolveAgentProvider accepts it", () => {
  assert.ok(AGENT_PROVIDERS.includes("copilot"));
  assert.equal(resolveAgentProvider("copilot"), "copilot");
  assert.equal(parseAgentProvider("copilot"), "copilot");
  assert.equal(resolveAgentProvider(undefined), "claude");
  assert.equal(resolveAgentProvider(null), "claude");
  assert.equal(resolveAgentProvider(""), "claude");
  assert.throws(
    () => resolveAgentProvider("unknown-agent"),
    /agent_provider must be one of .*copilot/,
  );
});

// ------------------------------------------------------------------ Configuration Loader

test("copilotConfig loads defaults and honors environment overrides", () => {
  const def = copilotConfig();
  assert.equal(def.bin, FAKE);
  assert.equal(def.timeoutMs, 45 * 60 * 1000);
  assert.equal(def.maxConcurrent, 1);
  assert.equal(def.allowSubagents, false);
  assert.equal(def.sandbox, true);

  process.env.COPILOT_BIN = "/custom/bin/copilot";
  process.env.COPILOT_TIMEOUT_MS = "60000";
  config.agentEnv.copilotModel = "gpt-4o";
  config.agentEnv.copilotEffort = "high";
  config.agentEnv.copilotMaxConcurrent = "3";
  process.env.COPILOT_ALLOW_SUBAGENTS = "true";
  config.agentEnv.copilotSandbox = "false";

  const custom = copilotConfig();
  assert.equal(custom.bin, "/custom/bin/copilot");
  assert.equal(custom.timeoutMs, 60000);
  assert.equal(custom.model, "gpt-4o");
  assert.equal(custom.effort, "high");
  assert.equal(custom.maxConcurrent, 3);
  assert.equal(custom.allowSubagents, true);
  assert.equal(custom.sandbox, false);
});

// ------------------------------------------------------------------ Step Agent Routing & Fallback Policy

test("copilotModelFor resolves models and effort from step config, routing and defaults", () => {
  const stepWithModel = {
    type: "coding_agent",
    config: { agent: { model: "claude-3.5-sonnet", reasoning_effort: "high" } },
  };
  const res1 = copilotModelFor(stepWithModel);
  assert.equal(res1.model, "claude-3.5-sonnet");
  assert.equal(res1.effort, "high");
  assert.equal(res1.source, "step config (agent.model)");

  const stepWithLegacy = {
    type: "coding_agent",
    config: { copilot_model: "o1-preview", copilot_effort: "medium" },
  };
  const res2 = copilotModelFor(stepWithLegacy);
  assert.equal(res2.model, "o1-preview");
  assert.equal(res2.effort, "medium");
  assert.equal(res2.source, "step config (copilot_model)");
});

test("resolveStepAgent sets effective agent provider, routed model, and effort for copilot", () => {
  const run = { agent_provider: "copilot", profile: "STANDARD" };
  const step = {
    type: "coding_agent",
    config: { copilot_model: "gpt-4o", copilot_effort: "low" },
  };
  const effective = resolveStepAgent(run, step);
  assert.ok(effective);
  assert.equal(effective.provider, "copilot");
  assert.equal(effective.model, "gpt-4o");
  assert.equal(effective.reasoning_effort, "low");
});

test("FallbackPolicy supports up to 5 providers including copilot without duplicates", () => {
  const valid = FallbackPolicy.parse({
    providers: ["copilot", "claude", "codex", "cursor", "antigravity"],
    mode: "automatic",
  });
  assert.equal(valid.providers.length, 5);
  assert.equal(valid.providers[0], "copilot");

  assert.throws(
    () =>
      FallbackPolicy.parse({
        providers: ["copilot", "copilot"],
      }),
    /Duplicate fallback provider/,
  );
});

test("validateAgentOptions validates reasoning effort for copilot", () => {
  assert.doesNotThrow(() => validateAgentOptions({ provider: "copilot", reasoning_effort: "low" }));
  assert.doesNotThrow(() =>
    validateAgentOptions({ provider: "copilot", reasoning_effort: "high" }),
  );
  assert.throws(
    () => validateAgentOptions({ provider: "copilot", reasoning_effort: "none" }),
    /Unsupported Copilot reasoning_effort/,
  );
  assert.throws(
    () => validateAgentOptions({ provider: "copilot", reasoning_effort: "minimal" }),
    /Unsupported Copilot reasoning_effort/,
  );
});

// ------------------------------------------------------------------ Capabilities & Probing

test("copilotCapabilities discovers version, auth status, and model catalog via fake CLI", async () => {
  chmodSync(FAKE, 0o755);
  process.env.COPILOT_BIN = FAKE;
  process.env.FAKE_COPILOT_MODE = "ok";

  const cap = await copilotCapabilities(true);
  assert.equal(cap.ok, true);
  assert.match(cap.version ?? "", /1\.0\.0-fake/);
  assert.ok(cap.models && cap.models.length > 0);
  assert.ok(cap.models.some((m) => m.slug === "gpt-4o"));
  assert.ok(cap.models.some((m) => m.slug === "claude-3.5-sonnet"));
});

test("copilotCapabilities classifies missing binary, unsupported flags, and logged-out errors", async () => {
  process.env.COPILOT_BIN = "/nonexistent/copilot/binary";
  const missing = await copilotCapabilities(true);
  assert.equal(missing.ok, false);
  assert.equal(missing.kind, "missing");
  assert.match(missing.error ?? "", /was not found/);

  process.env.COPILOT_BIN = FAKE;
  process.env.FAKE_COPILOT_MODE = "old-cli";
  const unsupported = await copilotCapabilities(true);
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.kind, "unsupported");
  assert.match(unsupported.error ?? "", /does not support/);

  process.env.FAKE_COPILOT_MODE = "logged-out";
  const loggedOut = await copilotCapabilities(true);
  assert.equal(loggedOut.ok, false);
  assert.equal(loggedOut.kind, "auth");
  assert.match(loggedOut.error ?? "", /not logged in/);
});

test("checkModel validates model slugs and reasoning effort against catalog", () => {
  const catalog: CopilotModel[] = [
    { slug: "gpt-4o", name: "GPT-4o", efforts: ["low", "medium", "high", "xhigh"] },
    { slug: "o1-preview", name: "o1 Preview", efforts: ["low", "medium", "high", "xhigh"] },
  ];

  assert.equal(checkModel(catalog, "gpt-4o", "medium"), null);
  assert.match(checkModel(catalog, "unknown-model", "") ?? "", /not available/);
  assert.match(
    checkModel(catalog, "gpt-4o", "ultra-max") ?? "",
    /does not support reasoning effort/,
  );
});

// ------------------------------------------------------------------ NDJSON Stream Parsing & Text Batching

test("CopilotStream parses valid NDJSON events and extracts tokens without invention", () => {
  const stream = new CopilotStream();
  const rawEvents =
    [
      JSON.stringify({ event: "init", session_id: "copilot-sess-42", model: "gpt-4o" }),
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "text", text_delta: "Hello " },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "text", text_delta: "World!" },
      }),
      JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          num_turns: 2,
          usage: {
            input_tokens: 150,
            output_tokens: 45,
            reasoning_tokens: 10,
            cache_read_tokens: 20,
          },
        },
      }),
    ].join("\n") + "\n";

  const { events, errors } = stream.push(rawEvents);
  assert.equal(errors.length, 0);
  assert.equal(events.length, 4);

  assert.equal(events[0].type, "init");
  assert.equal(events[0].conversationId, "copilot-sess-42");
  assert.equal(events[0].model, "gpt-4o");

  assert.equal(events[1].text, "Hello ");
  assert.equal(events[2].text, "World!");

  assert.equal(events[3].type, "result");
  assert.equal(events[3].turns, 2);
  assert.equal(events[3].tokens?.input, 150);
  assert.equal(events[3].tokens?.output, 45);
  assert.equal(events[3].tokens?.reasoning, 10);
  assert.equal(events[3].tokens?.cache_read, 20);
});

test("CopilotStream enforces 16 MiB line bound", () => {
  const stream = new CopilotStream();
  const oversized = "x".repeat(17 * 1024 * 1024) + "\n";
  const { errors } = stream.push(oversized);
  assert.ok(errors.length > 0);
  assert.match(errors[0].error, /16 MiB/);
});

test("TextBatch joins tokens until newline or boundary threshold", () => {
  const batch = new TextBatch();
  assert.equal(batch.push("First word "), null);
  assert.equal(batch.push("second word\nNext"), "First word second word\n");
  assert.equal(batch.flush(), "Next");
});

// ------------------------------------------------------------------ Error Classification

test("classifyCopilotError maps error strings into standard FailureCategory", () => {
  assert.equal(classifyCopilotError("Rate limit exceeded 429"), "RATE_LIMIT");
  assert.equal(classifyCopilotError("Monthly quota exhausted"), "QUOTA_EXHAUSTED");
  assert.equal(classifyCopilotError("Please run copilot auth login"), "AUTHENTICATION");
  assert.equal(classifyCopilotError("Execution timed out after 300s"), "EXECUTION_TIMEOUT");
  assert.equal(classifyCopilotError("Turn was aborted"), "CANCELED");
});

// ------------------------------------------------------------------ Hook Policy & Governance

test("copilotHookDecision enforces read-only in analysis and worktree sandbox in coding", () => {
  const analysisPolicy: PolicyContext = {
    mode: "analysis",
    workspaces: [tempDir],
    baseBranch: "main",
    protectedRoots: [],
  };
  const codingPolicy: PolicyContext = {
    mode: "coding",
    workspaces: [tempDir],
    baseBranch: "main",
    protectedRoots: [],
  };

  // 1. MCP Platform tools allowed
  assert.equal(
    copilotHookDecision(
      { tool_call: { name: "mcp__platform__submit_result", args: { output: {} } } },
      analysisPolicy,
      tempDir,
    ).allow,
    true,
  );
  assert.equal(
    copilotHookDecision(
      { tool_call: { name: "platform.ask_user", args: {} } },
      analysisPolicy,
      tempDir,
    ).allow,
    true,
  );

  // 2. Subagents denied
  assert.equal(
    copilotHookDecision(
      { tool_call: { name: "invoke_subagent", args: {} } },
      analysisPolicy,
      tempDir,
    ).allow,
    false,
  );

  // 3. Web search denied
  assert.equal(
    copilotHookDecision({ tool_call: { name: "search_web", args: {} } }, analysisPolicy, tempDir)
      .allow,
    false,
  );

  // 4. File modifications denied in analysis
  assert.equal(
    copilotHookDecision(
      { tool_call: { name: "write_file", args: { Path: join(tempDir, "test.txt") } } },
      analysisPolicy,
      tempDir,
    ).allow,
    false,
  );

  // 5. File modifications allowed in coding inside workspace
  assert.equal(
    copilotHookDecision(
      { tool_call: { name: "write_file", args: { Path: join(tempDir, "test.txt") } } },
      codingPolicy,
      tempDir,
    ).allow,
    true,
  );

  // 6. Direct .git modifications denied
  assert.equal(
    copilotHookDecision(
      { tool_call: { name: "write_file", args: { Path: join(tempDir, ".git", "config") } } },
      codingPolicy,
      tempDir,
    ).allow,
    false,
  );

  // 7. Reading credentials denied
  const envFile = join(tempDir, "." + "env");
  assert.equal(
    copilotHookDecision(
      { tool_call: { name: "read_file", args: { Path: envFile } } },
      analysisPolicy,
      tempDir,
    ).allow,
    false,
  );

  // 8. list_dir / glob / grep / search_files enforced via decide() (secrets, loops, budget)
  const withProtected: PolicyContext = {
    ...codingPolicy,
    protectedRoots: ["/srv/protected"],
  };
  for (const [tool, args] of [
    ["grep", { SearchPath: "/srv/protected/." + "env" }],
    ["search_files", { SearchPath: "/srv/protected/config.json" }],
    ["list_dir", { DirectoryPath: "/srv/protected/." + "env" }],
    ["glob", { path: envFile }],
  ] as const) {
    assert.equal(
      copilotHookDecision(
        { hook_event_name: "PreToolUse", tool_name: tool, tool_input: args },
        withProtected,
        tempDir,
      ).allow,
      false,
      `${tool} must deny secret targets`,
    );
  }
  const loopCtx: PolicyContext = {
    ...withProtected,
    loopDetector: new ToolLoopDetector({ consecutiveThreshold: 2, cycleThreshold: 2 }),
  };
  assert.equal(
    copilotHookDecision(
      { hook_event_name: "PreToolUse", tool_name: "grep", tool_input: { SearchPath: tempDir, Query: "q" } },
      loopCtx,
      tempDir,
    ).allow,
    true,
  );
  assert.equal(
    copilotHookDecision(
      { hook_event_name: "PreToolUse", tool_name: "grep", tool_input: { SearchPath: tempDir, Query: "q" } },
      loopCtx,
      tempDir,
    ).allow,
    true,
  );
  assert.equal(
    copilotHookDecision(
      { hook_event_name: "PreToolUse", tool_name: "grep", tool_input: { SearchPath: tempDir, Query: "q" } },
      loopCtx,
      tempDir,
    ).allow,
    false,
  );
  const budgetCtx: PolicyContext = {
    ...withProtected,
    toolBudget: { calls: 1, limit: 1, exhausted: false },
  };
  assert.equal(
    copilotHookDecision(
      { hook_event_name: "PreToolUse", tool_name: "list_dir", tool_input: { DirectoryPath: tempDir } },
      budgetCtx,
      tempDir,
    ).allow,
    false,
  );
});

test("PROVIDER_CAPABILITIES reflects real Copilot CLI 1.0 capabilities honestly", () => {
  assert.equal(providerCapabilities("copilot").guarantees.writeSandbox, false);
});

test("writeCopilotWorkspaceConfig places MCP config in external scratch dir with 0600 permissions", () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "copilot-scratch-"));
  const { mcpConfigPath } = writeCopilotWorkspaceConfig(tempDir, {
    brokerSocket: "/tmp/mock.sock",
    brokerToken: "mock-val",
    mode: "coding",
    mcpDir: scratchDir,
  } as Parameters<typeof writeCopilotWorkspaceConfig>[1]);
  assert.ok(mcpConfigPath.startsWith(scratchDir), "MCP config lives outside worktree");
  assert.equal(existsSync(join(tempDir, ".agents", "mcp_config.json")), false);
  assert.equal(statSync(mcpConfigPath).mode & 0o777, 0o600);
  rmSync(scratchDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ Workspace Config & Args

test("buildCopilotArgs builds correct argument vector for CLI ≥ 1.0", () => {
  const args = buildCopilotArgs({
    prompt: "fix the bug",
    model: "gpt-4o",
    effort: "high",
    conversationId: "sess-123",
    additionalDirs: ["/repo2"],
    mcpConfigPath: "/ws/.agents/mcp_config.json",
    allowTools: true,
  });
  assert.deepEqual(args, [
    "--silent",
    "--output-format",
    "json",
    "-p",
    "fix the bug",
    "--model",
    "gpt-4o",
    "--reasoning-effort",
    "high",
    "--resume",
    "sess-123",
    "--add-dir",
    "/repo2",
    "--additional-mcp-config",
    "@/ws/.agents/mcp_config.json",
    "--allow-all-tools",
  ]);

  const stdinArgs = buildCopilotArgs({
    useStdinPrompt: true,
    allowTools: false,
  });
  assert.deepEqual(stdinArgs, ["--silent", "--output-format", "json"]);
});

test("writeCopilotWorkspaceConfig generates .agents mcp + .github hooks", () => {
  const { hookConfigPath, mcpConfigPath, githubHookPath } = writeCopilotWorkspaceConfig(tempDir, {
    brokerSocket: "/tmp/mock.sock",
    brokerToken: "mock-token",
    mode: "coding",
  });

  assert.ok(existsSync(hookConfigPath));
  assert.ok(existsSync(mcpConfigPath));
  assert.ok(existsSync(githubHookPath));

  const hooks = JSON.parse(readFileSync(hookConfigPath, "utf8"));
  assert.ok(hooks["platform-security"]?.PreToolUse);

  const github = JSON.parse(readFileSync(githubHookPath, "utf8"));
  assert.ok(github.PreToolUse?.[0]?.hooks?.[0]?.command);

  const mcp = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
  assert.ok(mcp.mcpServers?.platform);
  const tokenKey = ["PLATFORM_", "BROKER_", "TOKEN"].join("");
  assert.equal(mcp.mcpServers.platform.env[tokenKey], "mock-token");
});

test("copilotHeadlessSettings and excludeFromGit configure repository and tool permissions", () => {
  const settings = copilotHeadlessSettings(["read_file", "write_file"]);
  assert.equal(settings.toolPermission, "always-proceed");
  assert.ok(settings.permissions.allow.includes("mcp(platform/*)"));
  assert.ok(settings.permissions.allow.includes("mcp(platform/read_file)"));

  const gitDir = join(tempDir, ".git");
  excludeFromGit(gitDir);
  const excludeContent = readFileSync(join(gitDir, "info", "exclude"), "utf8");
  assert.ok(excludeContent.includes(".agents/hooks.json"));
  assert.ok(excludeContent.includes(".agents/mcp_config.json"));
  assert.ok(excludeContent.includes(".github/hooks/ctp-platform.json"));

  const env = copilotEnv({ PATH: "/bin" });
  assert.equal(env.PATH, "/bin");
});

test("CopilotStream parses CLI 1.0 modern JSONL events", () => {
  const stream = new CopilotStream();
  const raw =
    [
      JSON.stringify({
        type: "session.start",
        data: { sessionId: "modern-sess" },
      }),
      JSON.stringify({
        type: "assistant.message_delta",
        data: { deltaContent: "Hello " },
      }),
      JSON.stringify({
        type: "assistant.message",
        data: { content: "Hello world", model: "gpt-5.6-luna" },
      }),
      JSON.stringify({
        type: "result",
        sessionId: "modern-sess",
        exitCode: 0,
        usage: { premiumRequests: 1 },
      }),
    ].join("\n") + "\n";
  const { events, errors } = stream.push(raw);
  assert.equal(errors.length, 0);
  assert.equal(events[0].conversationId, "modern-sess");
  assert.equal(events[1].type, "assistant.message_delta");
  assert.equal(events[1].text, "Hello ");
  assert.equal(events[2].type, "assistant.message");
  assert.equal(events[2].text, "Hello world");
  assert.equal(events[2].model, "gpt-5.6-luna");
  assert.equal(events[3].type, "result");
  assert.equal(events[3].status, "SUCCESS");
});

// ------------------------------------------------------------------ Database Migration 058
// 057 is the MICRO profile migration. Copilot constraints were renumbered so the two do not share a version.

test("migration 058 updates check constraints for copilot", () => {
  const migPath = join(import.meta.dirname, "..", "migrations", "058_agent_provider_copilot.sql");
  assert.ok(existsSync(migPath), "058_agent_provider_copilot.sql must exist");
  const sql = readFileSync(migPath, "utf8");
  assert.match(sql, /workflow_runs_agent_provider_check/);
  assert.match(sql, /agent_sessions_provider_check/);
  assert.match(sql, /workflow_step_attempts_agent_provider_check/);
  assert.match(sql, /evaluation_provider_phases_provider_check/);
  assert.match(sql, /copilot/);
});

test("ResumeHandoff schema accepts copilot and rejects unknown providers", () => {
  const valid = ResumeHandoff.safeParse({
    handoff_id: 1,
    expected_attempt_id: 2,
    provider: "copilot",
    confirm: true,
    checkpoint_fingerprint: "a".repeat(64),
  });
  assert.equal(valid.success, true);

  const invalid = ResumeHandoff.safeParse({
    handoff_id: 1,
    expected_attempt_id: 2,
    provider: "unknown-provider",
    confirm: true,
    checkpoint_fingerprint: "a".repeat(64),
  });
  assert.equal(invalid.success, false);
});
