import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import { getRun, startRun } from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { claudeExecutor, newMetrics } from "../src/agent/claude.ts";
import { resolveAgentProvider } from "../src/agent/provider.ts";
import {
  antigravityCapabilities,
  antigravityEnv,
  checkModel,
  resetCapabilitiesCache,
} from "../src/agent/antigravity/capabilities.ts";
import {
  AntigravityStream,
  classifyAntigravityError,
} from "../src/agent/antigravity/stream.ts";
import {
  antigravityHookDecision,
  writeAntigravityWorkspaceConfig,
  excludeFromGit,
} from "../src/agent/antigravity/policy.ts";
import {
  antigravityAgentTurn,
  antigravityComplete,
  buildAntigravityArgs,
} from "../src/agent/antigravity/run.ts";
import { startBroker } from "../src/agent/codex/broker.ts";
import { completeForRun } from "../src/agent/complete.ts";
import { antigravityModelFor } from "../src/agent/stepAgent.ts";
import type { PolicyContext } from "../src/agent/toolPolicy.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-agy.mjs");
const HOOK = join(import.meta.dirname, "..", "src", "agent", "antigravity", "hook.ts");
let logFile = "";
let defSeq = 0;

before(async () => {
  await migrate();
  await seedTemplates();
  chmodSync(FAKE, 0o755);
  process.env.AGY_BIN = FAKE;
  registerExecutor("agent", claudeExecutor);
  registerExecutor("coding_agent", claudeExecutor);
});

beforeEach(() => {
  logFile = join(mkdtempSync(join(tmpdir(), "fake-agy-log-")), "log.jsonl");
  process.env.FAKE_AGY_LOG = logFile;
  process.env.FAKE_AGY_MODE = "ok";
  delete process.env.AGY_MODEL;
  delete process.env.AGY_EFFORT;
  delete process.env.AGY_TIMEOUT_MS;
  delete process.env.AGY_MAX_CONCURRENT;
  resetCapabilitiesCache();
});

after(async () => {
  for (const k of [
    "AGY_BIN",
    "FAKE_AGY_LOG",
    "FAKE_AGY_MODE",
    "FAKE_AGY_TEXT",
    "FAKE_AGY_PIDFILE",
    "AGY_TIMEOUT_MS",
    "AGY_MODEL",
    "AGY_EFFORT",
    "AGY_MAX_CONCURRENT",
  ]) {
    delete process.env[k];
  }
  await pool.end();
});

const fakeLog = () =>
  existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

async function workflow(steps: unknown[]) {
  const key = `agy-wf-${++defSeq}`;
  await definitions.create({ key, spec: { name: key, steps } });
  return key;
}

const analysisPolicy: PolicyContext = {
  mode: "analysis",
  workspaces: [],
  baseBranch: "release/prod",
  protectedRoots: [],
};

const codingPolicy: PolicyContext = {
  mode: "coding",
  workspaces: [],
  baseBranch: "release/prod",
  protectedRoots: [],
};

// ------------------------------------------------------------------ Provider & Schema Migration

test("antigravity is a valid provider; omitted stays claude; invalid providers are rejected", () => {
  assert.equal(resolveAgentProvider("antigravity"), "antigravity");
  assert.equal(resolveAgentProvider(undefined), "claude");
  assert.throws(
    () => resolveAgentProvider("gemini"),
    /agent_provider must be one of claude, cursor, codex, antigravity/,
  );
});

test("migration 036 accepts antigravity on runs, sessions, attempts, and phases", async () => {
  const run = await startRun({
    definitionKey: "feature-implementation",
    title: "antigravity test",
    start: false,
    agentProvider: "antigravity",
  });
  assert.equal((await getRun(run.id)).agent_provider, "antigravity");

  // Verify DB constraint rejects unknown provider
  await assert.rejects(
    pool.query("UPDATE workflow_runs SET agent_provider = 'gemini' WHERE id = $1", [run.id]),
    /check constraint/,
  );

  const checks = await q<{ n: string }>(
    pool,
    "SELECT conname AS n FROM pg_constraint WHERE conname IN ('workflow_runs_agent_provider_check', 'agent_sessions_provider_check', 'workflow_step_attempts_agent_provider_check')",
  );
  assert.equal(checks.length, 3, "constraints updated in migration 036");
});

