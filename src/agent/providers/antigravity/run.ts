import { type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityConfig } from "../../../config.ts";
import { pool, q } from "../../../db/pool.ts";
import { liveRuntime, observeLiveUsage } from "../../../eval/liveRuntime.ts";
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
import { bridgeToolsFor } from "../../mcpBridge.ts";
import { newMetrics, type AgentMetrics } from "../../metrics.ts";
import { isModelBlocked } from "../../modelPolicy.ts";
import { dispatchPlatformTool, envFromExecution } from "../../platformTools.ts";
import { superviseSpawn, supervisionNote, type Supervised } from "../../process/supervisor.ts";
import type { PolicyContext, ToolMode } from "../../toolPolicy.ts";
import { buildAntigravityArgs, MAX_RESPONSE_CHARS, writeAntigravityPrompt } from "./args.ts";
import { antigravityCapabilities, antigravityEnv } from "./capabilities.ts";
import {
  antigravityHeadlessSettings,
  antigravityHookDecision,
  excludeFromGit,
  removeAntigravityWorkspaceConfig,
  writeAntigravityWorkspaceConfig,
} from "./policy.ts";
import {
  AntigravityStream,
  TextBatch,
  classifyAntigravityError,
  type AntigravityEvent,
} from "./stream.ts";

export { buildAntigravityArgs } from "./args.ts";
export { antigravityComplete } from "./complete.ts";

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

