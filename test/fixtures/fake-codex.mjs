#!/usr/bin/env node
// Fake `codex` CLI for tests. It behaves like codex-cli for the parts the platform relies on: --version, exec/resume
// help, login status, debug models, and `exec --json` turns. During a turn it runs the platform hook command found in
// `-c hooks.PreToolUse=...` and spawns the MCP server from `-c mcp_servers.platform.*` (forwarding env_vars), then
// speaks newline-delimited JSON-RPC to it — the same path the real CLI takes. No model is called.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || "ok";
const log = (o) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(o) + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXEC_FLAGS = "--json --strict-config --ignore-user-config --ignore-rules --dangerously-bypass-hook-trust --skip-git-repo-check --config --sandbox";
if (argv[0] === "--version") {
  console.log("codex-cli 0.164.0-fake");
  process.exit(0);
}
if (argv[0] === "exec" && argv.includes("--help")) {
  console.log(mode === "old-cli" ? "--json --config" : EXEC_FLAGS);
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  if (mode === "logged-out") {
    console.error("Not logged in");
    process.exit(1);
  }
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
if (argv[0] === "debug" && argv[1] === "models") {
  console.log(JSON.stringify({ models: [{ slug: "gpt-test", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "low" }] }));
  process.exit(0);
}
if (argv[0] !== "exec") process.exit(2);

const cfg = (key) => {
  const a = argv.find((x) => x.startsWith(`${key}=`));
  return a ? a.slice(key.length + 1) : undefined;
};
const hookCommand = (() => {
  const v = cfg("hooks.PreToolUse");
  const m = v?.match(/command=("(?:[^"\\]|\\.)*")/);
  return m ? JSON.parse(m[1]) : null;
})();
const callHook = (payload) => {
  if (!hookCommand) return { status: 0, stdout: "" };
  const r = spawnSync("sh", ["-c", hookCommand], { input: JSON.stringify({ session_id: "s", cwd: process.cwd(), model: "gpt-test", ...payload }), env: process.env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

function startMcp() {
  const command = JSON.parse(cfg("mcp_servers.platform.command"));
  const args = JSON.parse(cfg("mcp_servers.platform.args"));
  const names = JSON.parse(cfg("mcp_servers.platform.env_vars"));
  const mode = (cfg("mcp_servers.platform.env") || "").match(/PLATFORM_MODE="(\w+)"/)?.[1] || "analysis";
  const env = { PATH: process.env.PATH, PLATFORM_MODE: mode };
  for (const n of names) if (process.env[n]) env[n] = process.env[n];
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
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
}

async function tool(mcp, name, args) {
  const pre = callHook({ hook_event_name: "PreToolUse", tool_name: `mcp__platform__${name}`, tool_input: args });
  if (pre.status === 2) return { denied: true };
  out({ type: "item.started", item: { id: `mcp-${name}`, type: "mcp_tool_call", server: "platform", tool: name, arguments: args, status: "in_progress" } });
  const r = await mcp.rpc("tools/call", { name, arguments: args });
  out({ type: "item.completed", item: { id: `mcp-${name}`, type: "mcp_tool_call", server: "platform", tool: name, arguments: args, result: r.result, status: "completed" } });
  return r.result;
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (prompt += c));
await new Promise((r) => process.stdin.on("end", r));
const resumeAt = argv.indexOf("resume");
const resumeId = resumeAt >= 0 ? argv[argv.length - 2] : null;
log({ argv, prompt, resumeId, cwd: process.cwd(), env: { DATABASE_URL: !!process.env.DATABASE_URL, AUTH_SECRET: !!process.env.AUTH_SECRET, OPENAI_API_KEY: !!process.env.OPENAI_API_KEY, BROKER: !!process.env.PLATFORM_BROKER_TOKEN } });

const thread = resumeId || process.env.FAKE_CODEX_THREAD || "th-1";
out({ type: "thread.started", thread_id: thread });
out({ type: "turn.started" });
const usage = { input_tokens: 120, cached_input_tokens: 100, output_tokens: 7, reasoning_output_tokens: 3 };

if (mode === "complete") {
  out({ type: "item.completed", item: { id: "m", type: "agent_message", text: process.env.FAKE_CODEX_TEXT || "{}" } });
  out({ type: "turn.completed", usage });
  process.exit(0);
}
if (mode === "incomplete") process.exit(0);
if (mode === "quota") {
  out({ type: "error", message: "You've hit your usage limit. Upgrade to Pro or try again later." });
  out({ type: "turn.failed", error: { message: "You've hit your usage limit." } });
  process.exit(1);
}
if (mode === "hang") {
  const g = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  writeFileSync(process.env.FAKE_CODEX_PIDFILE, String(g.pid));
  setInterval(() => {}, 1000);
  await sleep(600_000);
}
if (mode === "nohook") {
  out({ type: "item.started", item: { id: "c1", type: "command_execution", command: "touch x", status: "in_progress" } });
  await sleep(5000);
  process.exit(0);
}

const start = callHook({ hook_event_name: "SessionStart", source: resumeId ? "resume" : "startup" });
log({ sessionStart: start.status });
const mcp = startMcp();
await mcp.rpc("initialize", { protocolVersion: "2025-06-18" });
const list = await mcp.rpc("tools/list", {});
log({ tools: list.result.tools.map((t) => t.name) });

if (mode === "push") {
  const r = callHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin HEAD" } });
  log({ push: r.status, stdout: r.stdout });
  const esc = callHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git commit -m x" } });
  log({ escalation: esc.status, stdout: esc.stdout });
}
if (mode === "ask") {
  await tool(mcp, "ask_user", { questions: [{ question: "Partial refund cancels shipment?", options: ["Không", "Có"] }] });
  const edit = callHook({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${process.cwd()}/x.txt\n+hi\n*** End Patch` } });
  log({ editAfterAsk: edit.status });
  out({ type: "item.completed", item: { id: "m", type: "agent_message", text: "Waiting for the developer." } });
  out({ type: "turn.completed", usage });
  mcp.close();
  process.exit(0);
}
if (mode === "commit") {
  writeFileSync(process.env.FAKE_CODEX_WS + "/feature.txt", "new\n");
  const outside = await tool(mcp, "commit_changes", { repo: "oms-api", message: "x", paths: ["../../etc"] });
  const done = await tool(mcp, "commit_changes", { repo: "oms-api", message: "feat: add feature" });
  log({ outside: outside.content[0].text, commit: done.content[0].text });
}
if (mode === "no-submit") {
  out({ type: "item.completed", item: { id: "m", type: "agent_message", text: "done" } });
  out({ type: "turn.completed", usage });
  mcp.close();
  process.exit(0);
}
const output =
  mode === "bad-contract" ? { summary: "missing keys" } : resumeId ? { goal: "resumed", requirements: [], answer_seen: prompt.includes("Không") } : { goal: "from codex", requirements: ["r1"] };
await tool(mcp, "submit_result", { output });
// The final message arrives in two stdout chunks that split a multi-byte character.
const msg = Buffer.from(JSON.stringify({ type: "item.completed", item: { id: "m", type: "agent_message", text: "Xong – kết quả ✓" } }) + "\n", "utf8");
const cut = msg.indexOf(Buffer.from("–")) + 1;
process.stdout.write(msg.subarray(0, cut));
await sleep(20);
process.stdout.write(msg.subarray(cut));
out({ type: "mystery.event", foo: 1 });
process.stdout.write("this is not json\n");
out({ type: "turn.completed", usage });
mcp.close();
process.exit(mode === "fail-after-submit" ? 1 : 0);