// ------------------------------------------------------------------ Capabilities Probing

test("antigravityCapabilities detects valid CLI, models, and auth without running paid turns", async () => {
  process.env.AGY_BIN = FAKE;
  process.env.FAKE_AGY_MODE = "ok";
  const cap = await antigravityCapabilities(true);
  assert.equal(cap.ok, true);
  assert.match(cap.version ?? "", /1\.5\.3-fake/);
  assert.ok(cap.models && cap.models.some((m) => m.slug === "gemini-3.8-flash-high"));
  assert.ok(cap.models.some((m) => m.slug === "claude-sonnet-4-6"));
  assert.equal(fakeLog().length, 0, "capability probe never invokes a model or executes a turn");
});

test("antigravityCapabilities handles missing binary, old CLI, and logged-out state", async () => {
  process.env.AGY_BIN = "/nonexistent/path/to/agy";
  const missing = await antigravityCapabilities(true);
  assert.equal(missing.ok, false);
  assert.equal(missing.kind, "missing");

  process.env.AGY_BIN = FAKE;
  process.env.FAKE_AGY_MODE = "old-cli";
  const oldCli = await antigravityCapabilities(true);
  assert.equal(oldCli.ok, false);
  assert.equal(oldCli.kind, "unsupported");
  assert.match(oldCli.error ?? "", /does not support/);

  process.env.FAKE_AGY_MODE = "logged-out";
  const loggedOut = await antigravityCapabilities(true);
  assert.equal(loggedOut.ok, false);
  assert.equal(loggedOut.kind, "auth");
  assert.match(loggedOut.error ?? "", /agy login/);
});

test("model checking validates dynamic catalog and effort levels", () => {
  const models = [
    { slug: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { slug: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash Medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", efforts: ["low", "medium", "high", "xhigh", "max"] },
  ];
  assert.equal(checkModel(models, "gemini-3.8-flash-high", "high"), null);
  assert.equal(checkModel(models, "gemini-3.8-flash-high", "invalid"), 'Antigravity does not support reasoning effort "invalid" (supported: low, medium, high, xhigh, max).');
  assert.match(checkModel(models, "gpt-4o-unknown", "") ?? "", /model "gpt-4o-unknown" is not available/i);
});

// ------------------------------------------------------------------ Stream Parsing & Classification

test("AntigravityStream handles split chunks, UTF-8 boundaries, and malformed lines", () => {
  const stream = new AntigravityStream();
  const line = Buffer.from('{"type":"message","role":"assistant","content":"Xin chào thế giới – ✓"}\n', "utf8");
  const cut = line.indexOf(Buffer.from("✓")) + 1; // within multibyte character

  const chunk1 = stream.push(Buffer.concat([Buffer.from('{"type":"init","session_id":"s-1"}\n{"type":"think'), line.subarray(0, 0)]));
  assert.equal(chunk1.events.length, 1);
  assert.equal(chunk1.events[0].type, "init");

  const chunk2 = stream.push(Buffer.concat([Buffer.from('ing","thought":"thinking..."}\n'), line.subarray(0, cut)]));
  assert.deepEqual(chunk2.events.map((e) => e.type), ["thinking"]);

  const chunk3 = stream.push(Buffer.concat([line.subarray(cut), Buffer.from('bad json line\n{"type":"tokens","input":50,"output":10,"reasoning":2,"cache_read":5}\n')]));
  assert.equal(chunk3.errors.length, 1);
  assert.equal(chunk3.events.length, 2);
  assert.equal(chunk3.events[0].type, "message");
  assert.equal(chunk3.events[0].text, "Xin chào thế giới – ✓");
  assert.equal(chunk3.events[1].type, "tokens");
  assert.equal(chunk3.events[1].tokens?.reasoning, 2);
});

test("AntigravityStream parses split documented stream-json events and cumulative result usage", () => {
  const stream = new AntigravityStream();
  const wire = [
    JSON.stringify({ event: "init", conversation_id: "conv-stream" }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "agent_message", text_delta: "hello " } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "agent_message", text_delta: "world" } }),
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "hello world", num_turns: 1, usage: { input_tokens: 11, output_tokens: 7, cache_read_tokens: 3 } } }),
  ].join("\n") + "\n";
  const bytes = Buffer.from(wire);
  const a = stream.push(bytes.subarray(0, 29));
  const b = stream.push(bytes.subarray(29));
  const events = [...a.events, ...b.events];
  assert.equal(events[0].conversationId, "conv-stream");
  assert.deepEqual(events.slice(1, 3).map((e) => e.text), ["hello ", "world"]);
  assert.equal(events[3].type, "result");
  assert.equal(events[3].cumulativeUsage, true);
  assert.deepEqual(events[3].tokens, { input: 11, output: 7, reasoning: null, cache_read: 3, cache_creation: null });
});

