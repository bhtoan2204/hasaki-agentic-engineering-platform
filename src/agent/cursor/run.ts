import type { AgentMetrics } from "../metrics.ts";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "../../config.ts";
import { pool, one } from "../../db/pool.ts";
import { childGroups } from "../../workflow/local.ts";
import { workspacesOf } from "../../git/provider.ts";
import type { ExecutionContext } from "../../workflow/executors/registry.ts";
import type { PolicyContext, ToolMode } from "../toolPolicy.ts";
import { excludeFromGit, writeCursorPolicy, writeMcpConfig } from "./permissions.ts";
import { cursorToolDecision, writeOutsideWorktrees } from "./policyWatch.ts";
import { isDuplicateAssistant, NdjsonStream, toolCallShape, type CursorEvent } from "./stream.ts";

const exec = promisify(execFile);

export interface CursorTurnResult {
  isError: boolean;
  text: string;
  assistantTurns: number;
  submitted?: Record<string, unknown>;
}

export interface CursorCapability {
  ok: boolean;
  bin: string;
  error?: string;
}

let capabilityCache: CursorCapability | null = null;

export function cursorBinary(): string {
  return process.env.CURSOR_AGENT_BIN || config.agent.cursorBin || "agent";
}

/** Probe the installed CLI. Cached for the process. Never falls back to Claude. */
export async function cursorCapabilities(force = false): Promise<CursorCapability> {
  if (capabilityCache && !force && !process.env.CURSOR_AGENT_BIN) return capabilityCache;
  const bin = cursorBinary();
  let help = "";
  try {
    const out = await exec(bin, ["--help"], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    help = `${out.stdout}\n${out.stderr}`;
  } catch (e: any) {
    const missing = e?.code === "ENOENT";
    return finish({
      ok: false,
      bin,
      error: missing
        ? `Cursor CLI was not found (${bin}). Install it and ensure \`agent\` is on PATH, then run \`agent login\`. The platform will not fall back to Claude.`
        : `Cursor CLI (${bin}) failed: ${String(e?.stderr || e?.message || e).slice(0, 400)}. The platform will not fall back to Claude.`,
    });
  }
  for (const flag of ["--print", "--output-format", "--resume", "--mode", "--approve-mcps", "--trust", "--sandbox", "--force"]) {
    if (!help.includes(flag))
      return finish({ ok: false, bin, error: `Cursor CLI at ${bin} does not advertise ${flag}. This version cannot enforce the platform's execution policy. The platform will not fall back to Claude.` });
  }
  if (!process.env.CURSOR_API_KEY) {
    try {
      const st = await exec(bin, ["status"], { timeout: 20_000, maxBuffer: 256 * 1024 });
      const body = `${st.stdout}\n${st.stderr}`;
      if (!/logged in/i.test(body))
        return finish({ ok: false, bin, error: "Cursor CLI is not authenticated. Run `agent login` on this machine, or set CURSOR_API_KEY. The platform will not fall back to Claude." });
    } catch (e: any) {
      return finish({ ok: false, bin, error: `Cursor CLI authentication check failed: ${String(e?.stderr || e?.message || e).split("\n")[0]}. Run \`agent login\` or set CURSOR_API_KEY. The platform will not fall back to Claude.` });
    }
  }
  return finish({ ok: true, bin });
}

function finish(c: CursorCapability): CursorCapability {
  if (!process.env.CURSOR_AGENT_BIN) capabilityCache = c;
  return c;
}

export interface CursorTurnInput {
  metrics?: AgentMetrics;
  invocationId?: string;
  onTelemetry?: (error?: unknown) => Promise<void>;
  ctx: ExecutionContext;
  mode: ToolMode;
  policy: PolicyContext;
  cwd: string;
  prompt: string;
  resumeId?: string;
  /** Claude-only delegation cannot be enforced. The caller should already have rejected it. */
}

export async function cursorAgentTurn(input: CursorTurnInput): Promise<CursorTurnResult> {
  const cap = await cursorCapabilities();
  if (!cap.ok) return { isError: true, text: cap.error || "Cursor CLI is not usable", assistantTurns: 0 };
  if (input.policy.delegation)
    return {
      isError: true,
      text: "This Cursor CLI cannot enforce the platform's read-only subagent policy. Disable delegation on the step, or create the run with Claude. The platform will not fall back to Claude.",
      assistantTurns: 0,
    };
  mkdirSync(input.cwd, { recursive: true });
  const token = randomBytes(24).toString("hex");
  const promptFile = join(input.cwd, ".cursor", "task-prompt.txt");
  mkdirSync(join(input.cwd, ".cursor"), { recursive: true });
  writeFileSync(promptFile, input.prompt);
  writeCursorPolicy(input.cwd, { reposRoot: config.reposRoot, protectedRoots: input.policy.protectedRoots, workspaces: [...input.policy.workspaces] });
  writeMcpConfig(input.cwd, process.execPath, [join(import.meta.dirname, "bridge.ts")], {
    PLATFORM_BRIDGE_TOKEN: token,
    PLATFORM_INSTANCE: config.instanceId,
    PLATFORM_CONFIG: resolve(process.env.PLATFORM_CONFIG ?? "config.json"),
    PLATFORM_RUN_ID: String(input.ctx.run.id),
    PLATFORM_STEP_ID: String(input.ctx.step.id),
    PLATFORM_ATTEMPT_ID: String(input.ctx.attempt.id),
    PLATFORM_MODE: input.mode,
    DATABASE_URL: process.env.DATABASE_URL || config.databaseUrl,
  });
  const gitDir = join(input.cwd, ".git");
  if (existsSync(gitDir)) excludeFromGit(gitDir);

  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--approve-mcps",
    "--workspace",
    input.cwd,
    "--sandbox",
    input.mode === "analysis" ? "enabled" : "disabled",
  ];
  if (input.mode === "analysis") args.push("--mode", "ask");
  else args.push("--force");
  if (input.resumeId) args.push("--resume", input.resumeId);
  for (const dir of extraDirs(input)) args.push("--add-dir", dir);
  args.push(`Follow the task in ${promptFile}. Do not print or copy .cursor/mcp.json. Use the platform MCP tools for questions, progress, knowledge, and submit_result.`);

  const child = spawn(cap.bin, args, {
    cwd: input.cwd,
    env: scrubEnv(process.env),
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid) childGroups.add(child.pid);
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  const onAbort = () => kill();
  input.ctx.signal.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = Number(process.env.CURSOR_AGENT_TIMEOUT_MS || 45 * 60 * 1000);
  const timer = setTimeout(kill, timeoutMs);

  const parser = new NdjsonStream();
  let stderr = "";
  let assistantTurns = 0;
  let text = "";
  let sawResult = false;
  let isError = false;
  let model = "";
  let sessionId = "";
  let duration: number | null = null;
  let violation = "";
  const toolCalls: Record<string, number> = {};
  let toolErrors = 0;
  const denied: Array<{ tool: string; reason: string }> = [];

  const seenTools = new Set<string>();
  const handle = async (ev: CursorEvent) => {
    const eventKey = `${ev.subtype}:${ev.call_id}`;
    if (ev.type === "tool_call" && ev.call_id) {
      if (seenTools.has(eventKey)) return;
      seenTools.add(eventKey);
    }
    const toolId = ev.call_id ? `${input.invocationId ?? input.ctx.attempt.id}:${ev.call_id}` : undefined;
    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
      sessionId = ev.session_id;
      model = ev.model || "";
      if (input.metrics && model) input.metrics.model = model;
      await input.onTelemetry?.();
      await input.ctx.recordSession(ev.session_id, input.cwd, model, "cursor");
      await input.ctx.log("system", `Cursor session ${ev.session_id} started${model ? ` (model ${model})` : ""}`, { provider: "cursor", session_id: ev.session_id, model: model || null });
    } else if (ev.type === "thinking" && ev.text?.trim()) {
      await input.ctx.log("thinking", ev.text, { provider: "cursor" });
    } else if (ev.type === "assistant" && !isDuplicateAssistant(ev, true)) {
      assistantTurns++;
      if (ev.text?.trim()) {
        text = ev.text;
        await input.ctx.log("agent", ev.text, { provider: "cursor" });
      }
    } else if (ev.type === "tool_call" && ev.subtype === "started") {
      const shape = toolCallShape(ev.tool_call);
      const name = shape?.name ?? "tool";
      toolCalls[name] = (toolCalls[name] ?? 0) + 1;
      await input.ctx.log("tool", `${name}`, { provider: "cursor", call_id: ev.call_id, id: toolId, name, tool_call: ev.tool_call });
      const ws = (await workspacesOf(input.ctx.run.id)).map((w) => w.path);
      const policy = { ...input.policy, workspaces: [...new Set([...input.policy.workspaces, ...ws])] };
      const decision = cursorToolDecision(ev.tool_call, policy, input.cwd);
      const path = String((shape?.body as any)?.args?.path ?? (shape?.body as any)?.args?.file_path ?? "");
      const outside = (shape?.name === "write" || shape?.name === "edit") && path && writeOutsideWorktrees(path, policy.workspaces);
      if (!decision.allow || outside) {
        const reason = !decision.allow ? decision.reason : `write ${path} is outside the run's worktrees`;
        violation = reason;
        denied.push({ tool: shape?.name ?? "tool", reason });
        await input.ctx.log("tool", `denied ${shape?.name ?? "tool"}: ${reason}`, { provider: "cursor" });
        kill();
      }
    } else if (ev.type === "tool_call" && ev.subtype === "completed") {
      const failed = JSON.stringify(ev.tool_call ?? {}).includes('"error"');
      if (failed) toolErrors++;
      await input.ctx.log("tool_result", JSON.stringify(ev.tool_call ?? {}).slice(0, 4000), { provider: "cursor", call_id: ev.call_id, tool_use_id: toolId, is_error: failed });
    } else if (ev.type === "result") {
      if (sawResult) return;
      sawResult = true;
      isError = ev.is_error === true || ev.subtype === "error";
      if (typeof ev.result === "string") text = ev.result;
      if (typeof ev.duration_ms === "number") duration = ev.duration_ms;
      await input.onTelemetry?.(isError ? ev.raw : undefined);
    }
  };

  const consume = async (chunk: string) => {
    const { events, errors } = parser.push(chunk);
    for (const err of errors) await input.ctx.log("system", `Cursor stream: malformed line (${err.error})`, { provider: "cursor", line: err.line });
    for (const ev of events) await handle(ev);
  };

  let pending = Promise.resolve();
  const exitCode = await new Promise<number | null>((resolve) => {
    child.stdout?.on("data", (b: Buffer) => {
      pending = pending.then(() => consume(b.toString("utf8")));
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", (e) => {
      stderr += e.message;
      pending.then(() => resolve(null));
    });
    child.on("close", (code) => {
      pending.then(() => resolve(code));
    });
  });
  clearTimeout(timer);
  input.ctx.signal.removeEventListener("abort", onAbort);
  if (child.pid) childGroups.remove(child.pid);
  const tail = parser.flush();
  for (const ev of tail.events) await handle(ev);
  for (const err of tail.errors) await input.ctx.log("system", `Cursor stream: malformed line (${err.error})`, { provider: "cursor" });

  rmSync(join(input.cwd, ".cursor", "mcp.json"), { force: true });
  rmSync(promptFile, { force: true });
  rmSync(join(input.cwd, ".cursor", "cli.json"), { force: true });



  const submittedRow = await one<{ data: { output?: Record<string, unknown> } }>(
    pool,
    "SELECT data FROM workflow_checkpoints WHERE attempt_id = $1 AND reason = 'submit_result' ORDER BY id DESC LIMIT 1",
    [input.ctx.attempt.id],
  );
  const submitted = submittedRow?.data?.output;

  if (input.metrics) {
    input.metrics.model = model || input.metrics.model;
    input.metrics.sessions += sessionId ? 1 : 0;
    input.metrics.duration_ms += duration ?? 0;
    input.metrics.turns += assistantTurns;
    for (const [name, count] of Object.entries(toolCalls)) input.metrics.tool_calls[name] = (input.metrics.tool_calls[name] ?? 0) + count;
    input.metrics.tool_errors += toolErrors;
    input.metrics.denied.push(...denied);
  }

  if (input.ctx.signal.aborted) return { isError: true, text: "canceled", assistantTurns };
  if (violation) return { isError: true, text: `Cursor tool blocked by platform policy: ${violation}`, assistantTurns: Math.max(assistantTurns, 1) };

  const ws = (await workspacesOf(input.ctx.run.id)).map((w) => w.path);
  for (const p of ws) if (!input.policy.workspaces.includes(p)) input.policy.workspaces.push(p);

  if (stderr.trim()) await input.ctx.log("log", stderr.trim().slice(0, 4000), { provider: "cursor", stream: "stderr" });

  if (!sawResult) {
    const why = exitCode === 0 ? "Cursor exited 0 without a result event" : `Cursor exited ${exitCode ?? "unknown"} without a result event`;
    return { isError: true, text: `${why}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`, assistantTurns, submitted };
  }
  if (exitCode !== 0 || isError) return { isError: true, text: text || stderr.trim().slice(0, 500) || `Cursor exited ${exitCode}`, assistantTurns, submitted };
  return { isError: false, text, assistantTurns, submitted };
}

