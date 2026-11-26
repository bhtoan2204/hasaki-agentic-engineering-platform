import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexConfig } from "../../../config.ts";
import { ignoreError } from "../../../ignoreError.ts";
import type { ExecutionContext } from "../../../workflow/executors/registry.ts";
import { startBroker, type Broker } from "../../broker/server.ts";
import {
  adoptRunWorkspaces,
  checkpointMark,
  readSubmitted,
  stopFailure,
  superviseTurn,
  turnLimits,
  type StopReason,
} from "../../harness/cliTurn.ts";
import type { HarnessFailureCode } from "../../harness/failure.ts";
import { addUsage, noteToolUse, type AgentMetrics } from "../../metrics.ts";
import { superviseSpawn, supervisionNote } from "../../process/supervisor.ts";
import type { PolicyContext, ToolMode } from "../../toolPolicy.ts";
import { codexArgs } from "./args.ts";
import { checkModel, codexCapabilities, codexEnv } from "./capabilities.ts";
import { lastLine, redact } from "./complete.ts";
import { codexHookDecision } from "./policy.ts";
import {
  classifyCodexError,
  codexMetricUsage,
  failureMessage,
  JsonlStream,
  type CodexEvent,
  type CodexFailureKind,
  type CodexItem,
} from "./stream.ts";

export {
  codexCapabilities,
  codexEnv,
  checkModel,
  type CodexCapability,
} from "./capabilities.ts";
export { codexEnabledTools, codexArgs, type CodexInvocation } from "./args.ts";
export { codexComplete, redact } from "./complete.ts";

const NO_FALLBACK = "The platform will not fall back to Claude or another provider.";

export interface CodexTurnInput {
  ctx: ExecutionContext;
  mode: ToolMode;
  policy: PolicyContext;
  cwd: string;
  prompt: string;
  metrics: AgentMetrics;
  invocationId?: string;
  onTelemetry?: (error?: unknown) => Promise<void>;
  model?: string;
  effort?: string;
  resumeId?: string;
}

export interface CodexTurnResult {
  isError: boolean;
  text: string;
  assistantTurns: number;
  submitted?: Record<string, unknown>;
  failure?: CodexFailureKind | "policy" | "incomplete" | HarnessFailureCode;
  threadId?: string;
}

