import { query, tool, createSdkMcpServer, type SDKUserMessage, type HookCallback, type CanUseTool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
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
import { decide, toolsFor, type PolicyContext, type ToolMode } from "./toolPolicy.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function summarize(input: unknown) {
  const s = JSON.stringify(input);
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}

/**
 * Platform MCP tools, bound to one attempt (run + step + attempt), so every question, note, branch and
 * result lands on the right execution record.
 */
function platformServer(ctx: ExecutionContext, mode: ToolMode, policy: PolicyContext, onSubmit: (o: Record<string, unknown>) => void) {
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
      "read_step_output",
      "Read the full output of an earlier (completed) step of this run.",
      { step_key: z.string() },
      async ({ step_key }) => {
        const u = ctx.input.upstream[step_key];
        return text(u ? JSON.stringify(u.output, null, 2) : `No completed upstream step "${step_key}". Available: ${Object.keys(ctx.input.upstream).join(", ")}`);
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
    const policy: PolicyContext = { mode, workspaces: ws.map((w) => w.path), baseBranch: config.baseBranch };
    const cwd = taskDir(workspaceKey(ctx.run.branch));
    let submitted: Record<string, unknown> | undefined;

    const resume = await resumableSession(ctx, cwd);
    const files = ctx.input.work_item?.payload?.note_files ? await downloadAttachments(workspaceKey(ctx.run.branch), ctx.input.work_item.payload) : [];
    const freshPrompt = () => buildUserPrompt(ctx.input, files, []);
    const systemAppend = buildSystemAppend(ctx.run, ctx.step, ctx.context, mode);

    const preToolUse: HookCallback = async (input: any) => {
      const d = decide(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, policy);
      if (d.allow) return {};
      await ctx.log("tool", `denied ${input.tool_name}: ${d.reason}`);
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } };
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
            settingSources: ["user"], // ~/.claude skills (oms-*, commit, ...) and user CLAUDE.md
            mcpServers: { platform: platformServer(ctx, mode, policy, (o) => (submitted = o)) },
            tools: toolsFor(mode),
            permissionMode: "default",
            canUseTool,
            hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
            disallowedTools: ["AskUserQuestion"],
          },
        })) {
          if (msg.type === "system" && msg.subtype === "init") {
            await ctx.recordSession(msg.session_id, cwd, config.model);
          } else if (msg.type === "assistant") {
            result.assistantTurns++;
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text.trim()) await ctx.log("agent", block.text);
              else if (block.type === "tool_use") await ctx.log("tool", `${block.name} ${summarize(block.input)}`);
            }
          } else if (msg.type === "result") {
            result.isError = msg.is_error;
            result.text = msg.subtype === "success" ? msg.result : msg.subtype;
          }
        }
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
      return result;
    };

    let result;
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
        result = await run(buildUserPrompt(ctx.input, files, await progressNotes(ctx, resume.fromAttempt)));
      }
    } else {
      result = await run(resume ? buildUserPrompt(ctx.input, files, await progressNotes(ctx, resume.fromAttempt)) : freshPrompt());
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
