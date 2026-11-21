import { refreshToolProgress } from "./toolRuntime.ts";
import { nativeCompactionThreshold } from "../context/compaction.ts";
import { isModelBlocked } from "./modelPolicy.ts";
import { liveRuntime } from "../eval/liveRuntime.ts";
import { liveClaudeSandbox } from "../eval/liveSandbox.ts";
export { modelFor, codexModelFor } from "./stepAgent.ts";
import { isolationEnforced, prepareAgentSandbox, SANDBOX_HOME } from "./isolation.ts";
import { agentEnvironment, paidClaudeAuth, paidClaudeAuthMessage } from "./environment.ts";
import { advertisedContextTools } from "./contextToolSchemas.ts";
import { normalizeProviderFailure } from "./telemetry.ts";
import { stopFailure, superviseTurn, turnLimits } from "./harness/cliTurn.ts";
import {
  query,
  tool,
  createSdkMcpServer,
  type SDKMessage,
  type SDKUserMessage,
  type HookCallback,
  type CanUseTool,
  type AgentDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { config } from "../config.ts";
import { languagePolicy, outputLocale } from "./language.ts";
import { type AgentProvider } from "./provider.ts";
import { completeForRun } from "./complete.ts";
import { accumulateMetrics, type AgentMetrics } from "./metrics.ts";
import { pool, q, one } from "../db/pool.ts";
import type { ExecutionContext } from "../workflow/executors/registry.ts";
import {
  repositoryBaseBranch,
  type RankedRepository,
  type RepositoryRow,
} from "../repos/service.ts";
import { decide, type PolicyContext, type ToolMode } from "./toolPolicy.ts";
import { dispatchPlatformTool, envFromExecution } from "./platformTools.ts";

// Retain the established imports used by integrations and regression fixtures.
export { accumulateMetrics, newMetrics, type AgentMetrics } from "./metrics.ts";

/** Optional subagents for independent, parallel, read-only work. Never registered unless the step opts in. */
export const SUBAGENTS: Record<string, { description: string; prompt: string }> = {
  explorer: {
    description:
      "Read-only codebase exploration: locate implementations, trace call paths, gather file:line evidence. Use for independent searches that can run in parallel.",
    prompt:
      "You are a read-only exploration subagent of an engineering workflow step. Investigate exactly what you were asked, " +
      "report concise findings with file:line evidence, and state what you could not verify. Never modify files, never run " +
      "commands that change state. Load platform knowledge with mcp__platform__read_knowledge / search_knowledge when useful.",
  },
  reviewer: {
    description:
      "Read-only review of a diff or set of files against conventions, business rules and security policies. Use for an independent second look.",
    prompt:
      "You are a read-only review subagent. Review what you were asked against the conventions and rules available through " +
      "mcp__platform__search_knowledge / read_knowledge. Report findings as severity, file:line, issue, suggestion. Never modify files.",
  },
};

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
export const execP = promisify(execFile);
/** Attempts `a` of step $1 in run $2 started after the last human re-execution (automatic repair rounds only). */
export const SINCE_HUMAN_REEXECUTE = `a.started_at > COALESCE((SELECT max(e.created_at) FROM workflow_events e WHERE e.run_id = $2 AND e.kind = 'status'
              AND (e.content LIKE '%(re-executed by user)%' OR e.content LIKE '%(re-executed with %' OR e.content LIKE '%(re-executed after rejection%')), '-infinity'::timestamptz)`;

/** Current state of each worktree (read-only git), so a re-executed coding step continues from it instead of redoing it. */
export async function worktreeState(workspaces: Array<{ repo: string; path: string }>): Promise<string> {
  const out: string[] = [];
  for (const w of workspaces) {
    const baseBranch = await repositoryBaseBranch(w.repo);
    if (!existsSync(w.path)) continue;
    const g = (...a: string[]) =>
      execP("git", ["-C", w.path, ...a], { maxBuffer: 4 * 1024 * 1024 })
        .then((r) => r.stdout.trim())
        .catch((e) => `(git ${a[0]} failed: ${String(e.message).split("\n")[0]})`);
    const [status, log, stat] = await Promise.all([
      g("status", "--porcelain"),
      g("log", "--oneline", "-n", "15", `origin/${baseBranch}..HEAD`),
      g("diff", "--stat", `origin/${baseBranch}...HEAD`),
    ]);
    out.push(
      `### ${w.repo} (${w.path})`,
      `commits ahead of ${baseBranch}:\n${log || "(none)"}`,
      `uncommitted:\n${status || "(clean)"}`,
      `diff stat vs ${baseBranch}:\n${stat.split("\n").slice(-25).join("\n") || "(none)"}`,
    );
  }
  return out.join("\n");
}

/**
 * One-shot timer that stops a Claude session which outlives its submitted result. `arm()` starts it once (later calls
 * are no-ops, so a background wake-up does not extend the deadline); `fired` tells the caller the abort was ours.
 */
export function postSubmitReaper(stop: () => void, graceMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const state = {
    armed: false,
    fired: false,
    arm() {
      if (state.armed) return;
      state.armed = true;
      timer = setTimeout(() => {
        state.fired = true;
        stop();
      }, graceMs);
      timer.unref?.();
    },
    disarm() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
  return state;
}

function summarize(input: unknown) {
  const s = JSON.stringify(input);
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}

const MAX_RESULT_CHARS = 30_000;
const cap = (t: string) =>
  t.length > MAX_RESULT_CHARS
    ? t.slice(0, MAX_RESULT_CHARS) + `\n… (${t.length - MAX_RESULT_CHARS} more chars)`
    : t;

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c: { type?: unknown; text?: unknown } | null | undefined) =>
        c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : JSON.stringify(c),
      )
      .join("\n");
  return JSON.stringify(content ?? "");
}

