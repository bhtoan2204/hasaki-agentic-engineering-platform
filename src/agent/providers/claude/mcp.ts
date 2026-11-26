import { createSdkMcpServer, tool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config } from "../../../config.ts";
import type { ExecutionContext } from "../../../workflow/executors/registry.ts";
import { advertisedContextTools } from "../../contextToolSchemas.ts";
import { outputLocale } from "../../language.ts";
import type { AgentMetrics } from "../../metrics.ts";
import { dispatchPlatformTool, envFromExecution } from "../../platformTools.ts";
import type { PolicyContext, ToolMode } from "../../toolPolicy.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

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
export async function recordTranscript(ctx: ExecutionContext, msg: SDKMessage, cwd: string) {
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
export function platformServer(
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
                .describe(
                  'Options are distinct answers the step can act on right away: each one a concrete decision or instruction (your recommendation first). Never restate the question or tell the developer to provide information in their answer; when you need typed details, end the option with a colon (for example "Use this SPL window:"). Settle what you can with your tools first and ask only what only the developer can decide or provide.',
                ),
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
    ...advertisedContextTools().map((t) =>
      tool(t.name, t.description, t.input.shape, call(t.logicalName)),
    ),
  );
  if (mode === "coding") {
    tools.unshift(
      tool(
        "prepare_branch",
        `Create or reuse the branch "${ctx.run.branch}" for a repo in an isolated git worktree and return its path. Automatically selects the repo after checking current write access; no manual selection update needed. Allowed repos: ${ctx.run.allowed_repositories.join(", ")}`,
        {
          repo: z.string().describe("repo directory name, e.g. oms-api"),
          base: z
            .string()
            .optional()
            .describe(
              "existing remote branch to cut the run branch from instead of the default branch (the PR then targets it); a worktree without commits of its own is moved onto it by the platform",
            ),
        },
        call("prepare_branch"),
      ),
    );
  }
  return createSdkMcpServer({ name: "platform", version: "2.0.0", tools });
}
