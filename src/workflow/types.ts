import { z } from "zod";

export const STEP_TYPES = [
  "agent",
  "coding_agent",
  "human_input",
  "human_approval",
  "integration",
  "command",
  "condition",
  "git_pull_request",
  "task_result_report",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const STEP_STATUSES = [
  "PENDING",
  "READY",
  "RUNNING",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "RETRYING",
  "CANCELED",
  "SKIPPED",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const RUN_STATUSES = ["PENDING", "RUNNING", "PAUSED", "WAITING", "COMPLETED", "FAILED", "CANCELED"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Gate a step on the output of another step (typically a `condition` step). */
const RunIf = z.object({
  step: z.string(),
  /** Dot path into that step's output; default "result". */
  path: z.string().optional(),
  equals: z.unknown(),
});

export const StepSpec = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "step key must be lowercase [a-z0-9_-]"),
  type: z.enum(STEP_TYPES),
  name: z.string().optional(),
  depends_on: z.array(z.string()).default([]),
  config: z.record(z.string(), z.unknown()).default({}),
  run_if: RunIf.optional(),
  /** Human approval gate before the step runs (e.g. approve before PR creation). */
  requires_approval: z.boolean().default(false),
  max_attempts: z.number().int().min(1).max(10).default(1),
  retry_backoff_seconds: z.number().int().min(0).max(3600).default(5),
  /** Editor-only: node position in the visual builder. */
  ui: z.object({ x: z.number(), y: z.number() }).optional(),
});
export type StepSpec = z.infer<typeof StepSpec>;

export const WorkflowSpec = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  /** Step that receives review feedback ("Nhắn cho agent"); default: first coding_agent step. */
  feedback_step: z.string().optional(),
  /** Inputs the run form asks for (purely descriptive; values land in run.inputs). */
  inputs: z.record(z.string(), z.object({ description: z.string().default(""), required: z.boolean().default(false) })).default({}),
  /** Knowledge item / skill keys applied to every step of this workflow. */
  knowledge: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  steps: z.array(StepSpec).min(1),
});
export type WorkflowSpec = z.infer<typeof WorkflowSpec>;

export interface RunRow {
  id: number;
  definition_version_id: number;
  definition_key: string;
  work_item_id: number | null;
  title: string;
  status: RunStatus;
  inputs: Record<string, unknown>;
  graph: WorkflowSpec;
  allowed_repositories: string[];
  selected_repositories: string[];
  branch: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  profile?: "FAST" | "STANDARD" | "DEEP";
  profile_decision?: unknown;
}

export interface StepRow {
  id: number;
  run_id: number;
  key: string;
  type: StepType;
  name: string;
  position: number;
  depends_on: string[];
  config: Record<string, any>;
  run_if: { step: string; path?: string; equals: unknown } | null;
  requires_approval: boolean;
  max_attempts: number;
  retry_backoff_s: number;
  status: StepStatus;
  generation: number;
  attempt_count: number;
  current_attempt_id: number | null;
  output: any;
  pending_input: any;
  approval: any;
  error: string | null;
}

export interface AttemptRow {
  id: number;
  step_id: number;
  run_id: number;
  number: number;
  generation: number;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "WAITING_INPUT" | "WAITING_APPROVAL" | "CANCELED" | "STALE";
  job_id: number | null;
  fencing_token: number | null;
  input: any;
  output: any;
  context_snapshot_id: number | null;
  agent_session_id: string | null;
  error: any;
  started_at: string;
  finished_at: string | null;
}

export interface JobRow {
  id: number;
  run_id: number;
  step_id: number;
  generation: number;
  idempotency_key: string;
  status: "queued" | "running" | "done" | "failed" | "canceled";
  lease_owner: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
  claims: number;
}

export interface QuestionInput {
  question: string;
  context?: string;
  options?: string[];
  suggested_answer?: string;
}

/** What a step executor reports back. The engine turns it into state transitions. */
export type ExecResult =
  | { kind: "completed"; output: unknown }
  | { kind: "failed"; error: string; retryable?: boolean; details?: unknown }
  | { kind: "waiting_input"; checkpoint?: Record<string, unknown>; questions?: QuestionInput[] }
  | { kind: "waiting_approval"; request: Record<string, unknown>; checkpoint?: Record<string, unknown> };