test("classifyAntigravityError accurately identifies error classes", () => {
  assert.equal(classifyAntigravityError("Resource has been exhausted (quota limit reached)"), "QUOTA_EXHAUSTED");
  assert.equal(classifyAntigravityError("Google login required or expired credentials"), "AUTHENTICATION");
  assert.equal(classifyAntigravityError("Operation timed out after 30000ms"), "EXECUTION_TIMEOUT");
  assert.equal(classifyAntigravityError("Process aborted by user signal"), "CANCELED");
  assert.equal(classifyAntigravityError("agent_error: unexpected failure"), "AGENT_ERROR");
});

// ------------------------------------------------------------------ Security Policy & PreToolUse Hook

function runHook(payload: unknown, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", HOOK], {
      env: { PATH: process.env.PATH, ...env },
    });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (b) => (stdout += b));
    c.stderr.on("data", (b) => (stderr += b));
    c.on("close", (code) => resolve({ code, stdout, stderr }));
    c.stdin.end(JSON.stringify(payload));
  });
}

test("antigravityHookDecision enforces read-only mode and denies mutations", () => {
  const allowRead = antigravityHookDecision(
    {
      hook_event_name: "PreToolUse",
      tool_name: "read_file",
      tool_input: { path: "src/index.ts" },
    },
    analysisPolicy,
    "/repo",
  );
  assert.equal(allowRead.allow, true);

  const denyWrite = antigravityHookDecision(
    {
      hook_event_name: "PreToolUse",
      tool_name: "write_file",
      tool_input: { path: "src/index.ts", content: "x" },
    },
    analysisPolicy,
    "/repo",
  );
  assert.equal(denyWrite.allow, false);
  assert.match(denyWrite.reason ?? "", /read-only/i);

  const denyPush = antigravityHookDecision(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push origin feature" },
    },
    codingPolicy,
    "/repo",
  );
  assert.equal(denyPush.allow, false);
  assert.match(denyPush.reason ?? "", /pushing/i);

  const denyEnv = antigravityHookDecision(
    {
      hook_event_name: "PreToolUse",
      tool_name: "read_file",
      tool_input: { path: ".env" },
    },
    codingPolicy,
    "/repo",
  );
  assert.equal(denyEnv.allow, false);
  assert.match(denyEnv.reason ?? "", /credentials/i);
});

test("PreToolUse hook fails closed without valid broker token", async () => {
  const broker = await startBroker({
    policy: analysisPolicy,
    cwd: "/tmp",
    decideHook: antigravityHookDecision,
    dispatch: async () => "ok",
  });
  try {
    const forged = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } },
      { PLATFORM_BROKER_SOCKET: broker.socketPath, PLATFORM_BROKER_TOKEN: "wrong-token" },
    );
    assert.equal(forged.code, 2, "hook exits 2 (denied) when token is invalid");

    const valid = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "read_file", tool_input: { path: "readme.md" } },
      { PLATFORM_BROKER_SOCKET: broker.socketPath, PLATFORM_BROKER_TOKEN: broker.token },
    );
    assert.equal(valid.code, 0, "hook exits 0 (allowed) with valid token");
  } finally {
    await broker.close();
  }

  const none = await runHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, {});
  assert.equal(none.code, 2, "hook exits 2 when broker is completely unavailable");
});