/**
 * Persist the conversation as it streams: every assistant block (text, thinking, tool call with full input), every
 * tool result, and the turn summary (cost, turns, duration). Subagent traffic is tagged with parent_tool_use_id.
 */
async function recordTranscript(ctx: ExecutionContext, msg: SDKMessage, cwd: string) {
  const parent = ("parent_tool_use_id" in msg ? msg.parent_tool_use_id : null) ?? null;
  if (msg.type === "system" && msg.subtype === "init") {
    await ctx.recordSession(msg.session_id, cwd, msg.model ?? config.model);
    await ctx.log(
      "system",
      `Claude session ${msg.session_id} started (model ${msg.model ?? "default"})`,
      { session_id: msg.session_id, model: msg.model, tools: msg.tools },
    );
  } else if (msg.type === "assistant") {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "text" && block.text.trim())
        await ctx.log("agent", block.text, { parent });
      else if (block.type === "thinking" && block.thinking?.trim())
        await ctx.log("thinking", block.thinking, { parent });
      else if (block.type === "tool_use")
        await ctx.log("tool", `${block.name} ${summarize(block.input)}`, {
          id: block.id,
          name: block.name,
          input: block.input,
          parent,
        });
    }
  } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result")
        await ctx.log("tool_result", cap(toolResultText(block.content)), {
          tool_use_id: block.tool_use_id,
          is_error: !!block.is_error,
          parent,
        });
    }
  } else if (msg.type === "result") {
    await ctx.log(
      "result",
      msg.subtype === "success" ? String(msg.result ?? "") : `stopped: ${msg.subtype}`,
      {
        subtype: msg.subtype,
        is_error: msg.is_error,
        num_turns: msg.num_turns,
        duration_ms: msg.duration_ms,
        total_cost_usd: msg.total_cost_usd,
        usage: msg.usage,
      },
    );
  }
}

/**
 * Platform MCP tools, bound to one attempt (run + step + attempt), so every question, note, branch and
 * result lands on the right execution record.
 */
