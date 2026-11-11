#!/usr/bin/env node
// Fake `agy` CLI for deterministic unit and integration tests.
// Behaves like Google Antigravity CLI for capabilities discovery (--version, --help, models)
// and headless execution through the documented stream-json stdin protocol.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_AGY_MODE || "ok";
const log = (o) =>
  process.env.FAKE_AGY_LOG && appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(o) + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (argv.includes("--version")) {
  console.log("Google Antigravity CLI 1.5.3-fake");
  process.exit(0);
}

if (argv.includes("--help") && !argv.includes("-p") && !argv.includes("--print")) {
  if (mode === "old-cli") {
    console.log("Usage: agy [options]\nOptions:\n  --version\n  --help");
  } else {
    console.log(`Google Antigravity CLI 1.5.3-fake
Options:
  -p, --print                    Run in non-interactive print mode
  --output-format <format>       Output format: text, json, stream-json
  --input-format <format>        Input format: text, stream-json
  --model <model>                Model identifier to use
  --effort <effort>              Reasoning effort: low, medium, high, xhigh, max
  --sandbox                      Run inside sandbox isolation
  --conversation <id>            Resume existing conversation session
  --print-timeout <ms>           Maximum print execution timeout in milliseconds
  --add-dir <path>               Add workspace directory
`);
  }
  process.exit(0);
}

if (argv[0] === "models") {
  if (mode === "logged-out") {
    console.error("Please run agy login to authenticate with your Google account.");
    process.exit(1);
  }
  console.log(`gemini-3.8-flash-high
gemini-3.8-flash-medium
gemini-3.8-flash-low
claude-sonnet-4-6
claude-opus-4-6-thinking
gpt-oss-120b-medium`);
  process.exit(0);
}

if (
  !argv.includes("--input-format") ||
  argv[argv.indexOf("--input-format") + 1] !== "stream-json" ||
  !argv.includes("--output-format") ||
  argv[argv.indexOf("--output-format") + 1] !== "stream-json"
) {
  console.error("Expected --input-format stream-json and --output-format stream-json");
  process.exit(2);
}
if (mode === "epipe") process.exit(0);
let stdinText = "";
for await (const chunk of process.stdin) stdinText += chunk.toString("utf8");
let prompt = "";
try {
  const rows = stdinText.trimEnd().split("\n");
  if (rows.length !== 1) throw new Error("expected exactly one NDJSON input event");
  const input = JSON.parse(rows[0]);
  if (input.event !== "user" || typeof input.message?.content !== "string")
    throw new Error("invalid user event");
  prompt = input.message.content;
} catch (e) {
  console.error(`invalid stream-json stdin: ${e.message}`);
  process.exit(2);
}

let resumeId = null;
const convIdx = argv.indexOf("--conversation");
if (convIdx >= 0 && convIdx + 1 < argv.length) {
  resumeId = argv[convIdx + 1];
}

const sessionId = resumeId || process.env.FAKE_AGY_SESSION || "agy-sess-1";

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
  if (process.env.FAKE_AGY_PIDFILE) {
    writeFileSync(process.env.FAKE_AGY_PIDFILE, String(g.pid));
  }
  setInterval(() => {}, 1000);
  await sleep(600_000);
  process.exit(0);
}

if (mode === "quota") {
  out({ type: "init", session_id: sessionId, model: "gemini-3.8-flash-high" });
  out({ type: "error", error: "Google Gemini quota exhausted: quota limit reached" });
  process.exit(1);
}

if (mode === "aux_complete") {
  out({ type: "init", session_id: sessionId, model: "gemini-3.8-flash-high" });
  out({
    type: "message",
    role: "assistant",
    content: process.env.FAKE_AGY_TEXT || "Auxiliary response",
  });
  out({ type: "tokens", input: 25, output: 10, reasoning: 0, cache_read: 0 });
  process.exit(0);
}

// Read workspace .agents/hooks.json and .agents/mcp_config.json if present
const hooksFile = join(process.cwd(), ".agents", "hooks.json");
const mcpFile = join(process.cwd(), ".agents", "mcp_config.json");

let hookCommand = null;
if (existsSync(hooksFile)) {
  try {
    const hooksCfg = JSON.parse(readFileSync(hooksFile, "utf8"));
    hookCommand =
      hooksCfg.PreToolUse?.[0]?.hooks?.[0]?.command ||
      hooksCfg["platform-security"]?.PreToolUse?.[0]?.hooks?.[0]?.command ||
      hooksCfg.PreToolUse?.command ||
      null;
  } catch {}
}

const callHook = (payload) => {
  if (!hookCommand) return { status: 0, stdout: "" };
  const r = spawnSync("sh", ["-c", hookCommand], {
    input: JSON.stringify({
      session_id: sessionId,
      cwd: process.cwd(),
      model: "gemini-3.8-flash-high",
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
          } catch {}
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
    tool_name: `mcp__platform__${name}`,
    tool_input: args,
  });
  if (pre.status === 2) {
    out({ type: "tool_denied", name, reason: pre.stdout || "policy denial" });
    return { denied: true };
  }
  out({ type: "tool_call", name, arguments: args });
  const r = mcp ? await mcp.rpc("tools/call", { name, arguments: args }) : { result: {} };
  out({ type: "tool_result", name, result: r.result });
  return r.result;
}

out({ type: "init", session_id: sessionId, model: "gemini-3.8-flash-high" });
out({ type: "thinking", thought: "Initializing Antigravity session..." });

if (mode === "push") {
  const r = callHook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git push origin HEAD" },
  });
  log({ push: r.status, stdout: r.stdout });
}

if (mode === "denied_tool") {
  const r = callHook({
    hook_event_name: "PreToolUse",
    tool_name: "write_file",
    tool_input: { path: "hello.txt", content: "foo" },
  });
  log({ write: r.status, stdout: r.stdout });
}

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
    type: "message",
    role: "assistant",
    content: "Waiting for user input before proceeding.",
  });
  out({
    type: "tokens",
    input: 120,
    output: 15,
    reasoning: 5,
    cache_read: 40,
  });
  if (mcp) mcp.close();
  process.exit(0);
}

if (mode === "commit") {
  writeFileSync(process.env.FAKE_AGY_WS + "/feature.txt", "antigravity code\n");
  const outside = await tool(mcp, "commit_changes", {
    repo: "oms-api",
    message: "escape attempt",
    paths: ["../../etc"],
  });
  const done = await tool(mcp, "commit_changes", {
    repo: "oms-api",
    message: "feat: add feature via antigravity",
  });
  log({ outside: outside?.content?.[0]?.text, commit: done?.content?.[0]?.text });
}

if (mode === "no-submit") {
  out({ type: "message", role: "assistant", content: "Done without submitting result." });
  out({ type: "tokens", input: 80, output: 10, reasoning: 0, cache_read: 0 });
  if (mcp) mcp.close();
  process.exit(0);
}

const output =
  mode === "bad-contract"
    ? { summary: "missing required keys" }
    : resumeId
      ? {
          goal: "resumed from antigravity",
          requirements: [],
          answer_seen: prompt.includes("Yes") || prompt.includes("Có"),
        }
      : { goal: "from antigravity", requirements: ["r1", "r2"] };

await tool(mcp, "submit_result", { output });

// Emit final message and tokens
out({
  type: "message",
  role: "assistant",
  content: "Antigravity task completed successfully ✓",
});
out({
  type: "tokens",
  input: 180,
  output: 35,
  reasoning: 12,
  cache_read: 60,
});

if (mcp) mcp.close();
process.exit(mode === "fail-after-submit" ? 1 : 0);
