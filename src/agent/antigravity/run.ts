import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../../integrations/redact.ts";
import { antigravityConfig } from "../../config.ts";
import { pool, one, q } from "../../db/pool.ts";
import { childGroups } from "../../workflow/local.ts";
import { workspacesOf } from "../../git/provider.ts";
import type { ExecutionContext } from "../../workflow/executors/registry.ts";
import { newMetrics, type AgentMetrics } from "../metrics.ts";
import type { PolicyContext, ToolMode } from "../toolPolicy.ts";
import { startBroker, type Broker } from "../codex/broker.ts";
import { envFromExecution, dispatchPlatformTool } from "../platformTools.ts";
import {
  antigravityCapabilities,
  antigravityEnv,
} from "./capabilities.ts";
import {
  antigravityHookDecision,
  writeAntigravityWorkspaceConfig,
  excludeFromGit,
} from "./policy.ts";
import {
  AntigravityStream,
  classifyAntigravityError,
  type AntigravityEvent,
} from "./stream.ts";

export interface AntigravityTurnResult {
  isError: boolean;
  text: string;
  assistantTurns: number;
  failure?: string;
  submitted?: Record<string, unknown>;
}

export interface AntigravityTurnInput {
  ctx: ExecutionContext;
  mode: ToolMode;
  policy: PolicyContext;
  cwd: string;
  prompt: string;
  metrics?: AgentMetrics;
  invocationId?: string;
  onTelemetry?: (error?: unknown) => Promise<void>;
  model?: string;
  effort?: string;
  resumeId?: string;
}

const PROMPT_CHUNK_CHARS = 16 * 1024;
const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;

function processError(message: string) {
  return Object.assign(new Error(message), { code: "AGY_INPUT_CLOSED" });
}

function waitForDrain(child: ChildProcess, signal?: AbortSignal): Promise<void> {
  const stdin = child.stdin;
  if (!stdin) return Promise.reject(processError("Antigravity stdin is unavailable"));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stdin.removeListener("drain", drained);
      stdin.removeListener("error", failed);
      stdin.removeListener("close", closed);
      child.removeListener("close", exited);
      signal?.removeEventListener("abort", aborted);
    };
    const done = (error?: Error) => {
      cleanup();
      error ? reject(error) : resolve();
    };
    const drained = () => done();
    const failed = (error: Error) => done(error);
    const closed = () => done(processError("Antigravity closed stdin before the prompt was sent"));
    const exited = () => done(processError("Antigravity exited before the prompt was sent"));
    const aborted = () => done(processError("Antigravity prompt write was aborted"));
    stdin.once("drain", drained);
    stdin.once("error", failed);
    stdin.once("close", closed);
    child.once("close", exited);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

async function writeAntigravityPrompt(child: ChildProcess, prompt: string, signal?: AbortSignal) {
  const stdin = child.stdin;
  if (!stdin) throw processError("Antigravity stdin is unavailable");
  let inputFailure: Error | undefined;
  // Always observe EPIPE, including writes that do not reach the backpressure path.
  stdin.once("error", (error) => { inputFailure = error; });
  const write = async (chunk: string) => {
    if (inputFailure) throw inputFailure;
    if (signal?.aborted) throw processError("Antigravity prompt write was aborted");
    if (stdin.destroyed || child.exitCode !== null || child.signalCode !== null)
      throw processError("Antigravity exited before the prompt was sent");
    if (!stdin.write(chunk)) await waitForDrain(child, signal);
  };

  // Stream JSON escaping in bounded pieces so the full serialized prompt is never duplicated in memory.
  await write('{"event":"user","message":{"content":"');
  for (let offset = 0; offset < prompt.length; offset += PROMPT_CHUNK_CHARS) {
    const piece = prompt.slice(offset, offset + PROMPT_CHUNK_CHARS);
    await write(JSON.stringify(piece).slice(1, -1));
  }
  await write('"}}\n');
  if (signal?.aborted) throw processError("Antigravity prompt write was aborted");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stdin.removeListener("finish", finished);
      stdin.removeListener("error", failed);
      stdin.removeListener("close", closed);
      child.removeListener("close", exited);
      signal?.removeEventListener("abort", aborted);
    };
    const done = (error?: Error) => {
      cleanup();
      error ? reject(error) : resolve();
    };
    const finished = () => done();
    const failed = (error: Error) => done(error);
    const closed = () => done(processError("Antigravity closed stdin before the prompt was flushed"));
    const exited = () => done(processError("Antigravity exited before the prompt was flushed"));
    const aborted = () => done(processError("Antigravity prompt write was aborted"));
    stdin.once("finish", finished);
    stdin.once("error", failed);
    stdin.once("close", closed);
    child.once("close", exited);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) return aborted();
    stdin.end();
  });
}

