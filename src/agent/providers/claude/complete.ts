import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { config } from "../../../config.ts";
import { nativeToolName, type CompletionRunner } from "../../completionTypes.ts";
import { agentEnvironment, paidClaudeAuth, paidClaudeAuthMessage } from "../../environment.ts";
import { accumulateMetrics, newMetrics, providerTelemetry } from "../../metrics.ts";
import { assertModelAllowed } from "../../modelPolicy.ts";

let sessionDir: string | null = null;
function chatSessionDir() {
  if (!sessionDir) {
    sessionDir = join(config.dataDir, "completion-sessions");
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

export const claudeComplete: CompletionRunner = async (prompt, options) => {
  const metrics = newMetrics(options.model || "default");
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) ac.abort();
  let text = "";
  let partial = "";
  let completed = false;
  let sessionId: string | null = null;
  const stream = options.onStream;
  const session = options.session?.keep ? options.session : null;
  const native = options.nativeTools;
  const byNative = new Map(native?.tools.map((t) => [nativeToolName(t.name), t.name]) ?? []);
  // Images go as content blocks of one user message (the SDK's streaming input); text-only keeps the plain prompt.
  const input = options.images?.length
    ? (async function* (): AsyncGenerator<SDKUserMessage> {
        yield {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...options.images!.map((i) => ({
                type: "image" as const,
                source: { type: "base64" as const, media_type: i.media_type, data: i.data },
              })),
            ],
          },
        } as SDKUserMessage;
      })()
    : prompt;
  try {
    for await (const msg of query({
      prompt: input,
      options: {
        ...(config.agent.claudeBin
          ? {
              pathToClaudeCodeExecutable: config.agent.claudeBin,
            }
          : {}),
        env: agentEnvironment(process.env, "claude"),
        tools: [],
        maxTurns: native ? native.maxTurns : 1,
        ...(native
          ? {
              mcpServers: {
                platform: createSdkMcpServer({
                  name: "platform",
                  version: "1.0.0",
                  tools: native.tools.map((t) =>
                    tool(nativeToolName(t.name), t.description, t.shape, async (args) => ({
                      content: [{ type: "text" as const, text: await native.call(t.name, args) }],
                    })),
                  ),
                }),
              },
              allowedTools: [...byNative.keys()].map((n) => `mcp__platform__${n}`),
              // Anything not listed above is refused without a prompt (no built-in tool can be approved).
              permissionMode: "dontAsk" as const,
            }
          : {}),
        model: options.model || undefined,
        ...(options.effort
          ? { effort: options.effort as "low" | "medium" | "high" | "xhigh" | "max" }
          : {}),
        settingSources: [],
        // A kept session lives in a platform-owned directory, never among the developer's own Claude Code sessions.
        persistSession: !!session,
        ...(session
          ? { cwd: chatSessionDir(), ...(session.resume ? { resume: session.resume } : {}) }
          : {}),
        abortController: ac,
        ...(stream ? { includePartialMessages: true } : {}),
      },
    })) {
      const paid = paidClaudeAuth(msg);
      if (paid) throw new Error(paidClaudeAuthMessage(paid));
      accumulateMetrics(metrics, msg);
      if (msg.type === "system" && msg.subtype === "init") {
        assertModelAllowed(msg.model ?? options.model, "Claude completion");
        sessionId = msg.session_id ?? null;
      }
      if (stream) {
        if (msg.type === "system" && msg.subtype === "init") stream({ type: "started" });
        // Each assistant message of a tool loop streams on its own; the final answer is the last one.
        else if (msg.type === "stream_event" && msg.event.type === "message_start") partial = "";
        else if (msg.type === "stream_event" && msg.event.type === "content_block_delta") {
          const d = msg.event.delta;
          if (d.type === "text_delta") stream({ type: "text", text: (partial += d.text) });
          else if (d.type === "thinking_delta") stream({ type: "reasoning", delta: d.thinking });
        }
      }
      if (msg.type === "result" && msg.subtype === "success") {
        text = msg.result;
        completed = true;
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
  return {
    text,
    model: metrics.model,
    tokens: metrics.tokens,
    cost_usd: metrics.cost_usd,
    session_id: session ? sessionId : null,
    telemetry: providerTelemetry(metrics, { completed }),
  };
};
