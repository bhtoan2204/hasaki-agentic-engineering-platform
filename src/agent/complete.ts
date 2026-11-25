import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertModelAllowed } from "./modelPolicy.ts";
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import { config } from "../config.ts";
import { agentEnvironment, paidClaudeAuth, paidClaudeAuthMessage } from "./environment.ts";
import {
  accumulateMetrics,
  newMetrics,
  providerTelemetry,
  type ProviderTelemetry,
} from "./metrics.ts";
import { codexComplete } from "./codex/run.ts";
import { cursorComplete } from "./cursor/run.ts";
import { antigravityComplete } from "./antigravity/run.ts";
import { copilotComplete } from "./copilot/run.ts";
import type { AgentProvider } from "./provider.ts";
import type { CompletionStreamListener } from "./completionStream.ts";
export type { CompletionStreamEvent, CompletionStreamListener } from "./completionStream.ts";
import type { CompletionRun } from "./configuration.ts";
export type { CompletionRun } from "./configuration.ts";
import { resolveStepAgent } from "./stepAgent.ts";
import { loadAgentConfiguration } from "./configurationStore.ts";

/** Explicit per-request agent values (e.g. a chat conversation's selection), validated like a step's `config.agent`. */
export interface CompletionAgentOverride {
  provider?: AgentProvider;
  model?: string | null;
  reasoning_effort?: string | null;
}
export function completionAgent(
  run: CompletionRun | null | undefined,
  agent: CompletionAgentOverride = {},
) {
  if (run?.agent_configuration === null)
    throw new Error("Historical run requires configuration recovery before completion");
  const explicit = Object.fromEntries(Object.entries(agent).filter(([, v]) => v != null));
  return resolveStepAgent(run ?? {}, {
    type: "agent",
    config: Object.keys(explicit).length ? { agent: explicit } : {},
  })!;
}
export interface Completion {
  text: string;
  provider: AgentProvider;
  /** Set when the provider kept a session the caller can resume with only the new content. */
  session_id?: string | null;
  metrics: {
    telemetry_id: string;
    provider_execution_ms: number;
    provider: AgentProvider;
    model: string | null;
    model_source: string;
    cost_usd: number | null;
    tokens: Record<string, number | null | undefined> | null;
    /** What the provider reported about the work inside this completion; null when it reports nothing. */
    telemetry: ProviderTelemetry | null;
  };
}

/**
 * A provider-side conversation the caller wants to continue (send only what is new). Providers without one ignore it
 * and return no `session_id`, so the caller keeps sending complete prompts.
 */
export interface CompletionSession {
  keep: boolean;
  resume?: string | null;
}

/** An image block of the request (bytes as base64; never written to logs or telemetry). */
export interface CompletionImage {
  media_type: "image/png" | "image/jpeg" | "image/webp";
  data: string;
}
/** Providers whose completion path accepts image blocks. Others get a capability error, never a silently dropped image. */
export const VISION_PROVIDERS: readonly AgentProvider[] = ["claude"];
/** Providers whose completion path offers native structured tool calls (see `NativeTools`). */
export const NATIVE_TOOL_PROVIDERS: readonly AgentProvider[] = ["claude"];
export class ProviderCapabilityError extends Error {}

/**
 * Platform tools offered as native tool calls (Claude: an in-process MCP server of the Agent SDK). Only these tools exist
 * in the session: built-in file, shell and web tools stay disabled, and `call` is the caller's own authorization,
 * validation and audit path. The provider runs the tool loop; `call` returns the text the model sees.
 */
export interface NativeTools {
  tools: Array<{ name: string; description: string; shape: Record<string, z.ZodType> }>;
  call: (name: string, args: unknown) => Promise<string>;
  maxTurns: number;
}

export interface CompletionOptions {
  signal?: AbortSignal;
  model: string;
  effort: string;
  timeoutMs: number;
  onStream?: CompletionStreamListener;
  session?: CompletionSession;
  images?: CompletionImage[];
  nativeTools?: NativeTools;
}
/** MCP tool names allow [a-zA-Z0-9_-]: `code.read_file` is offered as `code_read_file`. */
export const nativeToolName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");
export type CompletionRunner = (
  prompt: string,
  options: CompletionOptions,
) => Promise<{
  text: string;
  model?: string;
  cost_usd?: number | null;
  tokens: Completion["metrics"]["tokens"];
  session_id?: string | null;
  telemetry?: ProviderTelemetry | null;
}>;
const claudeComplete: CompletionRunner = async (prompt, options) => {
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

let sessionDir: string | null = null;
function chatSessionDir() {
  if (!sessionDir) {
    sessionDir = join(config.dataDir, "completion-sessions");
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}
const runners: Record<AgentProvider, CompletionRunner> = {
  claude: claudeComplete,
  codex: codexComplete,
  cursor: async (prompt, options) => ({
    text: await cursorComplete(prompt, options.signal, options),
    model: options.model,
    tokens: null,
  }),
  antigravity: antigravityComplete,
  copilot: copilotComplete,
};
/** The real provider runners (evaluation wraps them to measure prompts; chat uses them through completeForRun). */
export const completionRunners: Readonly<Record<AgentProvider, CompletionRunner>> = runners;

/** One tools-free completion using the same frozen analysis routing as ordinary agent steps. */
export async function completeForRun(
  run: CompletionRun | null | undefined,
  prompt: string,
  signal?: AbortSignal,
  providers?: Record<AgentProvider, CompletionRunner> | null,
  agent: CompletionAgentOverride = {},
  onStream?: CompletionStreamListener,
  session?: CompletionSession,
  extras: { images?: CompletionImage[]; nativeTools?: NativeTools } = {},
): Promise<Completion> {
  signal?.throwIfAborted();
  const runnerMap = providers ?? runners;
  const configured =
    run?.agent_configuration === undefined
      ? { ...run, agent_configuration: await loadAgentConfiguration() }
      : run;
  const resolved = completionAgent(configured, agent);
  if (extras.images?.length && !VISION_PROVIDERS.includes(resolved.provider))
    throw new ProviderCapabilityError(
      `${resolved.provider} cannot read images in chat; choose a vision-capable provider (${VISION_PROVIDERS.join(", ")}) or AUTO`,
    );
  const timeoutMs = Math.min(resolved.timeout_ms ?? 600_000, 600_000);
  const deadline = AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  const result = await runnerMap[resolved.provider](prompt, {
    model: resolved.model ?? "",
    effort: resolved.reasoning_effort ?? "",
    timeoutMs,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    ...(onStream ? { onStream } : {}),
    ...(session ? { session } : {}),
    ...(extras.images?.length ? { images: extras.images } : {}),
    ...(extras.nativeTools && NATIVE_TOOL_PROVIDERS.includes(resolved.provider)
      ? { nativeTools: extras.nativeTools }
      : {}),
  });
  // Whatever model the provider reports (an account default included) is checked, not only what was requested.
  assertModelAllowed(result.model || resolved.model, `${resolved.provider} completion`);
  return {
    text: result.text,
    provider: resolved.provider,
    session_id: result.session_id ?? null,
    metrics: {
      telemetry_id: randomUUID(),
      provider_execution_ms: Date.now() - started,
      provider: resolved.provider,
      model: result.model || resolved.model,
      model_source: resolved.field_sources?.model ?? "account/CLI default (external)",
      cost_usd: result.cost_usd ?? null,
      tokens: result.tokens,
      telemetry: result.telemetry ?? null,
    },
  };
}
