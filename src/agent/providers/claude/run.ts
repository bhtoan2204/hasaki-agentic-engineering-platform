import {
  query,
  type AgentDefinition,
  type CanUseTool,
  type HookCallback,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { config } from "../../../config.ts";
import { nativeCompactionThreshold } from "../../../context/compaction.ts";
import { one, pool } from "../../../db/pool.ts";
import { liveRuntime } from "../../../eval/liveRuntime.ts";
import { liveClaudeSandbox } from "../../../eval/liveSandbox.ts";
import type { ExecutionContext } from "../../../workflow/executors/registry.ts";
import { agentEnvironment, paidClaudeAuth, paidClaudeAuthMessage } from "../../environment.ts";
import { stopFailure, superviseTurn, turnLimits } from "../../harness/cliTurn.ts";
import { isolationEnforced, prepareAgentSandbox, SANDBOX_HOME } from "../../isolation.ts";
import { accumulateMetrics, type AgentMetrics } from "../../metrics.ts";
import { isModelBlocked } from "../../modelPolicy.ts";
import { postSubmitReaper } from "../../sessions.ts";
import { normalizeProviderFailure } from "../../telemetry.ts";
import { decide, type PolicyContext, type ToolMode } from "../../toolPolicy.ts";
import { refreshToolProgress } from "../../toolRuntime.ts";
import { platformServer, recordTranscript } from "./mcp.ts";

export interface ClaudeTurnInput {
  ctx: ExecutionContext;
  prompt: string;
  resumeId?: string;
  cwd: string;
  mode: ToolMode;
  policy: PolicyContext;
  metrics: AgentMetrics;
  effective: { reasoning_effort?: string | null; max_turns?: number };
  routed: { model: string };
  systemAppend: string;
  settingSources: typeof config.agent.settingSources;
  nativeTools: string[];
  agents: Record<string, AgentDefinition> | undefined;
  live: ReturnType<typeof liveRuntime.getStore>;
  onSubmit: (o: Record<string, unknown>) => void;
  isSubmitted: () => boolean;
  persistSession: (error?: unknown) => Promise<void>;
}

/** One Claude Agent SDK turn: in-process policy hooks and the platform MCP server. */
export async function claudeAgentTurn(turn: ClaudeTurnInput): Promise<{
  isError: boolean;
  text: string;
  assistantTurns: number;
  failure?: string;
}> {
  const {
    ctx,
    prompt,
    resumeId,
    cwd,
    mode,
    policy,
    metrics,
    effective,
    routed,
    systemAppend,
    settingSources,
    nativeTools,
    agents,
    live,
    onSubmit,
    isSubmitted,
    persistSession,
  } = turn;
  // The PreToolUse hook sees the shell's real cwd; canUseTool (called afterwards for the same call) does not.
  // Remember the hook's allow so cwd-dependent checks (relative redirects, `cd`) are not re-judged without a cwd.
  const hookAllowed = new Set<string>();
  const callKey = (name: string, input: unknown) => `${name}\u0000${JSON.stringify(input ?? {})}`;
  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    watch.touch();
    const waiting = await one<{ n: number }>(
      pool,
      "SELECT count(*)::int AS n FROM workflow_questions WHERE attempt_id=$1 AND status='open'",
      [ctx.attempt.id],
    );
    await refreshToolProgress(policy);
    const d = decide(
      input.tool_name,
      (input.tool_input ?? {}) as Record<string, unknown>,
      waiting?.n ? { ...policy, mode: "analysis" } : policy,
      input.cwd,
      input.agent_id,
    );
    if (d.allow) {
      hookAllowed.add(callKey(input.tool_name, input.tool_input));
      if (hookAllowed.size > 200) hookAllowed.delete(hookAllowed.values().next().value!);
      return {};
    }
    metrics.denied.push({
      tool: input.tool_name,
      reason: d.reason,
      ...(input.agent_id ? { subagent: input.agent_type ?? input.agent_id } : {}),
    });
    await ctx.log(
      "tool",
      `denied ${input.tool_name}${input.agent_id ? ` (subagent ${input.agent_type ?? ""})` : ""}: ${d.reason}`,
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: d.reason,
      },
    };
  };
  const subagentStart: HookCallback = async (input) => {
    if (input.hook_event_name !== "SubagentStart") return {};
    metrics.subagents.push({
      type: input.agent_type,
      id: input.agent_id,
      started_at: new Date().toISOString(),
    });
    await ctx.log("system", `subagent ${input.agent_type} started`, {
      subagent: input.agent_type,
      agent_id: input.agent_id,
    });
    return {};
  };
  const subagentStop: HookCallback = async (input) => {
    if (input.hook_event_name !== "SubagentStop") return {};
    const s = metrics.subagents.find((x) => x.id === input.agent_id);
    if (s) s.ended_at = new Date().toISOString();
    await ctx.log("system", `subagent ${input.agent_type} finished`, {
      subagent: input.agent_type,
      agent_id: input.agent_id,
    });
    return {};
  };
  const canUseTool: CanUseTool = async (name, input) => {
    const k = callKey(name, input);
    if (hookAllowed.delete(k)) return { behavior: "allow", updatedInput: input };
    const d = decide(name, input, policy, cwd);
    return d.allow
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: d.reason };
  };

  const ac = new AbortController();
  const limits = turnLimits(ctx.attempt.effective_agent);
  const watch = superviseTurn({ signal: ctx.signal, ...limits, stop: () => ac.abort() });
  let sawResult = false;
  let paidSource: string | null = null;
  let blocked = "";
  // Once the result is submitted and the turn ended, the CLI should exit. A background shell task (e.g. a command
  // that outlived its 120 s timeout) keeps it alive and re-invokes the agent later: stop it after a grace period.
  const graceSeconds = Math.max(0, Number(config.agent.postSubmitGraceSeconds ?? 30));
  const reaper = postSubmitReaper(() => ac.abort(), graceSeconds * 1000);
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
      session_id: "",
    };
  }
  const result: {
    isError: boolean;
    text: string;
    assistantTurns: number;
    failure?: string;
  } = { isError: false, text: "", assistantTurns: 0 };
  // Startup diagnostics: how long until the CLI reports `init`, and what it printed meanwhile (stderr tail).
  const startedAt = Date.now();
  let initSeen = false;
  const stderrTail: string[] = [];
  // Enforced isolation: the whole Claude CLI process tree runs in the OS sandbox; hooks and the platform MCP server
  // keep running here (stdio control protocol), so platform tools still execute with the attempt's lease and fencing.
  const sandbox = (await isolationEnforced())
    ? await prepareAgentSandbox({
        runId: ctx.run.id,
        provider: "claude",
        cwd,
        writable: mode === "coding" ? policy.workspaces : [],
        readOnly: (ctx.context.repoPaths ?? []).map((r) => r.path),
      })
    : null;
  const nativeCompaction = nativeCompactionThreshold("claude", routed.model);
  try {
    for await (const msg of query({
      prompt: input(),
      options: {
        cwd,
        env: {
          ...agentEnvironment(process.env, "claude"),
          // Native compaction mode: Claude Code's own auto-compaction triggers at the platform's pressure threshold.
          ...(nativeCompaction
            ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(nativeCompaction.percent) }
            : {}),
        },
        ...(sandbox
          ? {
              spawnClaudeCodeProcess: (o: {
                command: string;
                args: string[];
                env: Record<string, string | undefined>;
                signal?: AbortSignal;
              }) =>
                sandbox.spawn(
                  o.command,
                  o.args,
                  {
                    ...Object.fromEntries(
                      Object.entries(o.env).filter(
                        (e): e is [string, string] =>
                          typeof e[1] === "string" &&
                          /^(CLAUDE_CODE_[A-Z_]+|CLAUDE_AGENT_SDK_[A-Z_]+|MCP_[A-Z_]+|DEBUG_CLAUDE_AGENT_SDK)$/.test(
                            e[0],
                          ),
                      ),
                    ),
                    CLAUDE_CONFIG_DIR: `${SANDBOX_HOME}/.claude`,
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                  },
                  o.signal,
                ),
            }
          : {}),
        ...(config.agent.claudeBin
          ? {
              pathToClaudeCodeExecutable: config.agent.claudeBin,
            }
          : {}),
        additionalDirectories: [
          config.reposRoot,
          ...(ctx.context.repoPaths ?? []).map((r) => r.path),
        ],
        resume: resumeId,
        ...(effective.reasoning_effort
          ? {
              effort: effective.reasoning_effort as "low" | "medium" | "high" | "xhigh" | "max",
            }
          : {}),
        abortController: ac,
        model: routed.model || undefined,
        maxTurns: effective.max_turns ?? Number(ctx.step.config.max_turns ?? config.maxTurns),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: systemAppend,
        },
        // Skills come from the platform registry (read_knowledge); Claude Code settings layers only if configured.
        settingSources,
        settings: { attribution: { commit: "", pr: "" } },
        mcpServers: {
          platform: platformServer(ctx, mode, policy, onSubmit, metrics),
        },
        tools: nativeTools,
        ...(agents ? { agents } : {}),
        ...(live ? { sandbox: liveClaudeSandbox(live.databaseUrl, live.root ?? live.cwd) } : {}),
        permissionMode: "default",
        canUseTool,
        hooks: {
          PreToolUse: [{ hooks: [preToolUse] }],
          SubagentStart: [{ hooks: [subagentStart] }],
          SubagentStop: [{ hooks: [subagentStop] }],
        },
        disallowedTools: ["AskUserQuestion"],
        stderr: (d: string) => {
          stderrTail.push(
            ...d
              .split("\n")
              .filter(Boolean)
              .map((l) => `[+${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${l.slice(0, 300)}`),
          );
          if (stderrTail.length > 40) stderrTail.splice(0, stderrTail.length - 40);
        },
      },
    })) {
      const paid = paidClaudeAuth(msg);
      if (paid) {
        paidSource = paid;
        break;
      }
      if (!initSeen && msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
        initSeen = true;
        const ms = Date.now() - startedAt;
        if (ms > 10_000)
          await ctx.log(
            "system",
            `Claude CLI took ${(ms / 1000).toFixed(1)}s to start (normally < 1s)`,
            { startup_ms: ms, stderr_tail: stderrTail.slice() },
          );
      }
      watch.touch();
      // The model the session actually runs (an account default included) must not be a blocked one.
      if (
        msg.type === "system" &&
        msg.subtype === "init" &&
        isModelBlocked(msg.model ?? config.model)
      ) {
        blocked = `Claude started with model "${msg.model ?? config.model}", which is blocked by platform policy (agent.blockedModels); the run was stopped. Configure another model.`;
        ac.abort();
        break;
      }
      await recordTranscript(ctx, msg, cwd);
      accumulateMetrics(metrics, msg);
      if (msg.type === "result") await persistSession(msg.is_error ? msg : undefined);
      else if (msg.type === "system" && msg.subtype === "init") await persistSession();
      if (msg.type === "assistant") result.assistantTurns++;
      else if (msg.type === "result") {
        sawResult = true;
        // After the submitted result, later turns are background-task wake-ups ("the find finished..."): they
        // must not replace the step's final answer.
        if (!reaper.armed) {
          result.isError = msg.is_error;
          result.text =
            msg.subtype === "success" ? msg.result : msg.errors?.join("\n") || msg.subtype;
          if (msg.is_error) result.failure = normalizeProviderFailure(msg);
        }
        if (isSubmitted() && !msg.is_error) reaper.arm();
      }
    }
  } catch (error) {
    // Our own post-submit stop is a normal end of the session, not a provider failure.
    if (!reaper.fired && (!watch.reason || watch.reason === "canceled")) throw error;
  } finally {
    reaper.disarm();
    watch.dispose();
    if (sandbox) {
      // Closing the egress proxy revokes the sandbox's only network path; its refusals are the denied-action evidence.
      if (sandbox.egress.denied.length)
        await ctx.log(
          "system",
          `sandbox egress denied ${sandbox.egress.denied.length} connection(s)`,
          {
            egress_denied: sandbox.egress.denied
              .slice(0, 20)
              .map((d) => ({ reason: d.reason, target: d.target.replace(/:\d+$/, "") })),
          },
        );
      await sandbox.close();
    }
  }
  if (blocked)
    return { isError: true, text: blocked, assistantTurns: 0, failure: "POLICY_VIOLATION" };
  if (paidSource)
    return {
      isError: true,
      text: paidClaudeAuthMessage(paidSource),
      assistantTurns: 0,
      failure: "AUTHENTICATION",
    };
  if (watch.reason && watch.reason !== "canceled" && reaper.armed && isSubmitted()) return result;
  if (watch.reason && !reaper.fired)
    return {
      isError: true,
      ...stopFailure(watch.reason, "Claude", limits),
      assistantTurns: result.assistantTurns,
    };
  if (!sawResult && !reaper.fired)
    return {
      isError: true,
      text: "Claude session ended without a result message",
      assistantTurns: result.assistantTurns,
      failure: "INCOMPLETE_OUTPUT",
    };
  if (reaper.fired)
    await ctx.log(
      "system",
      `Claude was still running ${graceSeconds}s after the result was submitted (background shell tasks keep the CLI alive); the platform stopped the session`,
      { post_submit_grace_seconds: graceSeconds },
    );
  return result;
}
