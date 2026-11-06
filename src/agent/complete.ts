import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { accumulateMetrics, newMetrics } from "./claude.ts";
import { codexComplete } from "./codex/run.ts";
import { cursorComplete } from "./cursor/run.ts";
import { agentProvider, type AgentProvider } from "./provider.ts";

/**
 * One-shot, tool-less text completion for the auxiliary AI calls that belong to a run (repository ranking, report
 * reasoning, test-failure explanation / answer interpretation). The RUN's provider decides who answers, so a Codex or
 * Cursor run never silently calls Claude. Calls outside a run (no run row) keep the global default: Claude with
 * config.model.
 *
 * Metrics are real or null: Claude reports cost and tokens; Codex reports tokens but no price (ChatGPT plan usage);
 * Cursor reports neither.
 */
export interface Completion {
  text: string;
  provider: AgentProvider;
  metrics: { provider: AgentProvider; model: string | null; model_source: string; cost_usd: number | null; tokens: Record<string, number> | null };
}

export async function completeForRun(run: { agent_provider?: string | null } | null | undefined, prompt: string, signal?: AbortSignal): Promise<Completion> {
  const provider = agentProvider(run);
  if (provider === "codex") {
    const r = await codexComplete(prompt, { signal });
    return { text: r.text, provider, metrics: { provider, model: r.model || null, model_source: r.model ? "agent.codex.model" : "codex account default", cost_usd: null, tokens: r.tokens } };
  }
  if (provider === "cursor") {
    const text = await cursorComplete(prompt, signal);
    return { text, provider, metrics: { provider, model: null, model_source: "cursor account default", cost_usd: null, tokens: null } };
  }
  const m = newMetrics(config.model || "default");
  let text = "";
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const msg of query({ prompt, options: { tools: [], maxTurns: 1, model: config.model || undefined, settingSources: [], persistSession: false, abortController: ac } })) {
      accumulateMetrics(m, msg);
      if (msg.type === "result" && msg.subtype === "success") text = msg.result;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return { text, provider, metrics: { provider, model: m.model, model_source: config.model ? "global default" : "sdk default", cost_usd: m.cost_usd, tokens: m.tokens } };
}
