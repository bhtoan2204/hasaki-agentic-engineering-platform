/** Per-attempt metrics, accumulated across provider messages and session resume, without orchestration dependencies. */
export interface AgentMetrics {
  model: string;
  sessions: number;
  turns: number;
  duration_ms: number;
  /** Null when the provider does not report a cost. Never invent 0. */
  cost_usd: number | null;
  tokens: { input: number | null; output: number | null; cache_read: number | null; cache_creation: number | null; reasoning_output?: number | null } | null;
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
  /** Evidence-gated investigation: claim counts, downgrades, root-cause status, fix risk, gate (no raw content). */
  evidence?: Record<string, unknown>;
  knowledge_searches: string[];
  integration_calls: Array<{ name: string; ok: boolean; ms: number; error?: string }>;
  subagents: Array<{ type: string; id: string; started_at: string; ended_at?: string }>;
  disclosure: { inline: number; index: number; search: number };
  upstream: { full: number; summary: number };
}

export function newMetrics(model: string): AgentMetrics {
  return { model, sessions: 0, turns: 0, duration_ms: 0, cost_usd: null, tokens: null, tool_calls: {}, tool_errors: 0, denied: [], skills_loaded: [], knowledge_searches: [], integration_calls: [], subagents: [], disclosure: { inline: 0, index: 0, search: 0 }, upstream: { full: 0, summary: 0 } };
}

const seenMessages = new WeakMap<AgentMetrics, Set<string>>();

/** Fold one SDK message into the metrics (pure; unit-tested). */
export function accumulateMetrics(m: AgentMetrics, msg: any) {
  // SDK UUIDs identify replayed events; identical un-IDed events may be legitimate separate sessions.
  if (msg.uuid) {
    const seen = seenMessages.get(m) ?? new Set<string>();
    if (seen.has(msg.uuid)) return;
    seen.add(msg.uuid);
    seenMessages.set(m, seen);
  }
  if (msg.type === "system" && msg.subtype === "init") {
    m.sessions++;
    if (typeof msg.model === "string" && msg.model) m.model = msg.model;
  }
  else if (msg.type === "assistant") {
    for (const b of msg.message?.content ?? []) if (b.type === "tool_use") m.tool_calls[b.name] = (m.tool_calls[b.name] ?? 0) + 1;
  } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) if (b.type === "tool_result" && b.is_error) m.tool_errors++;
  } else if (msg.type === "result") {
    m.turns += msg.num_turns ?? 0;
    m.duration_ms += msg.duration_ms ?? 0;
    addUsage(m, msg.usage, msg.total_cost_usd);
  }
}

/** Add only fields actually reported. Unknown fields remain null, including optional cache/reasoning usage. */
export function addUsage(m: AgentMetrics, usage?: Record<string, unknown> | null, cost?: unknown) {
  if (validMetric(cost)) m.cost_usd = Math.round(((m.cost_usd ?? 0) + cost) * 1e6) / 1e6;
  if (!usage) return;
  const fields = { input: "input_tokens", output: "output_tokens", cache_read: "cache_read_input_tokens", cache_creation: "cache_creation_input_tokens", reasoning_output: "reasoning_output_tokens" } as const;
  for (const [key, field] of Object.entries(fields)) {
    const value = usage[field];
    if (!validMetric(value)) continue;
    m.tokens ??= { input: null, output: null, cache_read: null, cache_creation: null };
    const k = key as keyof NonNullable<AgentMetrics["tokens"]>;
    m.tokens[k] = (m.tokens[k] ?? 0) + value;
  }
}
export function validMetric(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
