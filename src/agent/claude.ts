import { query, tool, createSdkMcpServer, type SDKUserMessage, type HookCallback, type CanUseTool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { config } from "../config.ts";
import { pool, q, one } from "../db/pool.ts";
import { taskDir } from "../git.ts";
import { prepareWorkspace, workspaceKey, workspacesOf } from "../git/provider.ts";
import type { ExecutionContext, StepExecutor } from "../workflow/executors/registry.ts";
import type { ExecResult } from "../workflow/types.ts";
import type { RankedRepository, RepositoryRow } from "../repos/service.ts";
import { downloadAttachments } from "./attachments.ts";
import { buildResumeMessage, buildSystemAppend, buildUserPrompt } from "./stepPrompt.ts";
import { decide, toolsFor, SUBAGENT_PLATFORM_TOOLS, type PolicyContext, type ToolMode } from "./toolPolicy.ts";
import { scoreKnowledge } from "../context/plan.ts";
import { callTool, capResult, describeTool, integrationTools, listTools } from "./toolRegistry.ts";

/** Per-attempt observability, accumulated across the SDK message stream (and across a resume fallback). */
export interface AgentMetrics {
  model: string;
  sessions: number;
  turns: number;
  duration_ms: number;
  cost_usd: number;
  tokens: { input: number; output: number; cache_read: number; cache_creation: number };
  tool_calls: Record<string, number>;
  tool_errors: number;
  denied: Array<{ tool: string; reason: string; subagent?: string }>;
  skills_loaded: string[];
  knowledge_searches: string[];
  integration_calls: Array<{ name: string; ok: boolean; ms: number; error?: string }>;
  subagents: Array<{ type: string; id: string; started_at: string; ended_at?: string }>;
  disclosure: { inline: number; index: number; search: number };
  upstream: { full: number; summary: number };
}

export function newMetrics(model: string): AgentMetrics {
  return { model, sessions: 0, turns: 0, duration_ms: 0, cost_usd: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, tool_calls: {}, tool_errors: 0, denied: [], skills_loaded: [], knowledge_searches: [], integration_calls: [], subagents: [], disclosure: { inline: 0, index: 0, search: 0 }, upstream: { full: 0, summary: 0 } };
}

/** Fold one SDK message into the metrics (pure; unit-tested). */
export function accumulateMetrics(m: AgentMetrics, msg: any) {
  if (msg.type === "system" && msg.subtype === "init") m.sessions++;
  else if (msg.type === "assistant") {
    for (const b of msg.message?.content ?? []) if (b.type === "tool_use") m.tool_calls[b.name] = (m.tool_calls[b.name] ?? 0) + 1;
  } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) if (b.type === "tool_result" && b.is_error) m.tool_errors++;
  } else if (msg.type === "result") {
    m.turns += msg.num_turns ?? 0;
    m.duration_ms += msg.duration_ms ?? 0;
    m.cost_usd = Math.round((m.cost_usd + (msg.total_cost_usd ?? 0)) * 1e6) / 1e6;
    const u = msg.usage ?? {};
    m.tokens.input += u.input_tokens ?? 0;
    m.tokens.output += u.output_tokens ?? 0;
    m.tokens.cache_read += u.cache_read_input_tokens ?? 0;
    m.tokens.cache_creation += u.cache_creation_input_tokens ?? 0;
  }
}

/** Optional subagents for independent, parallel, read-only work. Never registered unless the step opts in. */
const SUBAGENTS: Record<string, { description: string; prompt: string }> = {
  explorer: {
    description: "Read-only codebase exploration: locate implementations, trace call paths, gather file:line evidence. Use for independent searches that can run in parallel.",
    prompt:
      "You are a read-only exploration subagent of an engineering workflow step. Investigate exactly what you were asked, " +
      "report concise findings with file:line evidence, and state what you could not verify. Never modify files, never run " +
      "commands that change state. Load platform knowledge with mcp__platform__read_knowledge / search_knowledge when useful.",
  },
  reviewer: {
    description: "Read-only review of a diff or set of files against conventions, business rules and security policies. Use for an independent second look.",
    prompt:
      "You are a read-only review subagent. Review what you were asked against the conventions and rules available through " +
      "mcp__platform__search_knowledge / read_knowledge. Report findings as severity, file:line, issue, suggestion. Never modify files.",
  },
};

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const execP = promisify(execFile);

