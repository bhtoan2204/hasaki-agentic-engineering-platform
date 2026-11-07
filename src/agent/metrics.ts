/** Per-attempt metrics, accumulated across provider messages and session resume, without orchestration dependencies. */
export interface AgentMetrics {
  model: string;
  sessions: number;
  turns: number;
  duration_ms: number;
  /** Null when the provider does not report a cost. Never invent 0. */
  cost_usd: number | null;
  tokens: { input: number; output: number; cache_read: number; cache_creation: number; reasoning_output?: number } | null;
  tool_calls: Record<string, number>;
  tool_errors: number;
  denied: Array<{ tool: string; reason: string; subagent?: string }>;
  skills_loaded: string[];
  /** Harness verification outcome of a coding attempt (see verify.ts). */
  verification?: Record<string, unknown>;
  /** Where the model came from: step config / routing / global default. */
  model_source?: string;
  /** Agent provider that produced these metrics (claude | cursor | codex). */
  provider?: string;
  /** Codex model_reasoning_effort, when one was configured. */
  reasoning_effort?: string;
  /** Verdict of an independent verification step (see independentReview.ts). */
  independent_verification?: Record<string, unknown>;
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
    m.cost_usd = Math.round(((m.cost_usd ?? 0) + (msg.total_cost_usd ?? 0)) * 1e6) / 1e6;
    const u = msg.usage ?? {};
    if (!m.tokens) m.tokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
    m.tokens.input += u.input_tokens ?? 0;
    m.tokens.output += u.output_tokens ?? 0;
    m.tokens.cache_read += u.cache_read_input_tokens ?? 0;
    m.tokens.cache_creation += u.cache_creation_input_tokens ?? 0;
  }
}

