export const CHAT_MODES = ["ASK", "INVESTIGATE", "PLAN", "DELEGATE"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

export type TurnStatus = "queued" | "running" | "completed" | "failed" | "canceled";
export const ACTIVE_TURN: TurnStatus[] = ["queued", "running"];

export type ChatEventKind =
  | "turn.started"
  | "context.updated"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "evidence.added"
  | "usage.updated"
  | "turn.completed"
  | "turn.failed"
  | "turn.canceled"
  | "conversation.updated";

export interface ConversationRow {
  id: number;
  owner_id: number;
  title: string;
  description: string;
  mode: ChatMode;
  provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
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
  route: string | null;
  provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  worker_instance: string | null;
  regenerates: number | null;
  error: string | null;
  metrics: Record<string, unknown>;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

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

/** Where a statement in an answer came from: a tool call of this conversation, or a resolved mention. */
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
  /** null = at least one provider did not report it: unknown, never zero. */
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}
