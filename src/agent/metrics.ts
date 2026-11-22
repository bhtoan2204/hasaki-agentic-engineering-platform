import { liveRuntime, observeLiveUsage } from "../eval/liveRuntime.ts";
import type { SkillTrace } from "./skillTracing.ts";
/** Per-attempt metrics, accumulated across provider messages and session resume, without orchestration dependencies. */
export interface AgentMetrics {
  model: string;
  sessions: number;
  turns: number;
  duration_ms: number;
  /** Null when the provider does not report a cost. Never invent 0. */
  cost_usd: number | null;
  tokens: {
    input: number | null;
    output: number | null;
    cache_read: number | null;
    cache_creation: number | null;
    reasoning_output?: number | null;
  } | null;
  /**
   * Context occupancy of the main session as the provider reported it on its latest / largest API call (uncached
   * input + cache reads + cache writes of that one call). Absent when the provider does not report per-call usage.
   */
  context_window?: { last_tokens: number; peak_tokens: number };
  /** Sessions the platform compacted at a safe boundary during this attempt (provider-neutral reconstruction). */
  compactions?: Array<{
    boundary: string;
    round?: number;
    pressure: number | null;
    occupancy: number | null;
    window: number;
  }>;
  tool_calls: Record<string, number>;
  tool_errors: number;
  denied: Array<{ tool: string; reason: string; subagent?: string }>;
  skills_loaded: string[];
  skills?: SkillTrace[];
  /** Skills offered to the agent this attempt, "key:tier" (inline = full body in the prompt; index = description only,
   * loaded only if the agent calls read_knowledge — then it also appears in skills_loaded). */
  skills_provided?: string[];
  /** Harness verification outcome of a coding attempt (see verify.ts). */
  verification?: Record<string, unknown>;
  /** Where the model came from: step config / routing / global default. */
  model_source?: string;
  /** Agent provider that produced these metrics (claude | cursor | codex | antigravity). */
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
  tool_repeats?: {
    calls: number;
    duplicate_calls: number;
    file_reads: number;
    repeated_file_reads: number;
    distinct_files_read: number;
  };
  /** ms from the attempt's first event to the first read/edit of a file the step finally changed (coding steps). */
  first_useful_location_ms?: number | null;
}

export function newMetrics(model: string): AgentMetrics {
  return {
    model,
    sessions: 0,
    turns: 0,
    duration_ms: 0,
    cost_usd: null,
    tokens: null,
    tool_calls: {},
    tool_errors: 0,
    denied: [],
    skills_loaded: [],
    knowledge_searches: [],
    integration_calls: [],
    subagents: [],
    disclosure: { inline: 0, index: 0, search: 0 },
    upstream: { full: 0, summary: 0 },
  };
}

const streamedUsage = new WeakMap<AgentMetrics, Map<string, number>>();
/** What the provider itself reported about the model work inside one completion (see providerTelemetry). */
const providerState = new WeakMap<
  AgentMetrics,
  {
    assistantIds: Set<string>;
    apiModels: Set<string>;
    sessionModel: string | null;
    toolUses: number;
    resultSeen: boolean;
  }
>();
const stateOf = (m: AgentMetrics) => {
  let st = providerState.get(m);
  if (!st)
    providerState.set(
      m,
      (st = {
        assistantIds: new Set(),
        apiModels: new Set(),
        sessionModel: null,
        toolUses: 0,
        resultSeen: false,
      }),
    );
  return st;
};

/**
 * Provider telemetry of one completion, from the provider's own events: internal model turns (the result's
 * `num_turns`), distinct assistant API messages of the main session, tool-use events, the session model the provider
 * announced and the models its API messages carried (an alias resolves there). Null when not reported — the requested
 * model is never substituted, and a completion that ended without a result has unknown turns and duration.
 */
export function providerTelemetry(m: AgentMetrics, o: { completed?: boolean } = {}) {
  const st = stateOf(m);
  const finished = st.resultSeen && o.completed !== false;
  return {
    model_turns: finished ? m.turns : null,
    assistant_messages: st.assistantIds.size,
    provider_tool_uses: st.toolUses,
    provider_tool_errors: m.tool_errors,
    session_model: st.sessionModel,
    api_models: [...st.apiModels].sort(),
    provider_duration_ms: finished ? m.duration_ms : null,
    reasoning_tokens: m.tokens?.reasoning_output ?? null,
  };
}
export type ProviderTelemetry = ReturnType<typeof providerTelemetry>;
const seenMessages = new WeakMap<AgentMetrics, Set<string>>();
/** Side state for repetition / first-touch measurement (not persisted itself). */
const toolState = new WeakMap<
  AgentMetrics,
  { sigs: Set<string>; reads: Set<string>; firstTouch: Map<string, number>; t0: number }
>();
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** Count tool calls, exact duplicates and repeated file reads; remember when each file was first touched. */
export function noteToolUse(m: AgentMetrics, name: string, input: unknown, now = Date.now()) {
  let st = toolState.get(m);
  if (!st)
    toolState.set(m, (st = { sigs: new Set(), reads: new Set(), firstTouch: new Map(), t0: now }));
  const r = (m.tool_repeats ??= {
    calls: 0,
    duplicate_calls: 0,
    file_reads: 0,
    repeated_file_reads: 0,
    distinct_files_read: 0,
  });
  r.calls++;
  const sig = `${name}:${stableJson(input)}`;
  if (st.sigs.has(sig)) r.duplicate_calls++;
  else if (st.sigs.size < 5000) st.sigs.add(sig);
  const filePath = (input as { file_path?: unknown } | null | undefined)?.file_path;
  const file = typeof filePath === "string" ? String(filePath) : null;
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
    if (changed.some((c) => file === c || file.endsWith(`/${c}`)))
      best = best == null ? ms : Math.min(best, ms);
  return best;
}