function killAntigravity(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  const force = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }, 5000);
  force.unref();
  child.once("close", () => clearTimeout(force));
}

let activeRuns = 0;
const waitingQueue: Array<() => void> = [];

async function acquireSlot(
  max: number,
  signal?: AbortSignal,
): Promise<() => void> {
  if (activeRuns < max) {
    activeRuns++;
    return () => releaseSlot(max);
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const idx = waitingQueue.indexOf(resolve);
      if (idx >= 0) waitingQueue.splice(idx, 1);
      reject(
        new Error("aborted while waiting for Antigravity concurrency slot"),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    waitingQueue.push(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });
  activeRuns++;
  return () => releaseSlot(max);
}

function releaseSlot(max: number) {
  activeRuns = Math.max(0, activeRuns - 1);
  if (activeRuns < max && waitingQueue.length > 0) {
    const next = waitingQueue.shift();
    if (next) next();
  }
}

/** Pure helper to build argv for `agy` execution. */
export function buildAntigravityArgs(opts: {
  model?: string;
  effort?: string;
  sandbox?: boolean;
  timeoutSeconds?: number;
  conversationId?: string;
  additionalDirs?: string[];
}): string[] {
  const args = [
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.sandbox !== false) args.push("--sandbox");
  if (opts.timeoutSeconds && opts.timeoutSeconds > 0) {
    args.push("--print-timeout", String(opts.timeoutSeconds * 1000));
  }
  if (opts.conversationId) {
    args.push("--conversation", opts.conversationId);
  }
  if (opts.additionalDirs) {
    for (const d of opts.additionalDirs) {
      if (d) args.push("--add-dir", d);
    }
  }
  return args;
}

export async function antigravityAgentTurn(
  input: AntigravityTurnInput,
): Promise<AntigravityTurnResult> {
  const cap = await antigravityCapabilities(false, {
    model: input.model ?? "",
    effort: input.effort ?? "",
  });
  if (!cap.ok) {
    return {
      isError: true,
      text: cap.error || "Antigravity CLI is not usable",
      assistantTurns: 0,
      failure: "AGENT_ERROR",
    };
  }

  const cfg = antigravityConfig();
  const release = await acquireSlot(cfg.maxConcurrent, input.ctx.signal);

  let broker: Broker | null = null;
  const scratchDir = mkdtempSync(join(tmpdir(), "ctp-agy-scratch-"));
  let submitted: Record<string, unknown> | undefined;

  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | null = null;

  try {
    let assistantTurns = 0;
    let fullText = "";
    let lastError: string | undefined;
    let conversationId = input.resumeId;
    let model = input.model || cfg.model;
    const metrics = input.metrics ?? newMetrics(model);

    // Start broker for tool relay and platform hooks
    const toolEnv = envFromExecution(
      input.ctx,
      input.mode,
      input.policy,
      metrics,
      (o: Record<string, unknown>) => {
        submitted = o;
      },
    );

    broker = await startBroker({
      policy: input.policy,
      cwd: input.cwd,
      decideHook: antigravityHookDecision,
      dispatch: async (name, args) => {
        return dispatchPlatformTool(name, args, toolEnv);
      },
      onDenied: async (tool, reason) => {
        metrics.denied.push({ tool, reason });
        await input.ctx.log("tool", `denied ${tool}: ${reason}`);
      },
      onModel: (m) => {
        if (m) {
          model = m;
          metrics.model = m;
        }
      },
    });

    // Write .agents/hooks.json and .agents/mcp_config.json into cwd or scratch
    writeAntigravityWorkspaceConfig(input.cwd, {
      brokerSocket: broker.socketPath,
      brokerToken: broker.token,
      mode: input.mode,
    });

    // Exclude .agents configs from git
    const workspaces = await workspacesOf(input.ctx.run.id);
    for (const w of workspaces) {
      try {
        excludeFromGit(join(w.path, ".git"));
      } catch {}
    }

    const additionalDirs = workspaces
      .map((w) => w.path)
      .filter((p) => p !== input.cwd);

    const timeoutMs = cfg.timeoutMs;
    const timeoutSec = Math.floor(timeoutMs / 1000);

    const args = buildAntigravityArgs({
      model: input.model || undefined,
      effort: input.effort || undefined,
      sandbox: cfg.sandbox,
      timeoutSeconds: timeoutSec,
      conversationId: input.resumeId || undefined,
      additionalDirs,
    });

    const env = antigravityEnv(process.env, {
      PLATFORM_BROKER_SOCKET: broker.socketPath,
      PLATFORM_BROKER_TOKEN: broker.token,
      PLATFORM_MODE: input.mode,
      TMPDIR: scratchDir,
    });

    await input.ctx.log("prompt", input.prompt, {
      provider: "antigravity",
      model: model || null,
      resume_session: conversationId ?? null,
    });

    if (input.ctx.signal.aborted) {
      return { isError: true, text: "canceled", assistantTurns: 0, failure: "CANCELED" };
    }

    child = spawn(cfg.bin, args, {
      cwd: input.cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (child.pid) childGroups.add(child.pid);

    const parser = new AntigravityStream();
    let pendingLogs = Promise.resolve();
    let stderr = "";
    let streamError: Error | undefined;
    let spawnError: Error | undefined;
    let timedOut = false;
    let inputError: Error | undefined;

    const handleEvent = async (ev: AntigravityEvent) => {
      if (ev.conversationId && ev.conversationId !== conversationId) {
        conversationId = ev.conversationId;
        await q(
          pool,
          "INSERT INTO agent_sessions (attempt_id, session_id, cwd, model, provider) VALUES ($1, $2, $3, $4, $5)",
          [
            input.ctx.attempt.id,
            conversationId,
            input.cwd,
            model,
            "antigravity",
          ],
        ).catch(() => {});
      }

      if (ev.type === "result") {
        assistantTurns = ev.turns ?? 1;
        if (ev.text != null) fullText = ev.text.slice(0, MAX_RESPONSE_CHARS);
      } else if (ev.text) {
        if (!ev.type.startsWith("step_update.")) assistantTurns++;
        const remaining = MAX_RESPONSE_CHARS - fullText.length;
        if (remaining > 0) fullText += ev.text.slice(0, remaining);
        await input.ctx.log("agent", ev.text.slice(0, Math.max(0, remaining)), {
          provider: "antigravity",
          model,
        });
      }

      if (ev.thinking) {
        await input.ctx.log("thinking", ev.thinking, {
          provider: "antigravity",
        });
      }

      if (ev.tool) {
        if (input.metrics) {
          input.metrics.tool_calls[ev.tool] =
            (input.metrics.tool_calls[ev.tool] ?? 0) + 1;
        }
        await input.ctx.log("tool", `called ${ev.tool}`, {
          provider: "antigravity",
          tool: ev.tool,
          args: ev.toolArgs,
        });
      }

      if (ev.tokens && input.metrics) {
        if (!input.metrics.tokens) {
          input.metrics.tokens = {
            input: null,
            output: null,
            cache_read: null,
            cache_creation: null,
            reasoning_output: null,
          };
        }
        const tok = input.metrics.tokens;
        const update = (key: "input" | "output" | "reasoning_output" | "cache_read" | "cache_creation", value: number | null | undefined) => {
          if (value == null) return;
          tok[key] = ev.cumulativeUsage ? value : (tok[key] ?? 0) + value;
        };
        update("input", ev.tokens.input);
        update("output", ev.tokens.output);
        update("reasoning_output", ev.tokens.reasoning);
        update("cache_read", ev.tokens.cache_read);
        update("cache_creation", ev.tokens.cache_creation);
      }

      if (ev.error || ev.status === "ERROR") lastError = ev.error || "Antigravity returned ERROR";
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      // Keep provider output bounded by the stream's high-water mark while async audit logs flush.
      child?.stdout?.pause();
      const { events, errors } = parser.push(chunk);
      for (const ev of events) {
        pendingLogs = pendingLogs.then(() => handleEvent(ev)).catch((error) => { streamError ??= error as Error; });
      }
      for (const err of errors) {
        pendingLogs = pendingLogs.then(() =>
          input.ctx.log("system", `Antigravity stream: ${err.error}`, {
            provider: "antigravity",
          }),
        ).catch((error) => { streamError ??= error as Error; });
      }
      pendingLogs = pendingLogs.finally(() => child?.stdout?.resume());
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });

    const onAbort = () => { if (child) killAntigravity(child); };
    input.ctx.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { timedOut = true; onAbort(); }, timeoutMs);
    if (input.ctx.signal.aborted) onAbort();

    child.on("error", (error) => { spawnError = error; });
    const exitPromise = new Promise<number | null>((resolve) => {
      child!.once("close", resolve);
      child!.once("error", (error) => { spawnError = error; resolve(null); });
    });
    const writePromise = writeAntigravityPrompt(child, input.prompt, input.ctx.signal).catch((error) => {
      inputError = error as Error;
      if (!input.ctx.signal.aborted && !timedOut) onAbort();
    });
    const exitCode = await exitPromise;
    await writePromise;
    await pendingLogs;

    if (timer) clearTimeout(timer);
    input.ctx.signal.removeEventListener("abort", onAbort);
    if (child?.pid) childGroups.remove(child.pid);

    const tail = parser.flush();
    for (const ev of tail.events) await handleEvent(ev);
    for (const err of tail.errors) await input.ctx.log("system", `Antigravity stream: ${err.error}`, { provider: "antigravity" });

    if (stderr.trim()) {
      await input.ctx.log("log", redactSecrets(stderr.trim()).slice(0, 4000), {
        provider: "antigravity",
        stream: "stderr",
      });
    }

    if (input.metrics) {
      input.metrics.model = model || input.metrics.model;
      input.metrics.turns += assistantTurns;
      if (input.onTelemetry) await input.onTelemetry();
    }

    // Check if submit_result was stored
    const submittedRow = await one<{
      data: { output?: Record<string, unknown> };
    }>(
      pool,
      "SELECT data FROM workflow_checkpoints WHERE attempt_id = $1 AND reason = 'submit_result' ORDER BY id DESC LIMIT 1",
      [input.ctx.attempt.id],
    );
    if (submittedRow?.data?.output) submitted = submittedRow.data.output;

    if (input.ctx.signal.aborted) {
      return {
        isError: true,
        text: "canceled",
        assistantTurns,
        failure: "CANCELED",
        submitted,
      };
    }

    if (timedOut) return { isError: true, text: "Antigravity timed out", assistantTurns, failure: "EXECUTION_TIMEOUT", submitted };

    if (spawnError) return { isError: true, text: `Unable to start Antigravity: ${spawnError.message}`, assistantTurns, failure: "AGENT_ERROR", submitted };

    if (inputError) {
      const detail = inputError.message.includes("EPIPE") || inputError.message.includes("stdin")
        ? `Antigravity exited before the prompt was fully sent (${inputError.message})`
        : inputError.message;
      return { isError: true, text: detail, assistantTurns, failure: classifyAntigravityError(detail), submitted };
    }

    if (streamError) return { isError: true, text: `Antigravity output handling failed: ${streamError.message}`, assistantTurns, failure: "AGENT_ERROR", submitted };

    if (lastError || exitCode !== 0) {
      const errDetail =
        lastError || stderr.trim() || `agy exited with code ${exitCode}`;
      const failureCat = classifyAntigravityError(errDetail);
      return {
        isError: true,
        text: errDetail,
        assistantTurns,
        failure: failureCat,
        submitted,
      };
    }

    return {
      isError: false,
      text: fullText || "Turn completed successfully",
      assistantTurns,
      submitted,
    };
  } finally {
    release();
    if (broker) await broker.close();
    rmSync(scratchDir, { recursive: true, force: true });
    rmSync(join(input.cwd, ".agents", "hooks.json"), { force: true });
    rmSync(join(input.cwd, ".agents", "mcp_config.json"), { force: true });
  }
}

/** One-shot headless auxiliary completion (Phase 10). */
export async function antigravityComplete(
  prompt: string,
  opts?: { signal?: AbortSignal },
): Promise<{
  text: string;
  model?: string;
  tokens: Record<string, number | null> | null;
}> {
  const cfg = antigravityConfig();
  if (opts?.signal?.aborted) throw new Error("Antigravity auxiliary completion canceled");
  const cap = await antigravityCapabilities(false);
  if (!cap.ok) {
    throw new Error(
      cap.error || "Antigravity CLI is not available on this worker",
    );
  }

  const args = buildAntigravityArgs({
    model: cfg.model || undefined,
    effort: cfg.effort || undefined,
    sandbox: false,
  });

  const env = antigravityEnv(process.env);
  const child = spawn(cfg.bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  if (child.pid) childGroups.add(child.pid);

  const onAbort = () => killAntigravity(child);
  opts?.signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = cfg.timeoutMs;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; onAbort(); }, timeoutMs);

  let text = "";
  let stderr = "";
  let tokens: Record<string, number | null> | null = null;
  const parser = new AntigravityStream();

  child.stdout?.on("data", (chunk: Buffer) => {
    const { events } = parser.push(chunk);
    for (const ev of events) {
      if (ev.type === "result") {
        if (ev.text != null) text = ev.text.slice(0, MAX_RESPONSE_CHARS);
      } else if (ev.text && text.length < MAX_RESPONSE_CHARS) text += ev.text.slice(0, MAX_RESPONSE_CHARS - text.length);
      if (ev.tokens) {
        tokens = {
          input: ev.tokens.input ?? null,
          output: ev.tokens.output ?? null,
          reasoning_output: ev.tokens.reasoning ?? null,
          cache_read: ev.tokens.cache_read ?? null,
        };
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-16000);
  });

  child.once("error", () => {});
  const writePromise = writeAntigravityPrompt(child, prompt, opts?.signal).catch((error) => {
    if (!opts?.signal?.aborted && !timedOut) onAbort();
    return error as Error;
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(null));
  });
  const inputError = await writePromise;
  clearTimeout(timer);

  opts?.signal?.removeEventListener("abort", onAbort);
  if (child.pid) childGroups.remove(child.pid);

  const tail = parser.flush();
  for (const ev of tail.events) {
    if (ev.type === "result") {
      if (ev.text != null) text = ev.text.slice(0, MAX_RESPONSE_CHARS);
    } else if (ev.text && text.length < MAX_RESPONSE_CHARS) text += ev.text.slice(0, MAX_RESPONSE_CHARS - text.length);
  }

  if (opts?.signal?.aborted) throw new Error("Antigravity auxiliary completion canceled");
  if (timedOut) throw new Error("Antigravity auxiliary completion timed out");
  if (inputError) throw new Error(`Antigravity prompt delivery failed: ${inputError.message}`);
  if (exitCode !== 0) {
    throw new Error(
      redactSecrets(stderr.trim()) ||
        `Antigravity auxiliary completion failed with exit code ${exitCode}`,
    );
  }

  return { text: text.trim(), model: cfg.model || undefined, tokens };
}