function platformServer(
  ctx: ExecutionContext,
  mode: ToolMode,
  policy: PolicyContext,
  onSubmit: (o: Record<string, unknown>) => void,
  metrics: AgentMetrics,
) {
  const prose = outputLocale(ctx.run) === "vi" ? "Vietnamese" : "English";
  const env = envFromExecution(ctx, mode, policy, metrics, onSubmit);
  const call = (name: string) => async (args: unknown) =>
    text(await dispatchPlatformTool(name, args, env));
  const tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]> = [
    tool(
      "ask_user",
      "Post questions to the developer on the platform. After calling this, END YOUR TURN; answers come back as the next message.",
      {
        questions: z
          .array(
            z.object({
              question: z.string().describe(`the question, in ${prose}`),
              context: z
                .string()
                .optional()
                .describe("what you found in the code that makes this unclear (file:line)"),
              options: z
                .array(z.string())
                .optional()
                .describe("candidate answers; put your recommendation first"),
            }),
          )
          .min(1),
      },
      call("ask_user"),
    ),
    tool(
      "post_update",
      `Post a short progress note in ${prose} to the platform timeline.`,
      { message: z.string().describe(`progress note in ${prose}`) },
      call("post_update"),
    ),
    tool(
      "submit_result",
      "Submit this step's output (an object matching the step's output contract). Call once, at the end.",
      {
        output: z.record(z.string(), z.any()).describe("the step output object"),
        skills_applied: z
          .array(z.string().max(300))
          .max(100)
          .optional()
          .describe("Registry keys of skills actually applied; omit unused skills"),
      },
      call("submit_result"),
    ),
    tool(
      "read_knowledge",
      "Read the full text of a skill, business rule or reference doc listed in your system prompt (by key).",
      {
        key: z.string(),
        offset: z.number().int().min(0).max(1000000).optional(),
        limit: z.number().int().min(1).max(24000).optional(),
      },
      call("read_knowledge"),
    ),

    tool(
      "read_step_output",
      "Read the FULL output of an earlier step of this run (the prompt may only contain a summary). `attempt` = attempt number for a historical/invalidated output.",
      { step_key: z.string(), attempt: z.number().int().positive().optional() },
      call("read_step_output"),
    ),
    tool(
      "read_artifact",
      "Read a log or report artifact stored for this run. Pass artifact_id from an ancestor step. Returns the command output. Independent review can only read artifacts those ancestor outputs cite.",
      {
        artifact_id: z.number().int().positive(),
        offset: z.number().int().min(0).max(1000000).optional(),
        limit: z.number().int().min(1).max(24000).optional(),
      },
      call("read_artifact"),
    ),
    tool(
      "list_tools",
      "Discover integration tools (Splunk production logs, project QC databases, Kafka, Vault, Argo CD, Hasaki Work, Bitbucket, code intelligence, repository registry, this run's history/changes). Optional query ranks by relevance.",
      { query: z.string().optional() },
      call("list_tools"),
    ),
    tool(
      "describe_tool",
      "Full description and input schema of an integration tool (load before the first call).",
      { name: z.string() },
      call("describe_tool"),
    ),
    tool(
      "call_tool",
      "Call an integration tool by name with arguments matching its schema (see describe_tool).",
      { name: z.string(), arguments: z.record(z.string(), z.any()).optional() },
      call("call_tool"),
    ),
  ];
  tools.push(
    ...advertisedContextTools().map((t) => tool(t.name, t.description, t.input.shape, call(t.logicalName))),
  );
  if (mode === "coding") {
    tools.unshift(
      tool(
        "prepare_branch",
        `Create or reuse the branch "${ctx.run.branch}" for a repo in an isolated git worktree and return its path. Automatically selects the repo after checking current write access; no manual selection update needed. Allowed repos: ${ctx.run.allowed_repositories.join(", ")}`,
        { repo: z.string().describe("repo directory name, e.g. oms-api") },
        call("prepare_branch"),
      ),
    );
  }
  return createSdkMcpServer({ name: "platform", version: "2.0.0", tools });
}

type SnapshotContent = { upstream?: unknown; knowledge?: unknown } | null;