test("workspace config writes .agents/hooks.json and .agents/mcp_config.json, and excludes from git", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-ws-cfg-"));
  writeAntigravityWorkspaceConfig(dir, {
    brokerSocket: "/tmp/fake.sock",
    brokerToken: "secret-token",
    mode: "coding",
  });
  assert.ok(existsSync(join(dir, ".agents", "hooks.json")));
  assert.ok(existsSync(join(dir, ".agents", "mcp_config.json")));

  const hooks = JSON.parse(readFileSync(join(dir, ".agents", "hooks.json"), "utf8"));
  const hookCmd =
    hooks.PreToolUse?.[0]?.hooks?.[0]?.command ??
    hooks.PreToolUse?.command ??
    hooks["platform-security"]?.PreToolUse?.[0]?.hooks?.[0]?.command;
  assert.ok(hookCmd && hookCmd.includes("hook.ts"));

  const mcp = JSON.parse(readFileSync(join(dir, ".agents", "mcp_config.json"), "utf8"));
  assert.ok(mcp.mcpServers.platform.command);

  excludeFromGit(join(dir, ".git"));
  const gitExclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
  assert.ok(gitExclude.includes(".agents/"));
});

// ------------------------------------------------------------------ CLI Invocation & Args

test("buildAntigravityArgs builds correct noninteractive arguments without credentials", () => {
  const args = buildAntigravityArgs({
    model: "gemini-3.8-flash-high",
    effort: "high",
    conversationId: "conv-123",
    sandbox: true,
  });
  assert.ok(args.includes("--output-format"));
  assert.deepEqual(args.slice(0, 4), ["--output-format", "stream-json", "--input-format", "stream-json"]);
  assert.ok(args.every((a) => !a.includes("inspect database")));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("gemini-3.8-flash-high"));
  assert.ok(args.includes("--effort"));
  assert.ok(args.includes("high"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(!args.includes("--dangerously-skip-permissions"), "unrestricted permission mode is never enabled by default");
  assert.ok(args.includes("--conversation"));
  assert.ok(args.includes("conv-123"));

  // Check env scrubbing
  const env = antigravityEnv({
    PATH: "/bin",
    DATABASE_URL: "postgres://secret",
    AUTH_SECRET: "jwt-secret",
    OPENAI_API_KEY: "sk-secret",
    HOME: "/home/user",
  });
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.AUTH_SECRET, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.HOME, "/home/user");
  assert.equal(env.PATH, "/bin");
});

test("model resolution for Antigravity step uses antigravityModelFor", () => {
  process.env.AGY_MODEL = "gemini-3.8-flash-high";
  process.env.AGY_EFFORT = "medium";

  const resolved = antigravityModelFor({
    type: "agent",
    config: { agent: { model: "claude-sonnet-4-6", reasoning_effort: "high" } },
  });
  assert.equal(resolved.model, "claude-sonnet-4-6");
  assert.equal(resolved.effort, "high");

  const fallback = antigravityModelFor({ type: "agent", config: {} });
  assert.equal(fallback.model, "gemini-3.8-flash-high");
  assert.equal(fallback.effort, "medium");
});

// ------------------------------------------------------------------ Execution & Turn Lifecycle

function fakeCtx(signal: AbortSignal) {
  const logs: Array<{ kind: string; content: string }> = [];
  return {
    logs,
    ctx: {
      run: {
        id: 0,
        branch: "t",
        allowed_repositories: [],
        selected_repositories: [],
        output_locale: "en",
        agent_provider: "antigravity",
      },
      step: { id: 0, type: "agent", config: {}, key: "analyze" },
      attempt: { id: 0, fencing_token: null },
      input: { upstream: {} },
      context: { knowledge: [], disclosure: [] },
      signal,
      log: async (kind: string, content: string) => void logs.push({ kind, content }),
      ask: async () => 0,
      recordSession: async () => {},
      recordMetrics: async () => {},
    } as any,
  };
}

