#!/usr/bin/env node
// Fake GitHub Copilot CLI ≥ 1.0 for deterministic unit and integration tests.
// Mirrors headless `-p` / stdin + `--output-format json` (JSONL) used by the platform adapter.
import { implementTransportFixture } from "./transport-implementation.mjs";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_COPILOT_MODE || "ok";
const log = (o) =>
  process.env.FAKE_COPILOT_LOG && appendFileSync(process.env.FAKE_COPILOT_LOG, JSON.stringify(o) + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

if (argv.includes("--version") || argv[0] === "version") {
  console.log("GitHub Copilot CLI 1.0.0-fake");
  process.exit(0);
}

if (argv.includes("--help") && !argv.includes("-p") && !argv.includes("--prompt")) {
  if (mode === "old-cli") {
    console.log("Usage: copilot [options]\nOptions:\n  --version\n  --help");
  } else {
    console.log(`GitHub Copilot CLI 1.0.0-fake
Options:
  -p, --prompt <text>            Execute a prompt in non-interactive mode
  --output-format <format>       Output format: text, json
  --model <model>                Model identifier to use
  --silent, -s                   Output only the agent response
  --reasoning-effort <level>     Reasoning effort: none, minimal, low, medium, high, xhigh, max
  --resume <id>                  Resume existing session
  --additional-mcp-config <json> Extra MCP servers (@path or JSON)
  --allow-all-tools              Allow tools without confirmation
  --add-dir <path>               Add workspace directory
`);
  }
  process.exit(0);
}

if (argv[0] === "models") {
  if (mode === "logged-out") {
    console.error("Please run copilot login to authenticate with your GitHub account.");
    process.exit(1);
  }
  console.log(`gpt-4o
o1-preview
o1-mini
claude-3.5-sonnet
claude-3.5-haiku
gpt-4o-mini`);
  process.exit(0);
}

if (mode === "epipe") process.exit(0);

const outFmt = flagValue("--output-format");
if (outFmt !== "json") {
  console.error("Expected --output-format json");
  process.exit(2);
}

const promptIdx = argv.includes("-p") ? argv.indexOf("-p") : argv.indexOf("--prompt");
let prompt = "";
if (promptIdx >= 0) {
  prompt = argv[promptIdx + 1] ?? "";
} else {
  for await (const chunk of process.stdin) prompt += chunk.toString("utf8");
}
if (!prompt.trim()) {
  console.error("Expected -p/--prompt or a prompt on stdin");
  process.exit(2);
}

const resumeId = flagValue("--resume");
const sessionId = resumeId || process.env.FAKE_COPILOT_SESSION || "copilot-sess-1";

function mcpConfigPathFromArgv() {
  const raw = flagValue("--additional-mcp-config");
  if (raw?.startsWith("@")) return raw.slice(1);
  return join(process.cwd(), ".agents", "mcp_config.json");
}

log({
  argv,
  prompt,
  resumeId,
  cwd: process.cwd(),
  env: {
    DATABASE_URL: !!process.env.DATABASE_URL,
    AUTH_SECRET: !!process.env.AUTH_SECRET,
    BROKER: !!process.env.PLATFORM_BROKER_TOKEN,
    containsPrompt: Object.values(process.env).some(
      (v) => v === prompt || (prompt.length > 1000 && v?.includes(prompt.slice(0, 1000))),
    ),
  },
});

if (mode === "hang") {
  const g = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  if (process.env.FAKE_COPILOT_PIDFILE) {
    writeFileSync(process.env.FAKE_COPILOT_PIDFILE, String(g.pid));
  }
  setInterval(() => {}, 1000);
  await sleep(600_000);
  process.exit(0);
}

if (mode === "quota") {
  out({
    type: "session.start",
    data: { sessionId },
  });
  out({
    type: "session.error",
    data: { message: "Google Gemini quota exhausted: quota limit reached" },
  });
  out({ type: "result", sessionId, exitCode: 1, usage: {} });
  process.exit(1);
}

if (mode === "aux_real" || mode === "aux_real_tools") {
  // The event sequence Copilot CLI 1.0.113 prints for a one-shot prompt (trimmed): the result event carries no tokens.
  out({ type: "session.start", data: { sessionId } });
  out({ type: "session.model_change", data: { source: "startup", newModel: "auto" } });
  out({ type: "session.auto_mode_resolved", data: { chosenModel: "gpt-fake-1" } });
  out({ type: "assistant.turn_start", data: { turnId: "0" } });
  out({ type: "model.call_start", data: { model: "gpt-fake-1" } });
  if (mode === "aux_real_tools") {
    for (const id of ["t1", "t2"]) {
      out({ type: "tool.execution_start", data: { toolCallId: id, toolName: "bash", arguments: { command: "ls" } } });
      out({ type: "tool.execution_complete", data: { toolCallId: id, success: true } });
    }
  }
  out({ type: "assistant.message", data: { content: "ok", model: "gpt-fake-1", toolRequests: [] } });
  out({
    type: "session.usage_checkpoint",
    data: {
      totalPremiumRequests: 1,
      accountingSnapshot: {
        tokenDetails: {
          input: { tokenCount: 3 },
          cache_read: { tokenCount: 10175 },
          cache_write: { tokenCount: 7099 },
          output: { tokenCount: 5 },
        },
        currentModel: "gpt-fake-1",
        modelMetrics: {
          "gpt-fake-1": {
            requests: { count: 1, cost: 1 },
            usage: { inputTokens: 17277, outputTokens: 5, cacheReadTokens: 10175, cacheWriteTokens: 7099, reasoningTokens: 0 },
          },
        },
      },
    },
  });
  out({ type: "assistant.idle", data: {} });
  out({ type: "result", sessionId, exitCode: 0, usage: { premiumRequests: 1, totalApiDurationMs: 2451, sessionDurationMs: 8602 } });
  process.exit(0);
}

if (mode === "aux_complete") {
  out({ type: "session.start", data: { sessionId } });
  out({
    type: "assistant.message",
    data: {
      content: process.env.FAKE_COPILOT_TEXT || "Auxiliary response",
      model: "gpt-4o",
    },
  });
  out({
    type: "result",
    sessionId,
    exitCode: 0,
    usage: { premiumRequests: 1 },
  });
  process.exit(0);
}

const hooksGithub = join(process.cwd(), ".github", "hooks", "ctp-platform.json");
const mcpFile = mcpConfigPathFromArgv();

// Like the real CLI (1.0.113): prompt mode loads .github/hooks only for a trusted folder, in the native schema.
let hookCommand = null;
let telemetryCommand = null;
if (process.argv.includes("--trust-folder") && existsSync(hooksGithub)) {
  try {
    const hooksCfg = JSON.parse(readFileSync(hooksGithub, "utf8"));
    telemetryCommand = hooksCfg.hooks?.sessionStart?.[0]?.bash ?? null;
    hookCommand = hooksCfg.hooks?.preToolUse?.[0]?.bash ?? null;
  } catch {
    /* ignore */
  }
}

const callHook = (payload) => {
  if (!hookCommand) return { status: 0, stdout: "" };
  const r = spawnSync("sh", ["-c", hookCommand], {
    input: JSON.stringify({
      session_id: sessionId,
      cwd: process.cwd(),
      modelName: "gpt-4o",
      ...payload,
    }),
    env: process.env,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

function startMcp() {
  if (!existsSync(mcpFile)) return null;
  try {
    const mcpCfg = JSON.parse(readFileSync(mcpFile, "utf8"));
    const server = mcpCfg.mcpServers?.platform;
    if (!server) return null;
    const env = { ...process.env, ...(server.env || {}) };
    const child = spawn(server.command, server.args || [], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    const waiting = new Map();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            const msg = JSON.parse(line);
            waiting.get(msg.id)?.(msg);
          } catch {
            /* ignore */
          }
        }
      }
    });
    let id = 0;
    const rpc = (method, params) =>
      new Promise((resolve) => {
        const n = ++id;
        waiting.set(n, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
      });
    return { rpc, close: () => child.kill() };
  } catch {
    return null;
  }
}

async function tool(mcp, name, args) {
  const pre = callHook({
    hook_event_name: "PreToolUse",
    toolName: `mcp__platform__${name}`,
    toolArgs: args,
  });
  if (pre.status === 2) {
    out({
      type: "tool.execution_start",
      data: { toolName: `mcp__platform__${name}`, arguments: args },
    });
    out({
      type: "session.error",
      data: { message: pre.stdout || "policy denial" },
    });
    return { denied: true };
  }
  out({
    type: "tool.execution_start",
    data: { toolName: `mcp__platform__${name}`, arguments: args },
  });
  const r = mcp ? await mcp.rpc("tools/call", { name, arguments: args }) : { result: {} };
  out({
    type: "tool.execution_end",
    data: { toolName: `mcp__platform__${name}`, result: r.result },
  });
  return r.result;
}

if (mode === "truncated") {
  // A stream cut off mid-reply: text, but neither a result nor the idle marker.
  out({ type: "session.start", data: { sessionId } });
  out({ type: "assistant.message_delta", data: { deltaContent: "half an ans" } });
  process.exit(0);
}

if (mode === "idle-only") {
  // What the real CLI sends: a final message and assistant.idle, no result event.
  out({ type: "session.start", data: { sessionId } });
  out({ type: "assistant.message", data: { content: "all done", model: "gpt-4o" } });
  out({ type: "assistant.idle", data: {} });
  process.exit(0);
}

if (mode === "native-model") {
  out({ type: "session.start", data: { sessionId } });
  if (telemetryCommand) {
    const r = spawnSync("sh", ["-c", telemetryCommand], {
      input: JSON.stringify({
        conversationId: sessionId,
        modelName: "copilot-native-reported",
        invocationNum: 0,
      }),
      env: process.env,
      encoding: "utf8",
    });
    log({ modelHook: r.status, response: r.stdout });
  }
  out({
    type: "assistant.message",
    data: { content: "no tools needed", model: "copilot-native-reported" },
  });
  out({ type: "result", sessionId, exitCode: 0, usage: {} });
  process.exit(0);
}

out({ type: "session.start", data: { sessionId } });
out({ type: "session.model_change", data: { newModel: "gpt-4o" } });
out({
  type: "assistant.reasoning_delta",
  data: { deltaContent: "Initializing Copilot session..." },
});

if (mode === "nohook") {
  // Platform MCP tool without PreToolUse — adapter must stop the turn.
  if (telemetryCommand)
    spawnSync("sh", ["-c", telemetryCommand], {
      input: JSON.stringify({ conversationId: sessionId, modelName: "gpt-4o", invocationNum: 0 }),
      env: process.env,
      encoding: "utf8",
    });
  out({
    type: "tool.execution_start",
    data: { toolName: "mcp__platform__ask_user", arguments: { questions: [] } },
  });
  await new Promise((r) => setTimeout(r, 30_000));
  process.exit(0);
}

if (mode === "nohook-native") {
  // A native tool that starts although the platform hook never ran.
  out({ type: "tool.execution_start", data: { toolName: "bash", arguments: { command: "ls ." } } });
  await new Promise((r) => setTimeout(r, 30_000));
  process.exit(0);
}

if (mode === "hooked-native") {
  // The tool event is emitted as the hook starts, like the real CLI.
  out({ type: "tool.execution_start", data: { toolName: "bash", arguments: { command: "ls ." } } });
  const r = callHook({ hook_event_name: "PreToolUse", toolName: "bash", toolArgs: { command: "ls ." } });
  log({ hooked: r.status });
}

if (mode === "push") {
  const r = callHook({
    hook_event_name: "PreToolUse",
    toolName: "bash",
    toolArgs: { command: "git push origin HEAD" },
  });
  log({ push: r.status, stdout: r.stdout });
}

if (mode === "denied_tool") {
  const r = callHook({
    hook_event_name: "PreToolUse",
    toolName: "create",
    toolArgs: { path: "hello.txt", file_text: "foo" },
  });
  log({ write: r.status, stdout: r.stdout });
}

implementTransportFixture();
const mcp = startMcp();
if (mcp) {
  await mcp.rpc("initialize", { protocolVersion: "2024-11-05" });
  const list = await mcp.rpc("tools/list", {});
  log({ tools: list?.result?.tools?.map((t) => t.name) ?? [] });
}

if (mode === "ask") {
  await tool(mcp, "ask_user", {
    questions: [{ question: "Deploy to production?", options: ["No", "Yes"] }],
  });
  out({
    type: "assistant.message",
    data: { content: "Waiting for user input before proceeding.", model: "gpt-4o" },
  });
  out({ type: "result", sessionId, exitCode: 0, usage: {} });
  if (mcp) mcp.close();
  process.exit(0);
}

if (mode === "commit") {
  writeFileSync(process.env.FAKE_COPILOT_WS + "/feature.txt", "copilot code\n");
  const outside = await tool(mcp, "commit_changes", {
    repo: "oms-api",
    message: "escape attempt",
    paths: ["../../etc"],
  });
  const done = await tool(mcp, "commit_changes", {
    repo: "oms-api",
    message: "feat: add feature via copilot",
  });
  log({ outside: outside?.content?.[0]?.text, commit: done?.content?.[0]?.text });
}

if (mode === "no-submit") {
  out({
    type: "assistant.message",
    data: { content: "Done without submitting result.", model: "gpt-4o" },
  });
  out({ type: "result", sessionId, exitCode: 0, usage: {} });
  if (mcp) mcp.close();
  process.exit(0);
}

const output =
  mode === "bad-contract"
    ? { summary: "missing required keys" }
    : resumeId
      ? {
          goal: "resumed from copilot",
          requirements: [],
          answer_seen: prompt.includes("Yes") || prompt.includes("Có"),
        }
      : { goal: "from copilot", requirements: ["r1", "r2"] };

await tool(mcp, "submit_result", { output });

out({
  type: "assistant.message",
  data: { content: "Copilot task completed successfully ✓", model: "gpt-4o" },
});
out({ type: "result", sessionId, exitCode: mode === "fail-after-submit" ? 1 : 0, usage: {} });

if (mcp) mcp.close();
process.exit(mode === "fail-after-submit" ? 1 : 0);
