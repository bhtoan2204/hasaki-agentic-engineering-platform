import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { agentEnvironment, paidClaudeAuth, paidClaudeAuthMessage } from "./environment.ts";
import { accumulateMetrics, newMetrics } from "./metrics.ts";
import { codexComplete } from "./codex/run.ts";
import { cursorComplete } from "./cursor/run.ts";
import { antigravityComplete } from "./antigravity/run.ts";
import { copilotComplete } from "./copilot/run.ts";
import type { AgentProvider } from "./provider.ts";
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
export interface CompletionOptions {
  signal?: AbortSignal;
  model: string;
  effort: string;
  timeoutMs: number;
}
export type CompletionRunner = (
  prompt: string,
  options: CompletionOptions,
) => Promise<{
  text: string;
  model?: string;
  cost_usd?: number | null;
  tokens: Completion["metrics"]["tokens"];
}>;
const claudeComplete: CompletionRunner = async (prompt, options) => {
  const metrics = newMetrics(options.model || "default");
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) ac.abort();
  let text = "";
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
        persistSession: false,
        abortController: ac,
      },
    })) {
      const paid = paidClaudeAuth(msg);
      if (paid) throw new Error(paidClaudeAuthMessage(paid));
      accumulateMetrics(metrics, msg);
      if (msg.type === "result" && msg.subtype === "success") text = msg.result;
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
  return { text, model: metrics.model, tokens: metrics.tokens, cost_usd: metrics.cost_usd };
};
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
  providers: Record<AgentProvider, CompletionRunner> = runners,
  agent: CompletionAgentOverride = {},
): Promise<Completion> {
  signal?.throwIfAborted();
  const configured =
    run?.agent_configuration === undefined
      ? { ...run, agent_configuration: await loadAgentConfiguration() }
      : run;
  const resolved = completionAgent(configured, agent);
  const timeoutMs = Math.min(resolved.timeout_ms ?? 600_000, 600_000);
  const deadline = AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  const result = await providers[resolved.provider](prompt, {
    model: resolved.model ?? "",
    effort: resolved.reasoning_effort ?? "",
    timeoutMs,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  return {
    text: result.text,
    provider: resolved.provider,
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