const turn = (mode: "analysis" | "coding", signal = new AbortController().signal, prompt = "Analyze requirements and produce contract", resumeId?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "agy-turn-"));
  const f = fakeCtx(signal);
  const metrics = newMetrics("gemini-3.8-flash-high");
  return {
    f,
    metrics,
    dir,
    run: () =>
      antigravityAgentTurn({
        ctx: f.ctx,
        mode,
        policy: mode === "analysis" ? analysisPolicy : codingPolicy,
        cwd: dir,
        prompt,
        metrics,
        resumeId,
      }),
  };
};

test("Antigravity sends small and Unicode prompts through stdin only", async () => {
  process.env.FAKE_AGY_MODE = "ok";
  const prompt = "Tạo PR\n" + JSON.stringify({ escaped: "\"\\", emoji: "🧪" });
  const t = turn("analysis", new AbortController().signal, prompt);
  const result = await t.run();
  assert.equal(result.isError, false);
  const invocation = fakeLog().find((e) => Array.isArray(e.argv));
  assert.equal(invocation.prompt, prompt);
  assert.ok(!invocation.argv.some((arg: string) => arg.includes(prompt)));
  assert.equal(invocation.env.containsPrompt, false);
});

test("Antigravity streams prompts larger than 128 KiB without argv growth", async () => {
  process.env.FAKE_AGY_MODE = "ok";
  const prompt = "large-🧪-prompt\n".repeat(12_000);
  const t = turn("analysis", new AbortController().signal, prompt);
  const result = await t.run();
  assert.equal(result.isError, false);
  const invocation = fakeLog().find((e) => Array.isArray(e.argv));
  assert.equal(invocation.prompt, prompt);
  assert.ok(invocation.argv.every((arg: string) => Buffer.byteLength(arg) < 4096));
  assert.equal(invocation.env.containsPrompt, false);
});

test("Antigravity resume keeps the conversation ID while sending the continuation on stdin", async () => {
  const t = turn("analysis", new AbortController().signal, "continue from checkpoint", "conv-existing");
  const result = await t.run();
  assert.equal(result.isError, false);
  const invocation = fakeLog().find((e) => Array.isArray(e.argv));
  assert.equal(invocation.resumeId, "conv-existing");
  assert.ok(!invocation.argv.some((arg: string) => arg.includes("continue from checkpoint")));
});

test("antigravityAgentTurn successfully completes turn, collects tokens and does not invent cost", async () => {
  process.env.FAKE_AGY_MODE = "ok";
  const t = turn("analysis");
  const r = await t.run();

  assert.equal(r.isError, false);
  assert.equal(r.failure, undefined);
  assert.ok(r.text.includes("Antigravity task completed successfully"));
  assert.equal(t.metrics.cost_usd, null, "cost_usd must remain null when provider does not report cost");
  assert.equal(t.metrics.tokens?.input, 180);
  assert.equal(t.metrics.tokens?.output, 35);
  assert.equal(t.metrics.tokens?.reasoning_output, 12);
  assert.equal(t.metrics.tokens?.cache_read, 60);

  // Check logs from execution
  const agentLogs = t.f.logs.filter((l) => l.kind === "agent");
  assert.ok(agentLogs.length > 0);
  assert.ok(agentLogs.some((l) => l.content.includes("Antigravity task completed")));
});

test("antigravityAgentTurn handles quota exhaustion with clear message", async () => {
  process.env.FAKE_AGY_MODE = "quota";
  const t = turn("analysis");
  const r = await t.run();

  assert.equal(r.isError, true);
  assert.equal(r.failure, "QUOTA_EXHAUSTED");
  assert.match(r.text, /Google Gemini quota exhausted/);
});

test("Antigravity handles premature stdin close without duplicate invocation", async () => {
  process.env.FAKE_AGY_MODE = "epipe";
  const t = turn("analysis", new AbortController().signal, "x".repeat(300_000));
  const r = await t.run();
  assert.equal(r.isError, true);
  assert.match(r.text, /prompt|stdin|exited/i);
  assert.equal(fakeLog().filter((e) => Array.isArray(e.argv)).length, 0, "no second invocation is scheduled");
});