/** Current state of each worktree (read-only git), so a re-executed coding step continues from it instead of redoing it. */
async function worktreeState(workspaces: Array<{ repo: string; path: string }>): Promise<string> {
  const out: string[] = [];
  for (const w of workspaces) {
    if (!existsSync(w.path)) continue;
    const g = (...a: string[]) => execP("git", ["-C", w.path, ...a], { maxBuffer: 4 * 1024 * 1024 }).then((r) => r.stdout.trim()).catch((e) => `(git ${a[0]} failed: ${String(e.message).split("\n")[0]})`);
    const [status, log, stat] = await Promise.all([g("status", "--porcelain"), g("log", "--oneline", "-n", "15", `origin/${config.baseBranch}..HEAD`), g("diff", "--stat", `origin/${config.baseBranch}...HEAD`)]);
    out.push(`### ${w.repo} (${w.path})`, `commits ahead of ${config.baseBranch}:\n${log || "(none)"}`, `uncommitted:\n${status || "(clean)"}`, `diff stat vs ${config.baseBranch}:\n${stat.split("\n").slice(-25).join("\n") || "(none)"}`);
  }
  return out.join("\n");
}

function summarize(input: unknown) {
  const s = JSON.stringify(input);
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}

const MAX_RESULT_CHARS = 30_000;
const cap = (t: string) => (t.length > MAX_RESULT_CHARS ? t.slice(0, MAX_RESULT_CHARS) + `\n… (${t.length - MAX_RESULT_CHARS} more chars)` : t);

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : JSON.stringify(c))).join("\n");
  return JSON.stringify(content ?? "");
}

/**
 * Persist the conversation as it streams: every assistant block (text, thinking, tool call with full input), every
 * tool result, and the turn summary (cost, turns, duration). Subagent traffic is tagged with parent_tool_use_id.
 */
async function recordTranscript(ctx: ExecutionContext, msg: any, cwd: string) {
  const parent = msg.parent_tool_use_id ?? null;
  if (msg.type === "system" && msg.subtype === "init") {
    await ctx.recordSession(msg.session_id, cwd, msg.model ?? config.model);
    await ctx.log("system", `Claude session ${msg.session_id} started (model ${msg.model ?? "default"})`, { session_id: msg.session_id, model: msg.model, tools: msg.tools });
  } else if (msg.type === "assistant") {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "text" && block.text.trim()) await ctx.log("agent", block.text, { parent });
      else if (block.type === "thinking" && block.thinking?.trim()) await ctx.log("thinking", block.thinking, { parent });
      else if (block.type === "tool_use")
        await ctx.log("tool", `${block.name} ${summarize(block.input)}`, { id: block.id, name: block.name, input: block.input, parent });
    }
  } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result")
        await ctx.log("tool_result", cap(toolResultText(block.content)), { tool_use_id: block.tool_use_id, is_error: !!block.is_error, parent });
    }
  } else if (msg.type === "result") {
    await ctx.log("result", msg.subtype === "success" ? String(msg.result ?? "") : `stopped: ${msg.subtype}`, {
      subtype: msg.subtype,
      is_error: msg.is_error,
      num_turns: msg.num_turns,
      duration_ms: msg.duration_ms,
      total_cost_usd: msg.total_cost_usd,
      usage: msg.usage,
    });
  }
}

/**
 * Platform MCP tools, bound to one attempt (run + step + attempt), so every question, note, branch and
 * result lands on the right execution record.
 */
