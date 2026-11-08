import { z } from "zod";
import { StepAgentConfig, validateAgentOptions, type EffectiveAgent } from "../agent/stepAgent.ts";

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
  equals: z.unknown().optional(),
  /** Match on the step's final status instead of its output (e.g. "COMPLETED": run only if that step ran). */
  status: z.enum(["COMPLETED", "SKIPPED"]).optional(),
}).refine((r) => r.status !== undefined || "equals" in r, { message: "run_if needs `equals` (output match) or `status`" });

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
}).superRefine((step, ctx) => {
  if (step.config.agent === undefined) return;
  if (!["agent", "coding_agent"].includes(step.type)) { ctx.addIssue({ code: "custom", path: ["config", "agent"], message: "agent configuration requires an agent step" }); return; }
  try { validateAgentOptions(StepAgentConfig.parse(step.config.agent)); }
  catch (e) { ctx.addIssue({ code: "custom", path: ["config", "agent"], message: (e as Error).message }); }
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
  /** User-facing prose language for this run. NULL on rows created before the column existed. */
  output_locale?: "vi" | "en" | null;
  /** claude (default, including rows from before the column), cursor or codex. Run default; effective agent settings are pinned per attempt. */
  agent_provider?: "claude" | "cursor" | "codex";
  /** Null only for unassigned legacy rows, which are not runnable. */
  owner_id?: number | null;
  /** Platform instance (machine) whose workers execute this run; null = any instance (legacy rows). */
  worker_instance?: string | null;
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
  run_if: { step: string; path?: string; equals: unknown; status?: "COMPLETED" | "SKIPPED" } | null;
  requires_approval: boolean;
  max_attempts: number;
  retry_backoff_s: number;
  status: StepStatus;
  generation: number;
  attempt_count: number;
  current_attempt_id: number | null;
  agent_override?: unknown;
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
  agent_provider?: "claude" | "codex" | "cursor" | null;
  agent_model?: string | null;
  effective_agent?: EffectiveAgent | null;
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
  | { kind: "waiting_input"; checkpoint?: Record<string, unknown>; questions?: QuestionInput[]; output?: unknown }
  /** Re-execute an upstream step with feedback (its dependants, including this step, are invalidated and rerun). */
  | { kind: "reexecute"; target: string; feedback: string; output?: unknown }
  | { kind: "waiting_approval"; request: Record<string, unknown>; checkpoint?: Record<string, unknown> };
