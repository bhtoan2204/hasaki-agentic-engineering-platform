import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertModelAllowed } from "./modelPolicy.ts";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { agentEnvironment, paidClaudeAuth, paidClaudeAuthMessage } from "./environment.ts";
import { accumulateMetrics, newMetrics } from "./metrics.ts";
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

export interface CompletionOptions {
  signal?: AbortSignal;
  model: string;
  effort: string;
  timeoutMs: number;
  onStream?: CompletionStreamListener;
  session?: CompletionSession;
}
export type CompletionRunner = (
  prompt: string,
  options: CompletionOptions,
) => Promise<{
  text: string;
  model?: string;
  cost_usd?: number | null;
  tokens: Completion["metrics"]["tokens"];
  session_id?: string | null;
}>;
const claudeComplete: CompletionRunner = async (prompt, options) => {
  const metrics = newMetrics(options.model || "default");
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) ac.abort();
  let text = "";
  let partial = "";
  let sessionId: string | null = null;
  const stream = options.onStream;
  const session = options.session?.keep ? options.session : null;
  try {
    for await (const msg of query({
      prompt,
      options: {
        ...(process.env.CLAUDE_CODE_EXECUTABLE || config.agent.claudeBin
          ? {
              pathToClaudeCodeExecutable:
                process.env.CLAUDE_CODE_EXECUTABLE || config.agent.claudeBin,
            }
          : {}),
        env: agentEnvironment(process.env, "claude"),
        tools: [],
        maxTurns: 1,
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
        else if (msg.type === "stream_event" && msg.event.type === "content_block_delta") {
          const d = msg.event.delta;
          if (d.type === "text_delta") stream({ type: "text", text: (partial += d.text) });
          else if (d.type === "thinking_delta") stream({ type: "reasoning", delta: d.thinking });
        }
      }
      if (msg.type === "result" && msg.subtype === "success") text = msg.result;
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

/** One tools-free completion using the same frozen analysis routing as ordinary agent steps. */
export async function completeForRun(
  run: CompletionRun | null | undefined,
  prompt: string,
  signal?: AbortSignal,
  providers?: Record<AgentProvider, CompletionRunner> | null,
  agent: CompletionAgentOverride = {},
  onStream?: CompletionStreamListener,
  session?: CompletionSession,
): Promise<Completion> {
  signal?.throwIfAborted();
  const runnerMap = providers ?? runners;
  const configured =
    run?.agent_configuration === undefined
      ? { ...run, agent_configuration: await loadAgentConfiguration() }
      : run;
  const resolved = completionAgent(configured, agent);
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
    },
  };
}