/** Find a Claude session that can be resumed safely for this attempt (same step, same upstream context). */
export async function resumableSession(
  ctx: ExecutionContext,
  cwd: string,
  provider: AgentProvider,
): Promise<{ sessionId: string; fromAttempt?: number } | null> {
  const resume = ctx.input.pending?.resume;
  if (resume?.checkpoint?.execution?.workspace_reconciliation_required &&
      resume.checkpoint.execution.workspace_unavailable) return null;
  const candidates = await q<{
    session_id: string;
    attempt_id: number;
    generation: number;
    snapshot: SnapshotContent;
  }>(
    pool,
    `SELECT s.session_id, s.attempt_id, a.generation, cs.content AS snapshot
       FROM agent_sessions s JOIN workflow_step_attempts a ON a.id = s.attempt_id LEFT JOIN context_snapshots cs ON cs.id = a.context_snapshot_id
      WHERE a.step_id = $1 AND s.resumable AND s.cwd = $2 AND s.provider = $3 AND (a.effective_agent IS NOT DISTINCT FROM $4::jsonb) ORDER BY s.id DESC LIMIT 5`,
    [
      ctx.step.id,
      cwd,
      provider,
      ctx.attempt?.effective_agent ? JSON.stringify(ctx.attempt.effective_agent) : null,
    ],
  );
  if (!candidates.length) return null;
  const current = await one<{ content: SnapshotContent }>(
    pool,
    "SELECT content FROM context_snapshots WHERE id = $1",
    [ctx.context.snapshot_id],
  );
  const sameUpstream = (snap: SnapshotContent) =>
    JSON.stringify(snap?.upstream ?? {}) === JSON.stringify(current?.content?.upstream ?? {});
  // 1. resume after answers: the paused attempt's own session.
  if (resume?.from_attempt_id) {
    const c = candidates.find((x) => x.attempt_id === resume.from_attempt_id && x.generation === ctx.step.generation);
    if (c && sameUpstream(c.snapshot) &&
        JSON.stringify(c.snapshot?.knowledge ?? []) === JSON.stringify(current?.content?.knowledge ?? []))
      return { sessionId: c.session_id, fromAttempt: c.attempt_id };
  }
  // 2. reviewer feedback: continue the step's last session if nothing upstream changed since.
  if (ctx.input.pending?.feedback) {
    const c = candidates.find((x) => sameUpstream(x.snapshot));
    if (c) return { sessionId: c.session_id };
  }
  return null;
}