async function acquireSlot(max: number, signal?: AbortSignal): Promise<() => void> {
  if (activeRuns < max) {
    activeRuns++;
    return () => releaseSlot(max);
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const idx = waitingQueue.indexOf(resolve);
      if (idx >= 0) waitingQueue.splice(idx, 1);
      reject(new Error("aborted while waiting for Antigravity concurrency slot"));
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

export async function antigravityAgentTurn(
  input: AntigravityTurnInput,
): Promise<AntigravityTurnResult> {
  if (input.policy.delegation)
    return {
      isError: true,
      text: "Antigravity runs cannot enforce the platform's read-only subagent policy. Disable delegation on the step, or create the run with Claude. The platform does not fall back to another provider.",
      assistantTurns: 0,
      failure: "POLICY_VIOLATION",
    };
  const turnMark = await checkpointMark(input.ctx.attempt.id);
  const usageBase = { ...input.metrics?.tokens };
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
  const release = await acquireSlot(
    input.ctx.attempt.effective_agent?.options?.max_concurrent ?? cfg.maxConcurrent,
    input.ctx.signal,
  );

  let broker: Broker | null = null;
  const scratchDir = mkdtempSync(join(tmpdir(), "ctp-agy-scratch-"));
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
          "UPDATE agent_sessions SET model=$3 WHERE attempt_id=$1 AND session_id=$2 AND provider='antigravity'",
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
      decideHook: antigravityHookDecision,
      dispatch: async (name, args) => {
        return dispatchPlatformTool(name, args, toolEnv);
      },
      onDenied: async (tool, reason) => {
        metrics.denied.push({ tool, reason });
        await input.ctx.log("tool", `denied ${tool}: ${reason}`);
      },
      onModel: recordModel,
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
      } catch {
        /* ignore: exclude is best-effort */
      }
    }

    const additionalDirs = workspaces.map((w) => w.path).filter((p) => p !== input.cwd);

    const limits = turnLimits(input.ctx.attempt.effective_agent, cfg.timeoutMs);
    const timeoutMs = limits.timeoutMs;
    const timeoutSec = Math.floor(timeoutMs / 1000);

    const settingsPath = join(scratchDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        antigravityHeadlessSettings(
          bridgeToolsFor("coding", { commit: true }).map((tool) => tool.name),
        ),
      ),
    );
    const args = buildAntigravityArgs({
      model: input.model || undefined,
      effort: input.effort || undefined,
      // Write steps always run sandboxed (fail-closed guarantee); preflight refuses sandbox:false for them.
      sandbox:
        liveRuntime.getStore() || input.mode === "coding"
          ? true
          : (input.ctx.attempt.effective_agent?.options?.sandbox ?? cfg.sandbox),
      timeoutSeconds: timeoutSec,
      conversationId: input.resumeId || undefined,
      additionalDirs,
      settingsPath,
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

    // SIGTERM, then SIGKILL after 5 s, as before.
    proc = await superviseSpawn({
      command: cfg.bin,
      args,
      cwd: input.cwd,
      env,
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

    const parser = new AntigravityStream();
    const agentText = new TextBatch();
    const thinkingText = new TextBatch();
    const logPiece = async (kind: "agent" | "thinking", text: string) => {
      if (!text) return;
      await input.ctx.log(kind, text, {
        provider: "antigravity",
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

    const handleEvent = async (ev: AntigravityEvent) => {
      if (ev.model && isModelBlocked(ev.model)) {
        blockedModel ||= `Antigravity runs model "${ev.model}", which is blocked by platform policy (agent.blockedModels); the run was stopped.`;
        proc?.stop();
        return;
      }
      if (ev.model) await recordModel(ev.model);
      if (ev.conversationId && ev.conversationId !== conversationId) {
        conversationId = ev.conversationId;
        await q(
          pool,
          "INSERT INTO agent_sessions (attempt_id, session_id, cwd, model, provider) VALUES ($1, $2, $3, $4, $5)",
          [input.ctx.attempt.id, conversationId, input.cwd, model, "antigravity"],
        ).catch(() => {});
      }

      if (ev.type === "result") {
        sawResult = true;
        assistantTurns = ev.turns ?? 1;
        if (ev.text != null) fullText = ev.text.slice(0, MAX_RESPONSE_CHARS);
        await flushSpeech();
      } else if (ev.text) {
        if (!ev.type.startsWith("step_update.")) assistantTurns++;
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

      if (ev.tool && (broker?.preToolUseCalls ?? 0) === 0 && !violation) {
        violation =
          "Antigravity started a tool without running the platform's pre-execution hook; the run was stopped";
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
          provider: "antigravity",
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

      if (ev.error || ev.status === "ERROR") lastError = ev.error || "Antigravity returned ERROR";
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
            input.ctx.log("system", `Antigravity stream: ${err.error}`, {
              provider: "antigravity",
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
    const writePromise = writeAntigravityPrompt(child, input.prompt, input.ctx.signal).catch(
      (error) => {
        inputError = error as Error;
        if (!watch.reason) proc?.stop();
      },
    );
    const exitCode = await exitPromise;
    watch.dispose();
    await writePromise;
    await pendingLogs;

    watch.dispose();
    const supervision = await proc.done;
    const supervisionLine = supervisionNote(supervision);
    if (supervisionLine)
      await input.ctx.log("system", supervisionLine, { provider: "antigravity", supervision });

    const tail = parser.flush();
    for (const ev of tail.events) await handleEvent(ev);
    await flushSpeech();
    for (const err of tail.errors)
      await input.ctx.log("system", `Antigravity stream: ${err.error}`, {
        provider: "antigravity",
      });

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

    submitted = submitted ?? (await readSubmitted(input.ctx.attempt.id, turnMark));

    const stopped = watch.reason ?? (input.ctx.signal.aborted ? "canceled" : null);
    if (stopped)
      return {
        isError: true,
        ...stopFailure(stopped, "Antigravity", limits),
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
        text: `Unable to start Antigravity: ${spawnError.message}`,
        assistantTurns,
        failure: "AGENT_ERROR",
        submitted,
      };

    if (inputError) {
      const detail =
        inputError.message.includes("EPIPE") || inputError.message.includes("stdin")
          ? `Antigravity exited before the prompt was fully sent (${inputError.message})`
          : inputError.message;
      return {
        isError: true,
        text: detail,
        assistantTurns,
        failure: classifyAntigravityError(detail),
        submitted,
      };
    }

    if (streamError)
      return {
        isError: true,
        text: `Antigravity output handling failed: ${streamError.message}`,
        assistantTurns,
        failure: "AGENT_ERROR",
        submitted,
      };

    if (lastError || exitCode !== 0) {
      const errDetail = lastError || stderr.trim() || `agy exited with code ${exitCode}`;
      const failureCat = classifyAntigravityError(errDetail);
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
          ? "Antigravity's output ended before the CLI reported a result; the partial reply was discarded"
          : "Antigravity exited without a result, a reply or a submitted output",
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
    removeAntigravityWorkspaceConfig(input.cwd);
  }
}
