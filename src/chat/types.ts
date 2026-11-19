export const CHAT_MODES = ["AUTO", "ASK", "INVESTIGATE", "PLAN", "DELEGATE"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];
export type ManualChatMode = Exclude<ChatMode, "AUTO">;

export type ProviderStrategy = "auto" | "manual";
export type ModelStrategy = "auto" | "provider_default" | "manual";
export type EffortStrategy = "auto" | "provider_default" | "manual";
export type TitleSource = "none" | "fallback" | "generated" | "manual";

export type TurnStatus = "queued" | "running" | "completed" | "failed" | "canceled";
export const ACTIVE_TURN: TurnStatus[] = ["queued", "running"];

export type ChatEventKind =
  | "turn.started"
  | "routing.started"
  | "routing.completed"
  | "provider.health"
  | "provider.selected"
  | "provider.skipped"
  | "provider.attempt_started"
  | "provider.attempt_failed"
  | "provider.fallback"
  | "phase.updated"
  | "context.updated"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "evidence.added"
  | "response.delta"
  | "response.partial"
  | "reasoning.delta"
  | "provider.activity"
  | "operation.updated"
  | "memory.learned"
  | "usage.updated"
  | "turn.completed"
  | "turn.failed"
  | "turn.canceled"
  | "conversation.updated";

export interface ConversationRow {
  id: number;
  owner_id: number;
  title: string;
  title_source: TitleSource;
  description: string;
  mode: ChatMode;
  provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  provider_strategy: ProviderStrategy;
  fallback_enabled: boolean;
  model_strategy: ModelStrategy;
  effort_strategy: EffortStrategy;
  repositories: string[];
  work_item_id: number | null;
  run_id: number | null;
  summary: string;
  summary_through: number;
  budget: Record<string, unknown>;
  usage: Record<string, unknown>;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface TurnRow {
  id: number;
  conversation_id: number;
  owner_id: number;
  client_message_id: string;
  status: TurnStatus;
  mode: ChatMode;
  requested_mode: ChatMode | null;
  effective_mode: string | null;
  route: string | null;
  provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  provider_strategy: string | null;
  requested_provider: string | null;
  effective_provider: string | null;
  requested_model: string | null;
  effective_model: string | null;
  requested_effort: string | null;
  effective_effort: string | null;
  routing: Record<string, unknown>;
  phase: string | null;
  failure: Record<string, unknown> | null;
  attempts: unknown[];
  progress: Record<string, unknown>;
  worker_instance: string | null;
  regenerates: number | null;
  error: string | null;
  metrics: Record<string, unknown>;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  draft: string;
  trace: TraceItem[];
}

/** One entry of a turn's reasoning panel, in the order it happened. */
export type TraceItem =
  | { k: "reasoning"; text: string }
  | { k: "activity"; label: string }
  | { k: "tool"; id: number; tool: string; status: string; ms?: number };

export interface MessageRow {
  id: number;
  conversation_id: number;
  turn_id: number | null;
  role: "user" | "assistant" | "system";
  content: string;
  mentions: Mention[];
  citations: Citation[];
  superseded: boolean;
  created_at: string;
}

export interface ToolCallRow {
  id: number;
  turn_id: number;
  conversation_id: number;
  owner_id: number;
  seq: number;
  tool: string;
  arguments: Record<string, unknown>;
  status: "running" | "ok" | "error" | "denied" | "timeout";
  result: unknown;
  repositories: string[];
  evidence_ref: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  conversation_id: number;
  owner_id: number;
  turn_id: number | null;
  kind: ChatEventKind;
  data: Record<string, unknown>;
  created_at: string;
}

export type MentionKind = "repo" | "file" | "task" | "run" | "knowledge";
export interface Mention {
  kind: MentionKind;
  ref: string;
  resolved: boolean;
  label?: string;
  reason?: string;
}

export interface Citation {
  tool_call_id?: number;
  tool?: string;
  ref: string;
  label: string;
  repository?: string;
}

export interface ChatUsage {
  completions: number;
  tool_calls: number;
  provider_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}