export async function codexAgentTurn(input: CodexTurnInput): Promise<CodexTurnResult> {
  const { ctx, metrics } = input;
  const turnMark = await checkpointMark(ctx.attempt.id);
  const cap = await codexCapabilities(false, {
    model: input.model ?? "",
    effort: input.effort ?? "",
  });
  if (!cap.ok)
    return {
      isError: true,
      text: cap.error || "Codex CLI is not usable",
      assistantTurns: 0,
      failure: cap.kind === "model" ? "model" : cap.kind === "auth" ? "auth" : "error",
    };
  if (input.policy.delegation)
    return {
      isError: true,
      text: `Codex runs cannot enforce the platform's read-only subagent policy. Disable delegation on the step, or create the run with Claude. ${NO_FALLBACK}`,
      assistantTurns: 0,
      failure: "policy",
    };
  const modelProblem = cap.models
    ? checkModel(cap.models, input.model ?? "", input.effort ?? "")
    : null;
  if (modelProblem)
    return {
      isError: true,
      text: `${modelProblem} ${NO_FALLBACK}`,
      assistantTurns: 0,
      failure: "model",
    };
  mkdirSync(input.cwd, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "ctp-agent-tmp-"));
  const { dispatchPlatformTool, envFromExecution } = await import("../../platformTools.ts");
  let submitted: Record<string, unknown> | undefined;
  let paused = false;
  let actualModel = "";
  const toolEnv = envFromExecution(ctx, input.mode, input.policy, metrics, (o) => (submitted = o));
  // After ask_user the step waits: no further edits or state-changing commands until the engine resumes with answers.
  const livePolicy = new Proxy(input.policy, {
    get: (t, k) => (k === "mode" && paused ? "analysis" : Reflect.get(t, k)),
  });
  const activity = { touch: () => {} };
  let broker: Broker;
  try {
    broker = await startBroker({
      onActivity: () => activity.touch(),
      policy: livePolicy,
      cwd: input.cwd,
      decideHook: codexHookDecision,
      async dispatch(name, args) {
        const text = await dispatchPlatformTool(name, args, toolEnv);
        if (
          ["ask_user", "request_clarification", "platform.request_clarification"].includes(name) &&
          !text.startsWith("ERROR")
        )
          paused = true;
        return text;
      },
      onModel(m) {
        if (m !== actualModel) {
          actualModel = m;
          metrics.model = m;
          void ctx.log("system", `Codex model in use: ${m}`, { provider: "codex", model: m });
        }
      },
      async onDenied(tool, reason) {
        metrics.denied.push({ tool, reason });
        await ctx.log("tool", `denied ${tool}: ${reason}`, { provider: "codex" });
      },
    });
  } catch (e) {
    rmSync(scratch, { recursive: true, force: true });
    return {
      isError: true,
      text: `could not start the platform broker: ${(e as Error).message}`,
      assistantTurns: 0,
      failure: "error",
    };
  }

  const args = codexArgs({
    mode: input.mode,
    cwd: input.cwd,
    scratch,
    workspaces: input.policy.workspaces,
    model: input.model,
    effort: input.effort,
    resumeId: input.resumeId,
  });
  const limits = turnLimits(input.ctx.attempt.effective_agent, codexConfig().timeoutMs);
  // Codex is stopped at once (no grace), as before; its MCP bridge and hook helpers go with it.
  const proc = await superviseSpawn({
    command: cap.bin,
    args,
    cwd: input.cwd,
    env: codexEnv(process.env, {
      PLATFORM_BROKER_SOCKET: broker.socketPath,
      PLATFORM_BROKER_TOKEN: broker.token,
    }),
    class: "agent",
    graceMs: 0,
    timeoutMs: limits.timeoutMs + 60_000,
    runId: ctx.run.id,
    attemptId: ctx.attempt.id,
  });
  const child = proc.child;
  let stopReason: "" | StopReason | "policy" = "";
  let violation = "";
  const stop = (why: StopReason | "policy") => {
    if (!stopReason) stopReason = why;
    proc.stop();
  };
  const watch = superviseTurn({ signal: ctx.signal, ...limits, stop });
  activity.touch = () => watch.touch();
  child.stdin?.on("error", () => {});
  child.stdin?.end(input.prompt);

  const parser = new JsonlStream();
  let stderr = "";
  let threadId = "";
  let assistantTurns = 0;
  let lastText = "";
  let completed = false;
  let failedMsg = "";
  const errors: string[] = [];
  const started = Date.now();

  const seenItems = new Set<string>();
  const onItem = async (type: string, item: CodexItem) => {
    const eventKey = `${type}:${item.id}`;
    if (item.id && seenItems.has(eventKey)) return;
    if (item.id) seenItems.add(eventKey);
    const toolId = `${input.invocationId ?? ctx.attempt.id}:${item.id}`;
    const toolish =
      item.type === "command_execution" ||
      item.type === "file_change" ||
      item.type === "mcp_tool_call";
    if (toolish && type === "item.started" && broker.hookCalls === 0) {
      violation =
        "Codex started a tool without running the platform's pre-execution hook; the run was stopped";
      metrics.denied.push({ tool: item.type, reason: violation });
      stop("policy");
      return;
    }
    if (type !== "item.completed" && !(type === "item.started" && toolish)) return;
    switch (item.type) {
      case "agent_message":
        if (item.text?.trim()) {
          assistantTurns++;
          lastText = item.text;
          await ctx.log("agent", item.text, { provider: "codex", item_id: item.id });
        }
        break;
      case "reasoning":
        if (item.text?.trim())
          await ctx.log("thinking", item.text, { provider: "codex", item_id: item.id });
        break;
      case "command_execution":
        if (type === "item.started") {
          metrics.tool_calls.shell = (metrics.tool_calls.shell ?? 0) + 1;
          await ctx.log("tool", `shell ${String(item.command ?? "").slice(0, 300)}`, {
            provider: "codex",
            item_id: item.id,
            name: "shell",
            id: toolId,
            input: { command: item.command },
          });
        } else {
          const failed =
            item.status === "failed" ||
            (typeof item.exit_code === "number" && item.exit_code !== 0);
          if (failed) metrics.tool_errors++;
          await ctx.log(
            "tool_result",
            String(item.aggregated_output ?? "").slice(-30_000) ||
              `(exit ${item.exit_code ?? "?"})`,
            {
              provider: "codex",
              item_id: item.id,
              tool_use_id: toolId,
              exit_code: item.exit_code ?? null,
              is_error: failed,
            },
          );
        }
        break;
      case "file_change":
        if (type === "item.started") {
          metrics.tool_calls.apply_patch = (metrics.tool_calls.apply_patch ?? 0) + 1;
          await ctx.log(
            "tool",
            `apply_patch ${(item.changes ?? [])
              .map((c) => `${c.kind} ${c.path}`)
              .join(", ")
              .slice(0, 300)}`,
            {
              provider: "codex",
              item_id: item.id,
              name: "apply_patch",
              id: toolId,
              input: { changes: item.changes },
            },
          );
        } else {
          const failed = item.status === "failed";
          if (failed) metrics.tool_errors++;
          await ctx.log(
            "tool_result",
            failed ? "patch failed" : `${(item.changes ?? []).length} file(s) changed`,
            { provider: "codex", item_id: item.id, tool_use_id: toolId, is_error: failed },
          );
        }
        break;
      case "mcp_tool_call": {
        const name = `mcp__${item.server ?? "?"}__${item.tool ?? "?"}`;
        if (type === "item.started") {
          metrics.tool_calls[name] = (metrics.tool_calls[name] ?? 0) + 1;
          noteToolUse(metrics, name, item.arguments ?? null);
          await ctx.log("tool", `${name} ${JSON.stringify(item.arguments ?? {}).slice(0, 300)}`, {
            provider: "codex",
            item_id: item.id,
            id: toolId,
            name,
            input: item.arguments ?? null,
          });
        } else {
          const failed = item.status === "failed" || !!item.error;
          if (failed) metrics.tool_errors++;
          await ctx.log(
            "tool_result",
            JSON.stringify(item.error ?? item.result ?? "").slice(0, 30_000),
            { provider: "codex", item_id: item.id, tool_use_id: toolId, is_error: failed },
          );
        }
        break;
      }
      case "error":
        if (item.message) errors.push(item.message);
        await ctx.log("system", `Codex: ${item.message ?? "error"}`, {
          provider: "codex",
          item_id: item.id,
        });
        break;
      case "todo_list":
      case "web_search":
        await ctx.log("system", `Codex ${item.type}`, { provider: "codex", item: item.raw });
        break;
      default:
        await ctx.log("system", `Codex item ${item.type} (not interpreted)`, {
          provider: "codex",
          item: item.raw,
        });
    }
  };

  const handle = async (ev: CodexEvent) => {
    switch (ev.type) {
      case "thread.started":
        if (threadId === ev.thread_id) break;
        threadId = ev.thread_id;
        metrics.sessions++;
        await ctx.recordSession(ev.thread_id, input.cwd, input.model || "", "codex");
        await ctx.log(
          "system",
          `Codex thread ${ev.thread_id} ${input.resumeId ? "resumed" : "started"}${input.model ? ` (model ${input.model})` : " (Codex account default model)"}`,
          {
            provider: "codex",
            session_id: ev.thread_id,
            model: input.model || null,
            effort: input.effort || null,
          },
        );
        break;
      case "turn.started":
        break;
      case "turn.completed":
        if (completed) break;
        completed = true;
        metrics.turns++;
        if (ev.usage) {
          addUsage(metrics, codexMetricUsage(ev.usage));
        }
        await input.onTelemetry?.();
        break;
      case "turn.failed":
        failedMsg = ev.message;
        await input.onTelemetry?.(ev.raw);
        await ctx.log("system", `Codex turn failed: ${ev.message}`, { provider: "codex" });
        break;
      case "error":
        errors.push(ev.message);
        await input.onTelemetry?.(ev.raw);
        await ctx.log("system", `Codex error: ${ev.message}`, { provider: "codex" });
        break;
      case "unknown":
        await ctx.log("system", `Codex event ${ev.name} (not interpreted)`, {
          provider: "codex",
          event: ev.raw,
        });
        break;
      default:
        await onItem(ev.type, ev.item);
    }
  };

  let pending = Promise.resolve();
  const consume = (chunk: Buffer) => {
    watch.touch();
    const { events, errors: bad } = parser.push(chunk);
    pending = pending.then(async () => {
      for (const b of bad)
        await ctx.log("system", `Codex stream: malformed line (${b.error})`, {
          provider: "codex",
          line: b.line,
        });
      for (const ev of events) await handle(ev);
    });
  };
  const exitCode = await new Promise<number | null>((resolve) => {
    child.stdout?.on("data", consume);
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    child.on("error", (e) => {
      stderr += e.message;
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
  watch.dispose();
  const supervision = await proc.done; // helpers (MCP bridge, hooks) that outlived Codex are gone too
  const supervisionLine = supervisionNote(supervision);
  if (supervisionLine) await ctx.log("system", supervisionLine, { provider: "codex", supervision });
  const tail = parser.flush();
  await pending;
  for (const b of tail.errors)
    await ctx.log("system", `Codex stream: malformed line (${b.error})`, {
      provider: "codex",
      line: b.line,
    });
  for (const ev of tail.events) await handle(ev);
  await broker.close().catch(ignoreError("codex.broker_close"));
  rmSync(scratch, { recursive: true, force: true });

  metrics.duration_ms += Date.now() - started;
  metrics.cost_usd = null; // ChatGPT plan usage has no per-call price; never invent one
  if (actualModel) metrics.model = actualModel;
  await adoptRunWorkspaces(ctx.run.id, input.policy);
  if (stderr.trim())
    await ctx.log("log", redact(stderr.trim()).slice(-4000), {
      provider: "codex",
      stream: "stderr",
    });

  submitted = submitted ?? (await readSubmitted(ctx.attempt.id, turnMark));
  const base = { assistantTurns, submitted, threadId: threadId || undefined };

  const stopped = stopReason as string;
  if (stopped === "canceled" || ctx.signal.aborted)
    return { ...base, isError: true, ...stopFailure("canceled", "Codex", limits) };
  if (stopped === "timeout" || stopped === "idle")
    return { ...base, isError: true, ...stopFailure(stopped, "Codex", limits) };
  if (violation)
    return {
      ...base,
      isError: true,
      assistantTurns: Math.max(assistantTurns, 1),
      text: `Codex blocked by platform policy: ${violation}`,
      failure: "UNSAFE_SIDE_EFFECT",
    };
  const detail = failedMsg || errors.at(-1) || "";
  if (failedMsg || (!completed && (errors.length || exitCode !== 0))) {
    const kind = classifyCodexError(`${detail}\n${stderr}`);
    return {
      ...base,
      isError: true,
      text: failureMessage(
        kind,
        detail || lastLine(stderr) || `Codex exited ${exitCode ?? "unknown"}`,
      ),
      failure: kind,
    };
  }
  if (!completed)
    return {
      ...base,
      isError: true,
      text: `Codex exited ${exitCode ?? "unknown"} without completing the turn${stderr.trim() ? `: ${lastLine(stderr)}` : ""}`,
      failure: "incomplete",
    };
  if (exitCode !== 0) {
    const kind = classifyCodexError(`${detail}\n${stderr}`);
    return {
      ...base,
      isError: true,
      text: failureMessage(kind, detail || lastLine(stderr) || `Codex exited ${exitCode}`),
      failure: kind,
    };
  }
  return { ...base, isError: false, text: lastText };
}

/** What differs for a Codex agent compared with the shared step instructions. */
export function codexEnvironmentNotes(mode: ToolMode): string {
  return [
    "## Execution environment (OpenAI Codex on the platform worker)",
    "- The platform tools are on the MCP server named `platform` (ask_user, post_update, submit_result, read_knowledge, search_knowledge, read_step_output, list_tools, describe_tool, call_tool" +
      (mode === "coding" ? ", prepare_branch, commit_changes" : "") +
      "). Where these instructions say mcp__platform__<tool>, call that tool on the `platform` server.",
    "- Every command and file edit is checked by the platform before it runs; a denied call returns the reason. Do not retry a denied call in another form.",
    mode === "coding"
      ? "- You can write only inside the worktrees returned by prepare_branch. `.git` is read-only in your sandbox: do NOT run git add/commit; commit with the platform tool commit_changes (repo, message). The network is disabled. Node dependencies are installed by the worker before this turn. Do not run npm ci, npm install, or npm --offline: that deletes node_modules and then fails with ENOTCACHED because the sandbox cannot reach the registry."
      : "- This step is read-only: no file edits, no state-changing commands.",
    "- After ask_user, end your turn immediately: do not edit files or call other tools while the developer has not answered.",
    "- Finish by calling submit_result with the step's output object. A final chat message alone does not complete the step.",
  ].join("\n");
}
