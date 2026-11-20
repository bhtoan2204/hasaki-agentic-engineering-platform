/** Agent Office: view types. Pure data — no React, so the mapper can be unit-tested under node. */

/** The exact step status model of the backend (src/workflow/types.ts STEP_STATUSES). */
export type StepStatus =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "WAITING_INPUT"
  | "WAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "RETRYING"
  | "CANCELED"
  | "SKIPPED";

/** Logical workflow responsibilities (one character each). Not independent AI workers. */
export type Role = "analyst" | "architect" | "developer" | "tester" | "reviewer" | "pr";

/** What the character's body does — derived from step status only. */
/** "greet" is decorative only (Overview mascot) — the mapper never produces it. */
export type Pose =
  | "idle"
  | "prepare"
  | "work"
  | "ask"
  | "approval"
  | "celebrate"
  | "done"
  | "frustrated"
  | "stopped"
  | "skipped"
  | "greet";

/** What the character's hands do while working — derived from real tool calls / step type. */
export type Activity =
  | "reading"
  | "searching"
  | "typing"
  | "thinking"
  | "writing"
  | "testing"
  | "terminal"
  | "git"
  | "browsing"
  | "delegating"
  | "planning"
  | "asking"
  | "submitting"
  | "sketching"
  | "reviewing"
  | "packaging"
  | "knowledge";

export interface StepLite {
  key: string;
  name: string;
  type: string;
  status: StepStatus | string;
  current_attempt_id?: number | null;
  position?: number;
  agent?: { provider?: string; model?: string | null } | null;
  handoff?: unknown;
  pending_input?: { provider_handoff?: unknown } | null;
  input?: { pending?: { provider_handoff?: unknown } | null } | null;
}
export interface GraphStepLite {
  key: string;
  type: string;
  name?: string;
  depends_on?: string[];
}
export interface AttemptLite {
  id: number;
  step_key: string;
  number: number;
  status: string;
  started_at?: string | null;
  finished_at?: string | null;
  error?: AttemptError;
  /** Attempt metrics (incl. harness `verification`) and output, when the API provides them. */
  metrics?: {
    verification?: AttemptVerification;
    provider?: string;
    model?: string;
    normalized_failure_category?: string;
  } | null;
  output?: { verification?: AttemptVerification } | null;
}
export type AttemptError =
  string | { message?: string; error?: string; failure_category?: string } | null;
export interface AttemptVerification {
  status?: string;
  outcome?: string;
  passed?: boolean;
  needs_review?: boolean;
  rounds?: number;
  repairs?: number;
  max_repairs?: number;
  duration_ms?: number;
  reason?: string;
  review_reasons?: string[];
  last?: Array<{
    repo: string;
    status?: string;
    passed?: boolean;
    regressions?: Array<{ package?: string; tests?: string[] }>;
    weakened?: string[];
    note?: string;
    error?: string;
  }>;
}
export interface QuestionLite {
  step_key: string;
  status: string;
}
export interface EventLite {
  id: number;
  kind: string;
  content: string;
  data?: { name?: string; input?: ToolInput } | null;
  created_at: string;
}
export interface ToolInput {
  file_path?: string;
  notebook_path?: string;
  command?: string;
  pattern?: string;
  path?: string;
  query?: string;
  key?: string;
  name?: string;
  step_key?: string;
  subagent_type?: string;
  url?: string;
  description?: string;
  [key: string]: unknown;
}
export interface RunSummaryLite {
  id: number;
  title: string;
  status: string;
  steps?: Array<{ status: string }> | null;
  updated_at?: string | null;
  created_at?: string | null;
}

/** Everything the office needs from one run (real API data, or the clearly-labelled preview). */
export interface OfficeSnapshot {
  run: {
    id: number;
    title: string;
    status: string;
    branch?: string;
    agent_provider?: string | null;
  } | null;
  steps: StepLite[];
  graph: GraphStepLite[];
  attempts: AttemptLite[];
  questions: QuestionLite[];
  /** Recent transcript events per attempt id (only for attempts the hook fetched). */
  events: Record<number, EventLite[]>;
}

export interface AgentView {
  role: Role;
  /** Step that drives the character now (most relevant of the role's steps), if any. */
  step: StepLite | null;
  /** All steps of this run that belong to the role, in workflow order. */
  steps: StepLite[];
  status: StepStatus | null;
  pose: Pose;
  activity: Activity | null;
  /** Short line for the speech bubble (real data only). */
  bubble: string;
  /** Longer description for tooltip / screen readers. */
  detail: string;
  /** Steps of the role active at the same time (RUNNING/RETRYING/WAITING_*). */
  activeCount: number;
  retrying: boolean;
  openQuestions: number;
  attempt: AttemptLite | null;
  /** ms since the attempt started (running) or its total duration (finished). */
  durationMs: number | null;
}
