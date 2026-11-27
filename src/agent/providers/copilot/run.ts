import { type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copilotConfig } from "../../../config.ts";
import { pool, q } from "../../../db/pool.ts";
import { observeLiveUsage } from "../../../eval/liveRuntime.ts";
import { workspacesOf } from "../../../git/provider.ts";
import { redactSecrets } from "../../../integrations/redact.ts";
import type { ExecutionContext } from "../../../workflow/executors/registry.ts";
import { startBroker, type Broker } from "../../broker/server.ts";
import {
  checkpointMark,
  readSubmitted,
  stopFailure,
  superviseTurn,
  turnLimits,
} from "../../harness/cliTurn.ts";
import { newMetrics, type AgentMetrics } from "../../metrics.ts";
import { isModelBlocked } from "../../modelPolicy.ts";
import { dispatchPlatformTool, envFromExecution } from "../../platformTools.ts";
import { superviseSpawn, supervisionNote, type Supervised } from "../../process/supervisor.ts";
import type { PolicyContext, ToolMode } from "../../toolPolicy.ts";
import {
  buildCopilotArgs,
  MAX_RESPONSE_CHARS,
  shouldUseStdinPrompt,
  writeCopilotStdinPrompt,
} from "./args.ts";
import { copilotCapabilities, copilotEnv } from "./capabilities.ts";
import {
  copilotHookDecision,
  excludeFromGit,
  removeCopilotWorkspaceConfig,
  writeCopilotWorkspaceConfig,
} from "./policy.ts";
import { CopilotStream, TextBatch, classifyCopilotError, type CopilotEvent } from "./stream.ts";

export { buildCopilotArgs, shouldUseStdinPrompt } from "./args.ts";
export { copilotComplete } from "./complete.ts";

export interface CopilotTurnResult {
  isError: boolean;
  text: string;
  assistantTurns: number;
  failure?: string;
  submitted?: Record<string, unknown>;
}