function extraDirs(input: CursorTurnInput): string[] {
  const dirs = new Set<string>([config.reposRoot, ...(input.policy.protectedRoots ?? []), ...input.policy.workspaces]);
  dirs.delete(input.cwd);
  return [...dirs].filter((d) => d && existsSync(d));
}

function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.PLATFORM_BRIDGE_TOKEN;
  return out;
}

/** One-shot text completion for auxiliary calls (ranking, report, test explanation). No tools that mutate. */
export async function cursorComplete(prompt: string, signal?: AbortSignal): Promise<string> {
  const cap = await cursorCapabilities();
  if (!cap.ok) throw new Error(cap.error);
  const dir = join(tmpdir(), `cursor-complete-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "prompt.txt");
  writeFileSync(file, prompt);
  writeCursorPolicy(dir, { reposRoot: config.reposRoot, workspaces: [] });
  const args = ["--print", "--output-format", "json", "--mode", "ask", "--sandbox", "enabled", "--trust", "--workspace", dir, `Reply using only the instructions in ${file}. Do not modify files.`];
  const child = spawn(cap.bin, args, { cwd: dir, env: scrubEnv(process.env), detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  if (child.pid) childGroups.add(child.pid);
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  signal?.addEventListener("abort", kill, { once: true });
  let stdout = "";
  let stderr = "";
  const code = await new Promise<number | null>((resolve) => {
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", () => resolve(null));
    child.on("close", (c) => resolve(c));
  });
  if (child.pid) childGroups.remove(child.pid);
  rmSync(dir, { recursive: true, force: true });
  if (signal?.aborted) throw new Error("canceled");
  if (code !== 0) throw new Error(`Cursor text completion failed (${code}): ${stderr.slice(0, 300)}`);
  try {
    const msg = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) || "{}");
    if (typeof msg.result === "string") return msg.result;
  } catch {
    /* text fallback */
  }
  if (!stdout.trim()) throw new Error("Cursor text completion returned no result");
  return stdout.trim();
}