export async function progressNotes(fromAttempt?: number) {
  if (!fromAttempt) return [];
  const rows = await q<{ data: { note?: unknown } | null }>(
    pool,
    "SELECT data FROM workflow_checkpoints WHERE attempt_id = $1 AND reason = 'progress' ORDER BY id",
    [fromAttempt],
  );
  return rows.map((r) => String(r.data?.note ?? "")).filter(Boolean);
}

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
          ...(nativeCompaction ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(nativeCompaction.percent) } : {}),
        },
        ...(sandbox
          ? {
              spawnClaudeCodeProcess: (o: { command: string; args: string[]; env: Record<string, string | undefined>; signal?: AbortSignal }) =>
                sandbox.spawn(
                  o.command,
                  o.args,
                  {
                    ...Object.fromEntries(
                      Object.entries(o.env).filter(
                        (e): e is [string, string] =>
                          typeof e[1] === "string" && /^(CLAUDE_CODE_[A-Z_]+|CLAUDE_AGENT_SDK_[A-Z_]+|MCP_[A-Z_]+|DEBUG_CLAUDE_AGENT_SDK)$/.test(e[0]),
                      ),
                    ),
                    CLAUDE_CONFIG_DIR: `${SANDBOX_HOME}/.claude`,
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                  },
                  o.signal,
                ),
            }
          : {}),
        ...(process.env.CLAUDE_CODE_EXECUTABLE || config.agent.claudeBin
          ? {
              pathToClaudeCodeExecutable:
                process.env.CLAUDE_CODE_EXECUTABLE || config.agent.claudeBin,
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
        ...(live
          ? { sandbox: liveClaudeSandbox(live.databaseUrl, live.root ?? live.cwd) }
          : {}),
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
              .map(
                (l) => `[+${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${l.slice(0, 300)}`,
              ),
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
      if (
        !initSeen &&
        msg.type === "system" &&
        (msg as { subtype?: string }).subtype === "init"
      ) {
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
      if (msg.type === "system" && msg.subtype === "init" && isModelBlocked(msg.model ?? config.model)) {
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
        await ctx.log("system", `sandbox egress denied ${sandbox.egress.denied.length} connection(s)`, {
          egress_denied: sandbox.egress.denied.slice(0, 20).map((d) => ({ reason: d.reason, target: d.target.replace(/:\d+$/, "") })),
        });
      await sandbox.close();
    }
  }
  if (blocked) return { isError: true, text: blocked, assistantTurns: 0, failure: "POLICY_VIOLATION" };
  if (paidSource)
    return {
      isError: true,
      text: paidClaudeAuthMessage(paidSource),
      assistantTurns: 0,
      failure: "AUTHENTICATION",
    };
  if (watch.reason && watch.reason !== "canceled" && reaper.armed && isSubmitted())
    return result;
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

/** AI-assisted repository ranking: may only reorder/explain repositories from the deterministic candidate list. */
export async function rankRepositoriesWithClaude(
  ctx: ExecutionContext,
  ranked: RankedRepository[],
  repos: RepositoryRow[],
): Promise<RankedRepository[]> {
  const meta = repos.map((r) => ({
    name: r.name,
    description: r.description,
    services: r.services,
    tags: r.tags,
    projects: r.projects,
    dependencies: r.dependencies,
  }));
  const project = ctx.context?.project || ctx.input.work_item?.project || "";
  const prompt = [
    languagePolicy(outputLocale(ctx.run)),
    "",
    "Rank these repositories by how likely they must change for the engineering request. Use ONLY the listed repository names.",
    ...(project
      ? [
          `The request belongs to project "${project}"; repositories of related projects are listed too because those projects integrate with it.`,
        ]
      : []),
    'Consider the whole flow across project boundaries: when the request names a system (e.g. "phía OMS") or the defect sits in a call between systems ' +
      "(duplicate or missing calls, retries, wrong payloads), rank the caller/producer side as well as the callee — the fix is often on the side that initiates the call.",
    'Reply with JSON only: [{"repo": "...", "score": 0-10, "reasons": ["why this repo is relevant"]}]. Each reason is natural language and follows the output language above.',
    "",
    "Repositories:",
    JSON.stringify(meta, null, 2),
    "",
    "Deterministic keyword ranking (for reference):",
    JSON.stringify(ranked.slice(0, 10)),
    "",
    '<untrusted_input source="work_item">',
    `${ctx.input.work_item?.title ?? ctx.run.title}\n${ctx.input.work_item?.description ?? ""}`,
    JSON.stringify(
      Object.fromEntries(Object.entries(ctx.input.upstream).map(([k, u]) => [k, u.output])),
    ).slice(0, 8000),
    "</untrusted_input>",
  ].join("\n");
  const done = await completeForRun(ctx.run, prompt, ctx.signal);
  await ctx.recordMetrics({ ranking: done.metrics }).catch(() => {});
  const out = done.text;
  const json = out.match(/\[[\s\S]*\]/)?.[0];
  if (!json) throw new Error("no JSON in ranking reply");
  const allowed = new Set(repos.map((r) => r.name));
  return (JSON.parse(json) as RankedRepository[])
    .filter((r) => allowed.has(r.repo))
    .map((r) => ({
      repo: r.repo,
      score: Number(r.score) || 0,
      reasons: (r.reasons ?? []).map(String),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Codex model for a step. Never reads step.config.model (a Claude id): step config.codex_model → agent.codex.models
 * [profile|*][role] → agent.codex.model → "" (the worker's Codex account default). Effort: step config
 * codex_reasoning_effort → agent.codex.reasoningEffort → model default.
 */
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
