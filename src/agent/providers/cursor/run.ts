import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../../config.ts";
import { one, pool } from "../../../db/pool.ts";
import { liveRuntime, observeLiveUsage } from "../../../eval/liveRuntime.ts";
import { workspacesOf } from "../../../git/provider.ts";
import type { ExecutionContext } from "../../../workflow/executors/registry.ts";
import { startBroker } from "../../broker/server.ts";
import {
  adoptRunWorkspaces,
  checkpointMark,
  readSubmitted,
  stopFailure,
  superviseTurn,
  turnLimits,
} from "../../harness/cliTurn.ts";
import type { HarnessFailureCode } from "../../harness/failure.ts";
import { bridgeCapabilityEnv } from "../../mcpBridge.ts";
import { newMetrics, type AgentMetrics } from "../../metrics.ts";
import { isModelBlocked } from "../../modelPolicy.ts";
import { dispatchPlatformTool, envFromExecution } from "../../platformTools.ts";
import { superviseSpawn, supervisionNote } from "../../process/supervisor.ts";
import { normalizeProviderFailure } from "../../telemetry.ts";
import type { PolicyContext, ToolMode } from "../../toolPolicy.ts";
import { cursorCapabilities, cursorEnv } from "./capabilities.ts";
import {
  excludeFromGit,
  removeEmptyCursorDir,
  writeCursorPolicy,
  writeMcpConfig,
} from "./permissions.ts";
import { cursorToolDecision, writeOutsideWorktrees } from "./policyWatch.ts";
import {
  cursorUsage,
  isDuplicateAssistant,
  NdjsonStream,
  TextCoalescer,
  toolCallShape,
  type CursorEvent,
} from "./stream.ts";

export {
  cursorBinary,
  cursorCapabilities,
  cursorEnv,
  type CursorCapability,
} from "./capabilities.ts";
export { cursorComplete } from "./complete.ts";

const scrubEnv = cursorEnv;

export interface CursorTurnResult {
  isError: boolean;
  text: string;
  assistantTurns: number;
  submitted?: Record<string, unknown>;
  failure?: HarnessFailureCode;
}