function platformServer(ctx: ExecutionContext, mode: ToolMode, policy: PolicyContext, onSubmit: (o: Record<string, unknown>) => void, metrics: AgentMetrics) {
  const editable = ctx.run.selected_repositories.length ? ctx.run.selected_repositories : ctx.run.allowed_repositories;
  const tools: SdkMcpToolDefinition<any>[] = [
    tool(
      "ask_user",
      "Post questions to the developer on the platform. After calling this, END YOUR TURN; answers come back as the next message.",
      {
        questions: z
          .array(
            z.object({
              question: z.string().describe("the question, in Vietnamese"),
              context: z.string().optional().describe("what you found in the code that makes this unclear (file:line)"),
              options: z.array(z.string()).optional().describe("candidate answers; put your recommendation first"),
            }),
          )
          .min(1),
      },
      async (args) => {
        const n = await ctx.ask(args.questions);
        await ctx.log("system", `${n} question(s) posted`);
        return text("Questions posted. Stop now and end your turn without further tool calls.");
      },
    ),
    tool("post_update", "Post a short progress note (Vietnamese) to the platform timeline.", { message: z.string() }, async ({ message }) => {
      await ctx.log("agent", message);
      await q(pool, "INSERT INTO workflow_checkpoints (run_id, step_id, attempt_id, reason, data) VALUES ($1, $2, $3, 'progress', $4)", [
        ctx.run.id,
        ctx.step.id,
        ctx.attempt.id,
        JSON.stringify({ note: message }),
      ]);
      return text("ok");
    }),
    tool(
      "submit_result",
      "Submit this step's output (an object matching the step's output contract). Call once, at the end.",
      { output: z.record(z.string(), z.any()).describe("the step output object") },
      async ({ output }) => {
        onSubmit(output);
        return text("Result recorded. End your turn now.");
      },
    ),
    tool(
      "read_knowledge",
      "Read the full text of a skill, business rule or reference doc listed in your system prompt (by key).",
      { key: z.string() },
      async ({ key }) => {
        const k = ctx.context.knowledge.find((x) => x.key === key);
        if (!k) return text(`"${key}" is not available to this step. Use search_knowledge to find applicable items.`);
        await ctx.log("system", `loaded knowledge ${key} v${k.version}`, { knowledge: key, version: k.version });
        if (!metrics.skills_loaded.includes(key)) metrics.skills_loaded.push(key);
        return text(`# ${k.title} (${k.key} v${k.version})\n\n${k.content}`);
      },
    ),
    tool(
      "search_knowledge",
      "Search the skills, business rules and reference docs that apply to this step (including ones not listed in the prompt). Returns keys to load with read_knowledge.",
      { query: z.string().min(2), limit: z.number().int().min(1).max(20).optional() },
      async ({ query, limit }) => {
        metrics.knowledge_searches.push(query);
        const tier = new Map(ctx.context.disclosure.map((d) => [d.key, d.disclosure]));
        const hits = ctx.context.knowledge
          .map((k) => ({ k, ...scoreKnowledge(k as any, query, ctx.step.type) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit ?? 8)
          .map((x) => ({ key: x.k.key, title: x.k.title, category: x.k.category, description: String((x.k.metadata as any)?.description ?? "").slice(0, 300), score: x.score, already_in_prompt: tier.get(x.k.key) === "inline" }));
        await ctx.log("system", `search_knowledge "${query}" → ${hits.map((h) => h.key).join(", ") || "no match"}`, { query, hits: hits.map((h) => h.key) });
        return text(hits.length ? JSON.stringify(hits, null, 2) : "No applicable knowledge matches. Try other words.");
      },
    ),
    tool(
      "read_step_output",
      "Read the FULL output of an earlier step of this run (the prompt may only contain a summary). `attempt` = attempt number for a historical/invalidated output.",
      { step_key: z.string(), attempt: z.number().int().positive().optional() },
      async ({ step_key, attempt }) => {
        if (attempt) {
          const row = await one(pool, "SELECT a.number, a.generation, a.status, a.output, a.invalidated_at FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE a.run_id = $1 AND s.key = $2 AND a.number = $3", [ctx.run.id, step_key, attempt]);
          return text(row ? capResult(row) : `No attempt #${attempt} of "${step_key}".`);
        }
        const u = ctx.input.upstream[step_key];
        return text(u ? capResult(u.output) : `No completed upstream step "${step_key}". Available: ${Object.keys(ctx.input.upstream).join(", ")}`);
      },
    ),
    tool(
      "list_tools",
      "Discover domain integration tools (Hasaki Work, Jira, Bitbucket, repository registry, this run's history/changes). Optional query ranks by relevance.",
      { query: z.string().optional() },
      async ({ query }) => text(JSON.stringify(listTools(query, { mode }), null, 2)),
    ),
    tool(
      "describe_tool",
      "Full description and input schema of an integration tool (load before the first call).",
      { name: z.string() },
      async ({ name }) => {
        try {
          return text(JSON.stringify(describeTool(name), null, 2));
        } catch (e) {
          return text((e as Error).message);
        }
      },
    ),
    tool(
      "call_tool",
      "Call an integration tool by name with arguments matching its schema (see describe_tool).",
      { name: z.string(), arguments: z.record(z.string(), z.any()).optional() },
      async ({ name, arguments: args }) => {
        const r = await callTool(name, args ?? {}, { runId: ctx.run.id, allowedRepositories: ctx.run.allowed_repositories, mode });
        metrics.integration_calls.push({ name, ok: r.ok, ms: r.ms, ...(r.error ? { error: r.error.slice(0, 200) } : {}) });
        await ctx.log("system", `integration ${name} ${r.ok ? "ok" : "failed"} (${r.ms}ms)${r.error ? `: ${r.error}` : ""}`, { integration: name, ok: r.ok, ms: r.ms });
        return text(r.ok ? capResult(r.result) : `ERROR: ${r.error}`);
      },
    ),
  ];
  if (mode === "coding") {
    tools.unshift(
      tool(
        "prepare_branch",
        `Create or reuse the branch "${ctx.run.branch}" for a repo in an isolated git worktree and return its path. Allowed repos: ${editable.join(", ")}`,
        { repo: z.string().describe("repo directory name, e.g. oms-api") },
        async ({ repo }) => {
          if (!editable.includes(repo)) return text(`Repo "${repo}" is not selected for this run. Allowed: ${editable.join(", ")}`);
          const w = await prepareWorkspace(ctx.run, repo);
          if (!policy.workspaces.includes(w.path)) policy.workspaces.push(w.path);
          await ctx.log("system", `branch ${w.branch} in ${repo} (${w.created_from}) -> ${w.path}`);
          return text(`Ready. Work ONLY in: ${w.path}\nBranch: ${w.branch} (from ${w.created_from})`);
        },
      ),
    );
  }
  return createSdkMcpServer({ name: "platform", version: "2.0.0", tools });
}

/** Find a Claude session that can be resumed safely for this attempt (same step, same upstream context). */
async function resumableSession(ctx: ExecutionContext, cwd: string): Promise<{ sessionId: string; fromAttempt?: number } | null> {
  const resume = ctx.input.pending?.resume;
  const candidates = await q<{ session_id: string; attempt_id: number; snapshot: any }>(
    pool,
    `SELECT s.session_id, s.attempt_id, cs.content AS snapshot
       FROM agent_sessions s JOIN workflow_step_attempts a ON a.id = s.attempt_id LEFT JOIN context_snapshots cs ON cs.id = a.context_snapshot_id
      WHERE a.step_id = $1 AND s.resumable AND s.cwd = $2 ORDER BY s.id DESC LIMIT 5`,
    [ctx.step.id, cwd],
  );
  if (!candidates.length) return null;
  const current = await one(pool, "SELECT content FROM context_snapshots WHERE id = $1", [ctx.context.snapshot_id]);
  const sameUpstream = (snap: any) => JSON.stringify(snap?.upstream ?? {}) === JSON.stringify(current?.content?.upstream ?? {});
  // 1. resume after answers: the paused attempt's own session.
  if (resume?.from_attempt_id) {
    const c = candidates.find((x) => x.attempt_id === resume.from_attempt_id);
    if (c && sameUpstream(c.snapshot)) return { sessionId: c.session_id, fromAttempt: c.attempt_id };
  }
  // 2. reviewer feedback: continue the step's last session if nothing upstream changed since.
  if (ctx.input.pending?.feedback) {
    const c = candidates.find((x) => sameUpstream(x.snapshot));
    if (c) return { sessionId: c.session_id };
  }
  return null;
}

async function progressNotes(ctx: ExecutionContext, fromAttempt?: number) {
  if (!fromAttempt) return [];
  const rows = await q<{ data: any }>(pool, "SELECT data FROM workflow_checkpoints WHERE attempt_id = $1 AND reason = 'progress' ORDER BY id", [fromAttempt]);
  return rows.map((r) => String(r.data?.note ?? "")).filter(Boolean);
}

export const claudeExecutor: StepExecutor = {
  async execute(ctx): Promise<ExecResult> {
    const mode: ToolMode = ctx.step.type === "coding_agent" ? "coding" : "analysis";
    const ws = (await workspacesOf(ctx.run.id)).filter((w) => !ctx.run.selected_repositories.length || ctx.run.selected_repositories.includes(w.repo));
    const delegationCfg = ctx.step.config.delegation as { enabled?: boolean; agents?: string[] } | undefined;
    const delegation = delegationCfg?.enabled === true;
    const policy: PolicyContext = {
      mode,
      workspaces: ws.map((w) => w.path),
      baseBranch: config.baseBranch,
      protectedRoots: [config.reposRoot],
      delegation,
      isReadOnlyIntegration: (name) => integrationTools().find((t) => t.name === name)?.readOnly === true,
    };
    const settingSources = config.agent.settingSources;
    const nativeTools = toolsFor(mode, { delegation, claudeSkills: settingSources.length > 0 });
    const agents = delegation
      ? Object.fromEntries(
          (delegationCfg?.agents ?? Object.keys(SUBAGENTS))
            .filter((n) => SUBAGENTS[n])
            .map((n) => [n, { ...SUBAGENTS[n], tools: ["Read", "Grep", "Glob", "Bash", ...SUBAGENT_PLATFORM_TOOLS] }]),
        )
      : undefined;
    const metrics = newMetrics((ctx.step.config.model as string) || config.model || "default");
    for (const d of ctx.context.disclosure) metrics.disclosure[d.disclosure]++;
    for (const u of Object.values(ctx.context.upstream.plan)) metrics.upstream[u.mode]++;
    const cwd = taskDir(workspaceKey(ctx.run.branch));
    let submitted: Record<string, unknown> | undefined;

    const resume = await resumableSession(ctx, cwd);
    const files = ctx.input.work_item?.payload?.note_files ? await downloadAttachments(workspaceKey(ctx.run.branch), ctx.input.work_item.payload) : [];
    const reexec = ctx.input.pending?.reexecute || ctx.input.pending?.feedback;
    const extras = mode === "coding" && reexec && ws.length ? [{ title: "Current worktree state (inspect it first; never reset or discard these changes)", body: await worktreeState(ws) }] : [];
    const freshPrompt = () => buildUserPrompt(ctx.input, files, [], ctx.context.upstream, ctx.context.fileRefs, extras);
    const systemAppend = buildSystemAppend(ctx.run, ctx.step, ctx.context, mode);

    const preToolUse: HookCallback = async (input: any) => {
      const d = decide(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, policy, input.cwd, input.agent_id);
      if (d.allow) return {};
      metrics.denied.push({ tool: input.tool_name, reason: d.reason, ...(input.agent_id ? { subagent: input.agent_type ?? input.agent_id } : {}) });
      await ctx.log("tool", `denied ${input.tool_name}${input.agent_id ? ` (subagent ${input.agent_type ?? ""})` : ""}: ${d.reason}`);
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } };
    };
    const subagentStart: HookCallback = async (input: any) => {
      metrics.subagents.push({ type: input.agent_type, id: input.agent_id, started_at: new Date().toISOString() });
      await ctx.log("system", `subagent ${input.agent_type} started`, { subagent: input.agent_type, agent_id: input.agent_id });
      return {};
    };
    const subagentStop: HookCallback = async (input: any) => {
      const s = metrics.subagents.find((x) => x.id === input.agent_id);
      if (s) s.ended_at = new Date().toISOString();
      await ctx.log("system", `subagent ${input.agent_type} finished`, { subagent: input.agent_type, agent_id: input.agent_id });
      return {};
    };
    const canUseTool: CanUseTool = async (name, input) => {
      const d = decide(name, input, policy);
      return d.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: d.reason };
    };

    const run = async (prompt: string, resumeId?: string) => {
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      ctx.signal.addEventListener("abort", onAbort);
      async function* input(): AsyncGenerator<SDKUserMessage> {
        yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" };
      }
      const result = { isError: false, text: "", assistantTurns: 0 };
      await ctx.log("prompt", prompt, { resume_session: resumeId ?? null });
      try {
        for await (const msg of query({
          prompt: input(),
          options: {
            cwd,
            additionalDirectories: [config.reposRoot],
            resume: resumeId,
            abortController: ac,
            model: (ctx.step.config.model as string) || config.model || undefined,
            maxTurns: Number(ctx.step.config.max_turns ?? config.maxTurns),
            systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend },
            // Skills come from the platform registry (read_knowledge); Claude Code settings layers only if configured.
            settingSources,
            mcpServers: { platform: platformServer(ctx, mode, policy, (o) => (submitted = o), metrics) },
            tools: nativeTools,
            ...(agents ? { agents } : {}),
            permissionMode: "default",
            canUseTool,
            hooks: { PreToolUse: [{ hooks: [preToolUse] }], SubagentStart: [{ hooks: [subagentStart] }], SubagentStop: [{ hooks: [subagentStop] }] },
            disallowedTools: ["AskUserQuestion"],
          },
        })) {
          await recordTranscript(ctx, msg, cwd);
          accumulateMetrics(metrics, msg);
          if (msg.type === "assistant") result.assistantTurns++;
          else if (msg.type === "result") {
            result.isError = msg.is_error;
            result.text = msg.subtype === "success" ? msg.result : msg.subtype;
          }
        }
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
      return result;
    };

    await ctx.log("system_prompt", systemAppend, {
      mode,
      tools: nativeTools,
      setting_sources: settingSources,
      subagents: agents ? Object.keys(agents) : [],
      knowledge: ctx.context.disclosure.map((d) => `${d.key}:${d.disclosure}`),
    });
    let result;
    try {
    if (resume && existsSync(cwd)) {
      await ctx.log("system", `resuming Claude session ${resume.sessionId}`);
      try {
        result = await run(buildResumeMessage(ctx.input, resume.fromAttempt), resume.sessionId);
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        result = { isError: true, text: (e as Error).message, assistantTurns: 0 };
      }
      if (result.isError && result.assistantTurns === 0) {
        // Session missing or not resumable: rebuild from durable artifacts instead.
        await q(pool, "UPDATE agent_sessions SET resumable = false WHERE session_id = $1", [resume.sessionId]);
        await ctx.log("system", `session resume failed (${result.text}); rebuilding context from persisted step history`);
        result = await run(buildUserPrompt(ctx.input, files, await progressNotes(ctx, resume.fromAttempt), ctx.context.upstream, ctx.context.fileRefs, extras));
      }
    } else {
      result = await run(resume ? buildUserPrompt(ctx.input, files, await progressNotes(ctx, resume.fromAttempt), ctx.context.upstream, ctx.context.fileRefs, extras) : freshPrompt());
    }
    } finally {
      await ctx.recordMetrics(metrics as unknown as Record<string, unknown>).catch(() => {});
    }

    if (result.isError) return { kind: "failed", error: result.text || "agent run failed", retryable: true };
    const open = (await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM workflow_questions WHERE attempt_id = $1 AND status = 'open'", [ctx.attempt.id]))!.n;
    if (open) {
      const session = await one(pool, "SELECT session_id FROM agent_sessions WHERE attempt_id = $1 ORDER BY id DESC LIMIT 1", [ctx.attempt.id]);
      return { kind: "waiting_input", checkpoint: { session_id: session?.session_id ?? null, cwd, workspaces: policy.workspaces, mode, last_message: result.text.slice(0, 4000) } };
    }
    return { kind: "completed", output: submitted ?? { summary: result.text } };
  },
};

