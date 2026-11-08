import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  promptFile?: string;
  model?: string;
  effort?: string;
  sandbox?: boolean;
  timeoutSeconds?: number;
  conversationId?: string;
  additionalDirs?: string[];
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--dangerously-skip-permissions",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.sandbox !== false) args.push("--sandbox");
  if (opts.timeoutSeconds && opts.timeoutSeconds > 0) {
    args.push("--print-timeout", `${opts.timeoutSeconds}s`);
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

    child = spawn(cfg.bin, args, {
      cwd: input.cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (child.pid) childGroups.add(child.pid);

    const onAbort = () => {
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {}
        }
        setTimeout(() => {
          if (child?.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              try {
                child.kill("SIGKILL");
              } catch {}
            }
          }
        }, 5000).unref();
      }
    };

    input.ctx.signal.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(() => {
      onAbort();
    }, timeoutMs);

    // Write prompt to child stdin
    child.stdin?.write(input.prompt);
    child.stdin?.end();

    const parser = new AntigravityStream();
    let pendingLogs = Promise.resolve();
    let stderr = "";

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

      if (ev.text) {
        assistantTurns++;
        fullText += ev.text;
        await input.ctx.log("agent", ev.text, {
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
            input: 0,
            output: 0,
            cache_read: 0,
            cache_creation: 0,
            reasoning_output: 0,
          };
        }
        const tok = input.metrics.tokens;
        if (ev.tokens.input != null)
          tok.input = (tok.input ?? 0) + ev.tokens.input;
        if (ev.tokens.output != null)
          tok.output = (tok.output ?? 0) + ev.tokens.output;
        if (ev.tokens.reasoning != null)
          tok.reasoning_output =
            (tok.reasoning_output ?? 0) + ev.tokens.reasoning;
        if (ev.tokens.cache_read != null)
          tok.cache_read = (tok.cache_read ?? 0) + ev.tokens.cache_read;
      }

      if (ev.error) {
        lastError = ev.error;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const { events, errors } = parser.push(chunk);
      for (const ev of events) {
        pendingLogs = pendingLogs.then(() => handleEvent(ev));
      }
      for (const err of errors) {
        pendingLogs = pendingLogs.then(() =>
          input.ctx.log("system", `Antigravity stream: ${err.error}`, {
            provider: "antigravity",
          }),
        );
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child?.on("error", (e) => {
        stderr += `\n${e.message}`;
        pendingLogs.then(() => resolve(null));
      });
      child?.on("close", (code) => {
        pendingLogs.then(() => resolve(code));
      });
    });

    if (timer) clearTimeout(timer);
    input.ctx.signal.removeEventListener("abort", onAbort);
    if (child?.pid) childGroups.remove(child.pid);

    const tail = parser.flush();
    for (const ev of tail.events) {
      await handleEvent(ev);
    }

    if (stderr.trim()) {
      await input.ctx.log("log", stderr.trim().slice(0, 4000), {
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

    if (exitCode !== 0) {
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
  const cap = await antigravityCapabilities(false);
  if (!cap.ok) {
    throw new Error(
      cap.error || "Antigravity CLI is not available on this worker",
    );
  }

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--dangerously-skip-permissions",
  ];
  if (cfg.model) args.push("--model", cfg.model);
  if (cfg.effort) args.push("--effort", cfg.effort);

  const env = antigravityEnv(process.env);
  const child = spawn(cfg.bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  if (child.pid) childGroups.add(child.pid);

  const onAbort = () => {
    try {
      child.kill("SIGKILL");
    } catch {}
  };
  opts?.signal?.addEventListener("abort", onAbort, { once: true });

  child.stdin?.write(prompt);
  child.stdin?.end();

  let text = "";
  let stderr = "";
  let tokens: Record<string, number | null> | null = null;
  const parser = new AntigravityStream();

  child.stdout?.on("data", (chunk: Buffer) => {
    const { events } = parser.push(chunk);
    for (const ev of events) {
      if (ev.text) text += ev.text;
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
    stderr += chunk.toString("utf8");
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(null));
  });

  opts?.signal?.removeEventListener("abort", onAbort);
  if (child.pid) childGroups.remove(child.pid);

  const tail = parser.flush();
  for (const ev of tail.events) {
    if (ev.text) text += ev.text;
  }

  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() ||
        `Antigravity auxiliary completion failed with exit code ${exitCode}`,
    );
  }

  return { text: text.trim(), model: cfg.model || undefined, tokens };
}