export interface CursorTurnInput {
  model?: string;
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
  const turnMark = await checkpointMark(input.ctx.attempt.id);
  const usageBase = { ...input.metrics?.tokens };
  const usageCostBase = input.metrics?.cost_usd ?? 0;
  const cap = await cursorCapabilities();
  if (!cap.ok)
    return { isError: true, text: cap.error || "Cursor CLI is not usable", assistantTurns: 0 };
  if (input.policy.delegation)
    return {
      isError: true,
      text: "This Cursor CLI cannot enforce the platform's read-only subagent policy. Disable delegation on the step, or create the run with Claude. The platform will not fall back to Claude.",
      assistantTurns: 0,
    };
  mkdirSync(input.cwd, { recursive: true });
  const toolEnv = envFromExecution(
    input.ctx,
    input.mode,
    input.policy,
    input.metrics ?? newMetrics(""),
    () => {},
  );
  const activity = { touch: () => {} };
  const broker = await startBroker({
    onActivity: () => activity.touch(),
    policy: input.policy,
    cwd: input.cwd,
    requireHooks: false,
    decideHook: () => ({ allow: false, reason: "Cursor has no platform hook path" }),
    dispatch: (name, args) => dispatchPlatformTool(name, args, toolEnv),
  });
  try {
    const promptFile = join(input.cwd, ".cursor", "task-prompt.txt");
    mkdirSync(join(input.cwd, ".cursor"), { recursive: true });
    writeFileSync(promptFile, input.prompt);
    writeCursorPolicy(input.cwd, {
      reposRoot: config.reposRoot,
      protectedRoots: input.policy.protectedRoots,
      workspaces: [...input.policy.workspaces],
    });
    // The file only references the broker credentials: Cursor resolves ${env:NAME} from its own process environment.
    writeMcpConfig(input.cwd, process.execPath, [join(import.meta.dirname, "bridge.ts")], {
      PLATFORM_BROKER_SOCKET: "${env:PLATFORM_BROKER_SOCKET}",
      PLATFORM_BROKER_TOKEN: "${env:PLATFORM_BROKER_TOKEN}",
      PLATFORM_MODE: input.mode,
      ...bridgeCapabilityEnv(),
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
      input.mode === "analysis" || liveRuntime.getStore() ? "enabled" : "disabled",
    ];
    if (input.mode === "analysis") args.push("--mode", "ask");
    else args.push("--force");
    if (input.model) {
      if (!cap.supportsModel) throw new Error("This Cursor CLI does not support --model");
      args.push("--model", input.model);
    }
    if (input.resumeId) args.push("--resume", input.resumeId);
    for (const dir of extraDirs(input)) args.push("--add-dir", dir);
    args.push(
      `Follow the task in ${promptFile}. Do not print or copy .cursor/mcp.json. Use the platform MCP tools for questions, progress, knowledge, and submit_result.`,
    );

    const limits = turnLimits(
      input.ctx.attempt.effective_agent,
      config.agent.cursorTimeoutMs ?? 45 * 60_000,
    );
    // Cursor is stopped at once (no grace), as before.
    const proc = await superviseSpawn({
      command: cap.bin,
      args,
      cwd: input.cwd,
      env: {
        ...scrubEnv(process.env),
        PLATFORM_BROKER_SOCKET: broker.socketPath,
        PLATFORM_BROKER_TOKEN: broker.token,
      },
      stdin: "ignore",
      class: "agent",
      graceMs: 0,
      timeoutMs: limits.timeoutMs + 60_000,
      runId: input.ctx.run.id,
      attemptId: input.ctx.attempt.id,
    });
    const child = proc.child;
    const kill = () => proc.stop();
    const watch = superviseTurn({ signal: input.ctx.signal, ...limits, stop: kill });
    activity.touch = () => watch.touch();

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
    let blockedModel = "";
    const toolCalls: Record<string, number> = {};
    let toolErrors = 0;
    const denied: Array<{ tool: string; reason: string }> = [];

    const seenTools = new Set<string>();
    // One transcript line per message, not per streamed token; the step's final text is the whole message.
    const coalescer = new TextCoalescer(async (kind, message) => {
      if (kind === "thinking") return input.ctx.log("thinking", message, { provider: "cursor" });
      assistantTurns++;
      text = message;
      await input.ctx.log("agent", message, { provider: "cursor" });
    });
    const handle = async (ev: CursorEvent) => {
      if (ev.type === "assistant" && !isDuplicateAssistant(ev, true)) {
        if (ev.text) await coalescer.push("agent", ev.text);
        return;
      }
      if (ev.type === "thinking" && ev.text && ev.subtype !== "completed") {
        await coalescer.push("thinking", ev.text);
        return;
      }
      // Any other event (tool call, result, init, the CLI's duplicate full-message flush) ends the open message.
      await coalescer.flush();
      const eventKey = `${ev.subtype}:${ev.call_id}`;
      if (ev.type === "tool_call" && ev.call_id) {
        if (seenTools.has(eventKey)) return;
        seenTools.add(eventKey);
      }
      const toolId = ev.call_id
        ? `${input.invocationId ?? input.ctx.attempt.id}:${ev.call_id}`
        : undefined;
      const usage = cursorUsage(ev.raw);
      if (input.metrics && usage) {
        input.metrics.tokens ??= {
          input: null,
          output: null,
          cache_read: null,
          cache_creation: null,
        };
        for (const [field, value] of Object.entries(usage.tokens)) {
          if (value != null) {
            const key = field as keyof NonNullable<AgentMetrics["tokens"]>;
            input.metrics.tokens[key] = Math.max(
              input.metrics.tokens[key] ?? 0,
              (usageBase[key] ?? 0) + value,
            );
          }
        }
        if (usage.cost != null)
          input.metrics.cost_usd = Math.max(
            input.metrics.cost_usd ?? 0,
            usageCostBase + usage.cost,
          );
        observeLiveUsage(input.metrics);
      }
      if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
        sessionId = ev.session_id;
        model = ev.model || "";
        if (isModelBlocked(model)) {
          blockedModel = `Cursor started with model "${model}", which is blocked by platform policy (agent.blockedModels); the run was stopped.`;
          kill();
          return;
        }
        if (input.metrics && model) input.metrics.model = model;
        await input.onTelemetry?.();
        await input.ctx.recordSession(ev.session_id, input.cwd, model, "cursor");
        await input.ctx.log(
          "system",
          `Cursor session ${ev.session_id} started${model ? ` (model ${model})` : ""}`,
          { provider: "cursor", session_id: ev.session_id, model: model || null },
        );
      } else if (ev.type === "tool_call" && ev.subtype === "started") {
        const pending = await one<{ n: number }>(
          pool,
          "SELECT count(*)::int AS n FROM workflow_questions WHERE attempt_id=$1 AND status='open'",
          [input.ctx.attempt.id],
        );
        if (pending?.n) {
          violation =
            "This attempt is waiting for clarification; stop native tools until it resumes";
          kill();
          return;
        }
        const shape = toolCallShape(ev.tool_call);
        const name = shape?.name ?? "tool";
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
        await input.ctx.log("tool", `${name}`, {
          provider: "cursor",
          call_id: ev.call_id,
          id: toolId,
          name,
          tool_call: ev.tool_call,
        });
        const ws = (await workspacesOf(input.ctx.run.id)).map((w) => w.path);
        const policy = {
          ...input.policy,
          workspaces: [...new Set([...input.policy.workspaces, ...ws])],
        };
        const decision = cursorToolDecision(ev.tool_call, policy, input.cwd);
        const body = shape?.body as { args?: { path?: unknown; file_path?: unknown } } | undefined;
        const path = String(body?.args?.path ?? body?.args?.file_path ?? "");
        const outside =
          (shape?.name === "write" || shape?.name === "edit") &&
          path &&
          writeOutsideWorktrees(path, policy.workspaces);
        if (!decision.allow || outside) {
          const reason = !decision.allow
            ? decision.reason
            : `write ${path} is outside the run's worktrees`;
          violation = reason;
          denied.push({ tool: shape?.name ?? "tool", reason });
          await input.ctx.log("tool", `denied ${shape?.name ?? "tool"}: ${reason}`, {
            provider: "cursor",
          });
          kill();
        }
      } else if (ev.type === "tool_call" && ev.subtype === "completed") {
        const failed = JSON.stringify(ev.tool_call ?? {}).includes('"error"');
        if (failed) toolErrors++;
        await input.ctx.log("tool_result", JSON.stringify(ev.tool_call ?? {}).slice(0, 4000), {
          provider: "cursor",
          call_id: ev.call_id,
          tool_use_id: toolId,
          is_error: failed,
        });
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
      for (const err of errors)
        await input.ctx.log("system", `Cursor stream: malformed line (${err.error})`, {
          provider: "cursor",
          line: err.line,
        });
      for (const ev of events) await handle(ev);
    };

    let pending = Promise.resolve();
    const exitCode = await new Promise<number | null>((resolve) => {
      child.stdout?.on("data", (b: Buffer) => {
        watch.touch();
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
        watch.dispose();
        pending.then(() => resolve(code));
      });
    });
    watch.dispose();
    const supervision = await proc.done;
    const supervisionLine = supervisionNote(supervision);
    if (supervisionLine)
      await input.ctx.log("system", supervisionLine, { provider: "cursor", supervision });
    const tail = parser.flush();
    for (const ev of tail.events) await handle(ev);
    for (const err of tail.errors)
      await input.ctx.log("system", `Cursor stream: malformed line (${err.error})`, {
        provider: "cursor",
      });
    await coalescer.flush(); // a message still open when the CLI exited (killed, timed out, no result event)

    rmSync(join(input.cwd, ".cursor", "mcp.json"), { force: true });
    rmSync(promptFile, { force: true });
    rmSync(join(input.cwd, ".cursor", "cli.json"), { force: true });
    removeEmptyCursorDir(input.cwd);

    const submitted = await readSubmitted(input.ctx.attempt.id, turnMark);

    if (input.metrics) {
      input.metrics.model = model || input.metrics.model;
      input.metrics.sessions += sessionId ? 1 : 0;
      input.metrics.duration_ms += duration ?? 0;
      input.metrics.turns += assistantTurns;
      for (const [name, count] of Object.entries(toolCalls))
        input.metrics.tool_calls[name] = (input.metrics.tool_calls[name] ?? 0) + count;
      input.metrics.tool_errors += toolErrors;
      input.metrics.denied.push(...denied);
    }

    if (watch.reason === "canceled" || input.ctx.signal.aborted)
      return { isError: true, ...stopFailure("canceled", "Cursor", limits), assistantTurns };
    if (blockedModel)
      return { isError: true, text: blockedModel, assistantTurns: 0, failure: "POLICY_VIOLATION" };
    if (violation)
      return {
        isError: true,
        text: `Cursor tool blocked by platform policy: ${violation}`,
        assistantTurns: Math.max(assistantTurns, 1),
        failure: "POLICY_VIOLATION",
      };
    if (watch.reason)
      return {
        isError: true,
        ...stopFailure(watch.reason, "Cursor", limits),
        assistantTurns,
        submitted,
      };

    await adoptRunWorkspaces(input.ctx.run.id, input.policy);

    if (stderr.trim())
      await input.ctx.log("log", stderr.trim().slice(0, 4000), {
        provider: "cursor",
        stream: "stderr",
      });

    if (!sawResult) {
      const why =
        exitCode === 0
          ? "Cursor exited 0 without a result event"
          : `Cursor exited ${exitCode ?? "unknown"} without a result event`;
      return {
        isError: true,
        text: `${why}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
        assistantTurns,
        submitted,
        failure: "INCOMPLETE_OUTPUT",
      };
    }
    if (exitCode !== 0 || isError)
      return {
        isError: true,
        text: text || stderr.trim().slice(0, 500) || `Cursor exited ${exitCode}`,
        assistantTurns,
        submitted,
        failure: normalizeProviderFailure(text || stderr),
      };
    return { isError: false, text, assistantTurns, submitted };
  } finally {
    await broker.close();
    rmSync(join(input.cwd, ".cursor", "mcp.json"), { force: true });
    rmSync(join(input.cwd, ".cursor", "task-prompt.txt"), { force: true });
    rmSync(join(input.cwd, ".cursor", "cli.json"), { force: true });
    removeEmptyCursorDir(input.cwd);
  }
}

function extraDirs(input: CursorTurnInput): string[] {
  const dirs = new Set<string>([
    config.reposRoot,
    ...(input.policy.protectedRoots ?? []),
    ...input.policy.workspaces,
  ]);
  dirs.delete(input.cwd);
  return [...dirs].filter((d) => d && existsSync(d));
}
