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
  /** Repeated work inside the attempt (measured from the provider's tool_use events). */
  tool_repeats?: { calls: number; duplicate_calls: number; file_reads: number; repeated_file_reads: number; distinct_files_read: number };
  /** ms from the attempt's first event to the first read/edit of a file the step finally changed (coding steps). */
  first_useful_location_ms?: number | null;
}

export function newMetrics(model: string): AgentMetrics {
  return { model, sessions: 0, turns: 0, duration_ms: 0, cost_usd: null, tokens: null, tool_calls: {}, tool_errors: 0, denied: [], skills_loaded: [], knowledge_searches: [], integration_calls: [], subagents: [], disclosure: { inline: 0, index: 0, search: 0 }, upstream: { full: 0, summary: 0 } };
}

const seenMessages = new WeakMap<AgentMetrics, Set<string>>();
/** Side state for repetition / first-touch measurement (not persisted itself). */
const toolState = new WeakMap<AgentMetrics, { sigs: Set<string>; reads: Set<string>; firstTouch: Map<string, number>; t0: number }>();
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`).join(",")}}`;
}

/** Count tool calls, exact duplicates and repeated file reads; remember when each file was first touched. */
export function noteToolUse(m: AgentMetrics, name: string, input: unknown, now = Date.now()) {
  let st = toolState.get(m);
  if (!st) toolState.set(m, (st = { sigs: new Set(), reads: new Set(), firstTouch: new Map(), t0: now }));
  const r = (m.tool_repeats ??= { calls: 0, duplicate_calls: 0, file_reads: 0, repeated_file_reads: 0, distinct_files_read: 0 });
  r.calls++;
  const sig = `${name}:${stableJson(input)}`;
  if (st.sigs.has(sig)) r.duplicate_calls++;
  else if (st.sigs.size < 5000) st.sigs.add(sig);
  const file = typeof (input as any)?.file_path === "string" ? String((input as any).file_path) : null;
  if (file && FILE_TOOLS.has(name)) {
    if (!st.firstTouch.has(file) && st.firstTouch.size < 1000) st.firstTouch.set(file, now - st.t0);
    if (name === "Read") {
      r.file_reads++;
      if (st.reads.has(file)) r.repeated_file_reads++;
      else st.reads.add(file);
      r.distinct_files_read = st.reads.size;
    }
  }
}

/** Earliest first touch of any file whose path ends with one of `changed` (repo-relative paths). */
export function firstUsefulLocationMs(m: AgentMetrics, changed: string[]): number | null {
  const st = toolState.get(m);
  if (!st || !changed.length) return null;
  let best: number | null = null;
  for (const [file, ms] of st.firstTouch)
    if (changed.some((c) => file === c || file.endsWith(`/${c}`))) best = best == null ? ms : Math.min(best, ms);
  return best;
}

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
    for (const b of msg.message?.content ?? [])
      if (b.type === "tool_use") {
        m.tool_calls[b.name] = (m.tool_calls[b.name] ?? 0) + 1;
        noteToolUse(m, b.name, b.input);
      }
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