/** AI-assisted repository ranking: may only reorder/explain repositories from the deterministic candidate list. */
export async function rankRepositoriesWithClaude(ctx: ExecutionContext, ranked: RankedRepository[], repos: RepositoryRow[]): Promise<RankedRepository[]> {
  const meta = repos.map((r) => ({ name: r.name, description: r.description, services: r.services, tags: r.tags, projects: r.projects, dependencies: r.dependencies }));
  const prompt = [
    "Rank these repositories by how likely they must change for the engineering request. Use ONLY the listed repository names.",
    'Reply with JSON only: [{"repo": "...", "score": 0-10, "reasons": ["why this repo is relevant"]}]',
    "",
    "Repositories:",
    JSON.stringify(meta, null, 2),
    "",
    "Deterministic keyword ranking (for reference):",
    JSON.stringify(ranked.slice(0, 10)),
    "",
    "<untrusted_input source=\"work_item\">",
    `${ctx.input.work_item?.title ?? ctx.run.title}\n${ctx.input.work_item?.description ?? ""}`,
    JSON.stringify(Object.fromEntries(Object.entries(ctx.input.upstream).map(([k, u]) => [k, u.output]))).slice(0, 8000),
    "</untrusted_input>",
  ].join("\n");
  let out = "";
  for await (const msg of query({ prompt, options: { tools: [], maxTurns: 1, model: config.model || undefined, settingSources: [], persistSession: false } })) {
    if (msg.type === "result" && msg.subtype === "success") out = msg.result;
  }
  const json = out.match(/\[[\s\S]*\]/)?.[0];
  if (!json) throw new Error("no JSON in ranking reply");
  const allowed = new Set(repos.map((r) => r.name));
  return (JSON.parse(json) as RankedRepository[])
    .filter((r) => allowed.has(r.repo))
    .map((r) => ({ repo: r.repo, score: Number(r.score) || 0, reasons: (r.reasons ?? []).map(String) }))
    .sort((a, b) => b.score - a.score);
}