interface MetricsContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  is_error?: boolean | null;
}

/** The fields of an SDK message the metrics read. */
interface MetricsMessage {
  type: string;
  subtype?: string;
  uuid?: string;
  model?: unknown;
  parent_tool_use_id?: string | null;
  compact_metadata?: { trigger?: string; pre_tokens?: unknown };
  message?:
    | string
    | {
        id?: unknown;
        model?: unknown;
        usage?: {
          input_tokens?: unknown;
          cache_read_input_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
        } | null;
        content?: string | readonly MetricsContentBlock[];
      };
  num_turns?: number;
  duration_ms?: number;
  usage?: Record<string, unknown> | null;
  total_cost_usd?: unknown;
}

/** Fold one SDK message into the metrics (pure; unit-tested). */
export function accumulateMetrics(m: AgentMetrics, msg: MetricsMessage) {
  const body = typeof msg.message === "object" ? msg.message : undefined;
  // SDK UUIDs identify replayed events; identical un-IDed events may be legitimate separate sessions.
  if (msg.uuid) {
    const seen = seenMessages.get(m) ?? new Set<string>();
    if (seen.has(msg.uuid)) return;
    seen.add(msg.uuid);
    seenMessages.set(m, seen);
  }
  if (msg.type === "system" && msg.subtype === "compact_boundary") {
    // The provider compacted its own session (auto or native mode): measured, not assumed.
    m.compactions = [
      ...(m.compactions ?? []),
      {
        boundary: `native:${msg.compact_metadata?.trigger ?? "auto"}`,
        pressure: null,
        occupancy: validMetric(msg.compact_metadata?.pre_tokens)
          ? msg.compact_metadata.pre_tokens
          : null,
        window: 0,
      },
    ];
  } else if (msg.type === "system" && msg.subtype === "init") {
    m.sessions++;
    if (typeof msg.model === "string" && msg.model) {
      m.model = msg.model;
      stateOf(m).sessionModel = msg.model;
    }
  } else if (msg.type === "assistant") {
    const usage = body?.usage;
    if (!msg.parent_tool_use_id) {
      const st = stateOf(m);
      // Streamed content blocks of one API message share its id: one model turn, however many events.
      st.assistantIds.add(String(body?.id ?? msg.uuid ?? st.assistantIds.size));
      if (typeof body?.model === "string" && body.model) st.apiModels.add(body.model);
    }
    // Subagents have their own context; only the main session's calls measure its occupancy.
    if (usage && !msg.parent_tool_use_id) {
      const occupied = [
        usage.input_tokens,
        usage.cache_read_input_tokens,
        usage.cache_creation_input_tokens,
      ]
        .filter(validMetric)
        .reduce((n: number, v: number) => n + v, 0);
      if (occupied > 0)
        m.context_window = {
          last_tokens: occupied,
          peak_tokens: Math.max(occupied, m.context_window?.peak_tokens ?? 0),
        };
    }
    if (usage && liveRuntime.getStore()) {
      const sum = Object.values(usage)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0)
        .reduce((n, v) => n + v, 0);
      // Every content block of one API message repeats that message's usage: count each message id once.
      const perMessage = streamedUsage.get(m) ?? new Map<string, number>();
      streamedUsage.set(m, perMessage);
      perMessage.set(String(body?.id ?? msg.uuid ?? perMessage.size), sum);
      const total = [...perMessage.values()].reduce((n, v) => n + v, 0);
      liveRuntime.getStore()!.observe(total, null, m);
    }
    const content = body?.content;
    for (const b of typeof content === "string" ? [] : (content ?? []))
      if (b.type === "tool_use") {
        if (!msg.parent_tool_use_id) stateOf(m).toolUses++;
        const name = String(b.name);
        m.tool_calls[name] = (m.tool_calls[name] ?? 0) + 1;
        noteToolUse(m, name, b.input);
      }
  } else if (msg.type === "user" && Array.isArray(body?.content)) {
    for (const b of body.content) if (b.type === "tool_result" && b.is_error) m.tool_errors++;
  } else if (msg.type === "result") {
    stateOf(m).resultSeen = true;
    m.turns += msg.num_turns ?? 0;
    m.duration_ms += msg.duration_ms ?? 0;
    addUsage(m, msg.usage, msg.total_cost_usd);
  }
}

/** Add only fields actually reported. Unknown fields remain null, including optional cache/reasoning usage. */
export function addUsage(m: AgentMetrics, usage?: Record<string, unknown> | null, cost?: unknown) {
  if (validMetric(cost)) m.cost_usd = Math.round(((m.cost_usd ?? 0) + cost) * 1e6) / 1e6;
  if (!usage) {
    observeLiveUsage(m);
    return;
  }
  const fields = {
    input: "input_tokens",
    output: "output_tokens",
    cache_read: "cache_read_input_tokens",
    cache_creation: "cache_creation_input_tokens",
    reasoning_output: "reasoning_output_tokens",
  } as const;
  for (const [key, field] of Object.entries(fields)) {
    const value = usage[field];
    if (!validMetric(value)) continue;
    m.tokens ??= { input: null, output: null, cache_read: null, cache_creation: null };
    const k = key as keyof NonNullable<AgentMetrics["tokens"]>;
    m.tokens[k] = (m.tokens[k] ?? 0) + value;
  }
  observeLiveUsage(m);
}
export function validMetric(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