export interface CopilotTurnInput {
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

async function acquireSlot(max: number, signal?: AbortSignal): Promise<() => void> {
  if (activeRuns < max) {
    activeRuns++;
    return () => releaseSlot(max);
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const idx = waitingQueue.indexOf(resolve);
      if (idx >= 0) waitingQueue.splice(idx, 1);
      reject(new Error("aborted while waiting for Copilot concurrency slot"));
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

/** The hook process starts as the tool event is emitted, so give it a moment to reach the broker. */
async function hookRan(broker: Broker | null): Promise<boolean> {
  for (let waited = 0; waited <= 3000; waited += 50) {
    if ((broker?.preToolUseCalls ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

export async function copilotAgentTurn(input: CopilotTurnInput): Promise<CopilotTurnResult> {
  if (input.policy.delegation)
    return {
      isError: true,
      text: "Copilot runs cannot enforce the platform's read-only subagent policy. Disable delegation on the step, or create the run with Claude. The platform does not fall back to another provider.",
      assistantTurns: 0,
      failure: "POLICY_VIOLATION",
    };
  const turnMark = await checkpointMark(input.ctx.attempt.id);
  const usageBase = { ...input.metrics?.tokens };
  const cap = await copilotCapabilities(false, {
    model: input.model ?? "",
    effort: input.effort ?? "",
  });
  if (!cap.ok) {
    return {
      isError: true,
      text: cap.error || "Copilot CLI is not usable",
      assistantTurns: 0,
      failure: "AGENT_ERROR",
    };
  }

  const cfg = copilotConfig();
  const release = await acquireSlot(
    input.ctx.attempt.effective_agent?.options?.max_concurrent ?? cfg.maxConcurrent,
    input.ctx.signal,
  );

  let broker: Broker | null = null;
  const scratchDir = mkdtempSync(join(tmpdir(), "ctp-copilot-scratch-"));
  let submitted: Record<string, unknown> | undefined;

  let child: ChildProcess | null = null;
  let proc: Supervised | null = null;

  try {
    let assistantTurns = 0;
    let fullText = "";
    let lastError: string | undefined;
    let conversationId = input.resumeId;
    let model = input.model ?? "";
    const metrics = input.metrics ?? newMetrics(model);
    const recordModel = async (reported: string) => {
      if (!reported.trim()) return;
      if (reported.trim() === model && metrics.model_source === "provider_reported") return;
      model = reported.trim();
      metrics.model = model;
      metrics.model_source = "provider_reported";
      if (conversationId) {
        await q(
          pool,
          "UPDATE agent_sessions SET model=$3 WHERE attempt_id=$1 AND session_id=$2 AND provider='copilot'",
          [input.ctx.attempt.id, conversationId, model],
        );
      }
      await input.onTelemetry?.();
    };

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

    const activity = { touch: () => {} };
    broker = await startBroker({
      onActivity: () => activity.touch(),
      policy: input.policy,
      cwd: input.cwd,
      decideHook: copilotHookDecision,
      dispatch: async (name, args) => {
        return dispatchPlatformTool(name, args, toolEnv);
      },
      onDenied: async (tool, reason) => {
        metrics.denied.push({ tool, reason });
        await input.ctx.log("tool", `denied ${tool}: ${reason}`);
      },
      onModel: recordModel,
    });

    // Hooks go into the worktree; the MCP config (no credentials) stays in the scratch directory.
    const { mcpConfigPath } = writeCopilotWorkspaceConfig(input.cwd, {
      mcpDir: scratchDir,
      mode: input.mode,
    });

    // Exclude .agents configs from git
    const workspaces = await workspacesOf(input.ctx.run.id);
    for (const w of workspaces) {
      try {
        excludeFromGit(join(w.path, ".git"));
      } catch {
        /* ignore */
      }
    }

    const additionalDirs = workspaces.map((w) => w.path).filter((p) => p !== input.cwd);

    const limits = turnLimits(input.ctx.attempt.effective_agent, cfg.timeoutMs);

    const useStdin = shouldUseStdinPrompt(input.prompt);
    const args = buildCopilotArgs({
      prompt: useStdin ? undefined : input.prompt,
      useStdinPrompt: useStdin,
      model: input.model || undefined,
      effort: input.effort || undefined,
      conversationId: input.resumeId || undefined,
      additionalDirs,
      mcpConfigPath,
      allowTools: true,
      trustFolder: true,
    });

    const env = copilotEnv(process.env, {
      PLATFORM_BROKER_SOCKET: broker.socketPath,
      PLATFORM_BROKER_TOKEN: broker.token,
      PLATFORM_MODE: input.mode,
      TMPDIR: scratchDir,
    });

    await input.ctx.log("prompt", input.prompt, {
      provider: "copilot",
      model: model || null,
      resume_session: conversationId ?? null,
    });

    if (input.ctx.signal.aborted) {
      return { isError: true, text: "canceled", assistantTurns: 0, failure: "CANCELED" };
    }

    // SIGTERM, then SIGKILL after 5 s, as before.
    proc = await superviseSpawn({
      command: cfg.bin,
      args,
      cwd: input.cwd,
      env,
      stdin: useStdin ? "pipe" : "ignore",
      class: "agent",
      graceMs: 5000,
      timeoutMs: limits.timeoutMs + 60_000,
      runId: input.ctx.run.id,
      attemptId: input.ctx.attempt.id,
    });
    child = proc.child;
    const watch = superviseTurn({
      signal: input.ctx.signal,
      ...limits,
      stop: () => {
        proc?.stop();
      },
    });
    activity.touch = () => watch.touch();

    const parser = new CopilotStream();
    const agentText = new TextBatch();
    const thinkingText = new TextBatch();
    const logPiece = async (kind: "agent" | "thinking", text: string) => {
      if (!text) return;
      await input.ctx.log(kind, text, {
        provider: "copilot",
        ...(kind === "agent" ? { model } : {}),
      });
    };
    const flushSpeech = async () => {
      await logPiece("agent", agentText.flush());
      await logPiece("thinking", thinkingText.flush());
    };
    let pendingLogs = Promise.resolve();
    let stderr = "";
    let streamError: Error | undefined;
    let spawnError: Error | undefined;
    let sawResult = false;
    let violation = "";
    let blockedModel = "";
    let inputError: Error | undefined;

    const handleEvent = async (ev: CopilotEvent) => {
      if (ev.model && isModelBlocked(ev.model)) {
        blockedModel ||= `Copilot runs model "${ev.model}", which is blocked by platform policy (agent.blockedModels); the run was stopped.`;
        proc?.stop();
        return;
      }
      if (ev.model) await recordModel(ev.model);
      if (ev.conversationId && ev.conversationId !== conversationId) {
        conversationId = ev.conversationId;
        await q(
          pool,
          "INSERT INTO agent_sessions (attempt_id, session_id, cwd, model, provider) VALUES ($1, $2, $3, $4, $5)",
          [input.ctx.attempt.id, conversationId, input.cwd, model, "copilot"],
        ).catch(() => {});
      }

      // The real CLI ends a finished session with assistant.idle; it does not send a result event.
      if (ev.type === "assistant.idle") sawResult = true;
      if (ev.type === "result") {
        sawResult = true;
        assistantTurns = Math.max(assistantTurns, ev.turns ?? 1);
        if (ev.text != null) fullText = ev.text.slice(0, MAX_RESPONSE_CHARS);
        await flushSpeech();
      } else if (ev.type === "assistant.message" && ev.text) {
        // Final assistant message replaces streamed deltas for a clean transcript.
        fullText = ev.text.slice(0, MAX_RESPONSE_CHARS);
        assistantTurns = Math.max(assistantTurns, 1);
        await flushSpeech();
        await logPiece("agent", fullText);
      } else if (ev.text) {
        if (!ev.type.startsWith("step_update.") && ev.type !== "assistant.message_delta")
          assistantTurns++;
        if (ev.type === "assistant.message_delta") assistantTurns = Math.max(assistantTurns, 1);
        const remaining = MAX_RESPONSE_CHARS - fullText.length;
        if (remaining > 0) {
          const piece = ev.text.slice(0, remaining);
          fullText += piece;
          const ready = agentText.push(piece);
          if (ready) await logPiece("agent", ready);
        }
      }

      if (ev.thinking) {
        const ready = thinkingText.push(ev.thinking);
        if (ready) await logPiece("thinking", ready);
      }

      if (ev.tool || ev.type === "result") await flushSpeech();

      // CLI 1.0 hooks are best-effort (.github/hooks). Native tools may appear before PreToolUse
      // fires; only hard-fail when the broker was never contacted after a platform MCP tool.
      if (ev.tool && !violation && !(await hookRan(broker))) {
        violation =
          "Copilot started a tool without running the platform's pre-execution hook; the run was stopped";
        input.metrics?.denied.push({ tool: ev.tool, reason: violation });
        proc?.stop();
      }

      if (ev.tool) {
        if (input.metrics) {
          input.metrics.tool_calls[ev.tool] = (input.metrics.tool_calls[ev.tool] ?? 0) + 1;
        }
        const args = ev.toolArgs;
        const raw =
          args && typeof args === "object"
            ? ((args as { command?: unknown }).command ??
              (args as { CommandLine?: unknown }).CommandLine ??
              (args as { cmd?: unknown }).cmd)
            : args;
        const command = typeof raw === "string" ? raw : "";
        await input.ctx.log("tool", command ? `${ev.tool} ${command.slice(0, 300)}` : ev.tool, {
          provider: "copilot",
          name: ev.tool,
          tool: ev.tool,
          input: args ?? {},
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
        const update = (
          key: "input" | "output" | "reasoning_output" | "cache_read" | "cache_creation",
          value: number | null | undefined,
        ) => {
          if (value == null) return;
          tok[key] = ev.cumulativeUsage ? value + (usageBase[key] ?? 0) : (tok[key] ?? 0) + value;
        };
        update("input", ev.tokens.input);
        update("output", ev.tokens.output);
        update("reasoning_output", ev.tokens.reasoning);
        update("cache_read", ev.tokens.cache_read);
        update("cache_creation", ev.tokens.cache_creation);
        observeLiveUsage(input.metrics);
      }

      if (ev.error || ev.status === "ERROR") lastError = ev.error || "Copilot returned ERROR";
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      watch.touch();
      // Keep provider output bounded by the stream's high-water mark while async audit logs flush.
      child?.stdout?.pause();
      const { events, errors } = parser.push(chunk);
      for (const ev of events) {
        pendingLogs = pendingLogs
          .then(() => handleEvent(ev))
          .catch((error) => {
            streamError ??= error as Error;
          });
      }
      for (const err of errors) {
        pendingLogs = pendingLogs
          .then(() =>
            input.ctx.log("system", `Copilot stream: ${err.error}`, {
              provider: "copilot",
            }),
          )
          .catch((error) => {
            streamError ??= error as Error;
          });
      }
      pendingLogs = pendingLogs.finally(() => child?.stdout?.resume());
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });

    child.on("error", (error) => {
      spawnError = error;
    });
    const exitPromise = new Promise<number | null>((resolve) => {
      child!.once("close", resolve);
      child!.once("error", (error) => {
        spawnError = error;
        resolve(null);
      });
    });
    const writePromise = useStdin
      ? writeCopilotStdinPrompt(child, input.prompt, input.ctx.signal).catch((error) => {
          inputError = error as Error;
          if (!watch.reason) proc?.stop();
        })
      : Promise.resolve();
    const exitCode = await exitPromise;
    watch.dispose();
    await writePromise;
    await pendingLogs;

    watch.dispose();
    const supervision = await proc.done;
    const supervisionLine = supervisionNote(supervision);
    if (supervisionLine)
      await input.ctx.log("system", supervisionLine, { provider: "copilot", supervision });

    const tail = parser.flush();
    for (const ev of tail.events) await handleEvent(ev);
    await flushSpeech();
    for (const err of tail.errors)
      await input.ctx.log("system", `Copilot stream: ${err.error}`, {
        provider: "copilot",
      });

    if (stderr.trim()) {
      await input.ctx.log("log", redactSecrets(stderr.trim()).slice(0, 4000), {
        provider: "copilot",
        stream: "stderr",
      });
    }

    if (input.metrics) {
      input.metrics.model = model || input.metrics.model;
      input.metrics.turns += assistantTurns;
      if (input.onTelemetry) await input.onTelemetry();
    }

    submitted = submitted ?? (await readSubmitted(input.ctx.attempt.id, turnMark));

    const stopped = watch.reason ?? (input.ctx.signal.aborted ? "canceled" : null);
    if (stopped)
      return {
        isError: true,
        ...stopFailure(stopped, "Copilot", limits),
        assistantTurns,
        submitted,
      };

    if (blockedModel)
      return { isError: true, text: blockedModel, assistantTurns: 0, failure: "POLICY_VIOLATION" };
    if (violation)
      return {
        isError: true,
        text: violation,
        assistantTurns: Math.max(assistantTurns, 1),
        failure: "UNSAFE_SIDE_EFFECT",
        submitted,
      };

    if (spawnError)
      return {
        isError: true,
        text: `Unable to start Copilot: ${spawnError.message}`,
        assistantTurns,
        failure: "AGENT_ERROR",
        submitted,
      };

    if (inputError) {
      const detail =
        inputError.message.includes("EPIPE") || inputError.message.includes("stdin")
          ? `Copilot exited before the prompt was fully sent (${inputError.message})`
          : inputError.message;
      return {
        isError: true,
        text: detail,
        assistantTurns,
        failure: classifyCopilotError(detail),
        submitted,
      };
    }

    if (streamError)
      return {
        isError: true,
        text: `Copilot output handling failed: ${streamError.message}`,
        assistantTurns,
        failure: "AGENT_ERROR",
        submitted,
      };

    if (lastError || exitCode !== 0) {
      const errDetail = lastError || stderr.trim() || `copilot exited with code ${exitCode}`;
      const failureCat = classifyCopilotError(errDetail);
      return {
        isError: true,
        text: errDetail,
        assistantTurns,
        failure: failureCat,
        submitted,
      };
    }

    if (!sawResult && !submitted)
      return {
        isError: true,
        text: fullText
          ? "Copilot's output ended before the CLI reported completion; the partial reply was discarded"
          : "Copilot exited without a result, a reply or a submitted output",
        assistantTurns,
        failure: "INCOMPLETE_OUTPUT",
        submitted,
      };

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
    removeCopilotWorkspaceConfig(input.cwd);
  }
}