test("Antigravity aborts and times out a running CLI, and reports a missing CLI", async () => {
  process.env.FAKE_AGY_MODE = "hang";
  const aborter = new AbortController();
  const aborted = turn("analysis", aborter.signal);
  const abortRun = aborted.run();
  setTimeout(() => aborter.abort(), 100);
  const cancel = await abortRun;
  assert.equal(cancel.failure, "CANCELED");

  process.env.AGY_TIMEOUT_MS = "100";
  const timed = await turn("analysis").run();
  assert.equal(timed.failure, "EXECUTION_TIMEOUT");

  process.env.AGY_BIN = "/definitely/missing/agy";
  resetCapabilitiesCache();
  const missing = await turn("analysis").run();
  assert.equal(missing.isError, true);
  assert.match(missing.text, /not found/i);
  process.env.AGY_BIN = FAKE;
  resetCapabilitiesCache();
});

test("antigravityAgentTurn handles user clarification (ask_user) through MCP bridge", async () => {
  process.env.FAKE_AGY_MODE = "ask";
  const t = turn("analysis");
  const r = await t.run();

  assert.equal(r.isError, false);
  assert.ok(r.text.includes("Waiting for user input"));
  assert.equal(t.metrics.tokens?.input, 120);
});

test("antigravityComplete produces auxiliary completions and integrates with completeForRun", async () => {
  process.env.FAKE_AGY_MODE = "aux_complete";
  process.env.FAKE_AGY_TEXT = '{"summary": "quick evaluation result"}';

  const res = await antigravityComplete("Summarize this context");
  assert.equal(res.text, '{"summary": "quick evaluation result"}');
  assert.equal(res.tokens?.input, 25);
  const auxInvocation = fakeLog().find((e) => Array.isArray(e.argv));
  assert.equal(auxInvocation.prompt, "Summarize this context");
  assert.ok(!auxInvocation.argv.some((arg: string) => arg.includes("Summarize this context")));
  assert.equal(auxInvocation.env.containsPrompt, false);

  const runRes = await completeForRun(
    { agent_provider: "antigravity" } as any,
    "Summarize again",
  );
  assert.equal(runRes.text, '{"summary": "quick evaluation result"}');
  assert.equal(runRes.provider, "antigravity");
  assert.equal(runRes.metrics.tokens?.input, 25);
});

// ------------------------------------------------------------------ End-to-End Workflow Execution

test("end-to-end: workflow with antigravity agent completes and persists attempt with correct metrics", async () => {
  process.env.FAKE_AGY_MODE = "ok";
  const wfKey = await workflow([
    {
      key: "task",
      type: "agent",
      config: {
        agent: {
          provider: "antigravity",
          model: "gemini-3.8-flash-high",
          reasoning_effort: "high",
        },
      },
      contract: {
        output: {
          type: "object",
          required: ["goal"],
          properties: {
            goal: { type: "string" },
            requirements: { type: "array" },
          },
        },
      },
    },
  ]);

  const run = await startRun({
    definitionKey: wfKey,
    title: "antigravity workflow run",
    start: true,
    agentProvider: "antigravity",
  });

  await drain();

  const finishedRun = await getRun(run.id);
  assert.equal(finishedRun.status, "COMPLETED");

  const attempts = await q<any>(
    pool,
    "SELECT a.* FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE a.run_id = $1 AND s.key = 'task'",
    [run.id],
  );
  assert.equal(attempts.length, 1);
  const attempt = attempts[0];
  assert.equal(attempt.agent_provider, "antigravity");
  assert.equal(attempt.status, "COMPLETED");

  const metrics = attempt.metrics;
  assert.ok(metrics);
  assert.equal(metrics.provider, "antigravity");
  assert.equal(metrics.cost_usd, null);
  assert.ok(metrics.tokens.input > 0);
  assert.ok(metrics.tokens.reasoning_output > 0);
});
