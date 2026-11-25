import type { Untyped } from "../untyped.ts";
import { z } from "zod";
import {
  StepAgentConfig,
  validateAgentOptions,
  FallbackPolicy,
  type EffectiveAgent,
} from "../agent/stepAgent.ts";

export type Profile = "MICRO" | "FAST" | "STANDARD" | "DEEP";
export type BusinessRisk = "low" | "medium" | "high" | "unknown";

export interface EscalationRequest {
  reason: string;
  risk: BusinessRisk;
  target: Profile;
  expectedRevision: number;
}

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

export const RUN_STATUSES = [
  "PENDING",
  "RUNNING",
  "PAUSED",
  "WAITING",
  "COMPLETED",
  "FAILED",
  "CANCELED",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Gate a step on the output of another step (typically a `condition` step). */
const RunIf = z
  .object({
    step: z.string(),
    /** Dot path into that step's output; default "result". */
    path: z.string().optional(),
    equals: z.unknown().optional(),
    /** Match on the step's final status instead of its output (e.g. "COMPLETED": run only if that step ran). */
    status: z.enum(["COMPLETED", "SKIPPED"]).optional(),
  })
  .refine((r) => r.status !== undefined || "equals" in r, {
    message: "run_if needs `equals` (output match) or `status`",
  });

export const StepSpec = z
  .object({
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
  })
  .superRefine((step, ctx) => {
    if (step.config.fallback !== undefined) {
      const f = FallbackPolicy.safeParse(step.config.fallback);
      if (!f.success)
        ctx.addIssue({
          code: "custom",
          path: ["config", "fallback"],
          message: f.error.message,
        });
    }
    if (step.config.agent === undefined) return;
    if (!["agent", "coding_agent"].includes(step.type)) {
      ctx.addIssue({
        code: "custom",
        path: ["config", "agent"],
        message: "agent configuration requires an agent step",
      });
      return;
    }
    try {
      validateAgentOptions(StepAgentConfig.parse(step.config.agent));
    } catch (e) {
      ctx.addIssue({
        code: "custom",
        path: ["config", "agent"],
        message: (e as Error).message,
      });
    }
  });
export type StepSpec = z.infer<typeof StepSpec>;

export const WorkflowSpec = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  /** Step that receives review feedback ("Nhắn cho agent"); default: first coding_agent step. */
  feedback_step: z.string().optional(),
  /** Step a "re-plan" feedback re-executes (analysis/planning after repository selection); default: derived from the graph. */
  replan_step: z.string().optional(),
  /** Inputs the run form asks for (purely descriptive; values land in run.inputs). */
  inputs: z
    .record(
      z.string(),
      z.object({
        description: z.string().default(""),
        required: z.boolean().default(false),
      }),
    )
    .default({}),
  /** UI grouping, e.g. "Operations / Debugging". */
  category: z.string().max(80).optional(),
  /**
   * read_only: the workflow may not contain steps that change code or external state (coding_agent, command,
   * git_pull_request); its agent steps run with read-only tools only. Enforced by validateSpec.
   * self_development: same steps as standard, but FAST keeps the independent review.
   */
  execution_mode: z.enum(["standard", "read_only", "self_development"]).optional(),
  /** Intent routing: suggest this workflow when a request matches (see investigation/request.ts scoreTriggers). */
  triggers: z
    .object({
      phrases: z.array(z.string().min(2)).min(1),
      requires_any: z.array(z.string()).optional(),
      excludes: z.array(z.string()).optional(),
      explicit: z.array(z.string()).optional(),
    })
    .optional(),
  /** Knowledge item / skill keys applied to every step of this workflow. */
  knowledge: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  steps: z.array(StepSpec).min(1),
});
export type WorkflowSpec = z.infer<typeof WorkflowSpec>;

export interface RunRow {
  agent_configuration?: import("../agent/configuration.ts").AgentConfiguration | null;
  id: number;
  definition_version_id: number;
  definition_key: string;
  work_item_id: number | null;
  /** numeric, as pg returns it */
  budget_usd?: string | null;
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
  profile?: "MICRO" | "FAST" | "STANDARD" | "DEEP";
  profile_decision?: unknown;
  policy_versions?: Record<string, string>;
  /** User-facing prose language for this run. NULL on rows created before the column existed. */
  output_locale?: "vi" | "en" | null;
  /** claude (default, including rows from before the column), cursor, codex or antigravity. Run default; effective agent settings are pinned per attempt. */
  agent_provider?: "claude" | "cursor" | "codex" | "antigravity" | "copilot";
  /** Null only for unassigned legacy rows, which are not runnable. */
  owner_id?: number | null;
  /** Platform instance (machine) whose workers execute this run; null = any instance (legacy rows). */
  worker_instance?: string | null;
  /** Effective autonomy policy frozen at creation; null = MANUAL (legacy rows and runs without a policy). */
  autonomy?: EffectiveAutonomy | null;
}

export const AUTONOMY_MODES = ["MANUAL", "SUPERVISED", "AUTONOMOUS", "AUTOPILOT"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

export interface EffectiveAutonomy {
  version: string;
  requested: AutonomyMode;
  mode: AutonomyMode;
  shadow: boolean;
  gates: string[];
  max_diff_lines: number;
  sources: Array<{ id: number; scope: string; mode: AutonomyMode; revision: number }>;
  downgraded: string[];
  paused?: boolean;
}

export interface StepRow {
  id: number;
  run_id: number;
  key: string;
  type: StepType;
  name: string;
  position: number;
  depends_on: string[];
  config: Record<string, Untyped>;
  run_if: {
    step: string;
    path?: string;
    equals: unknown;
    status?: "COMPLETED" | "SKIPPED";
  } | null;
  requires_approval: boolean;
  max_attempts: number;
  retry_backoff_s: number;
  status: StepStatus;
  generation: number;
  attempt_count: number;
  current_attempt_id: number | null;
  replay_source_attempt_id?: number | null;
  replay_forced?: boolean;
  agent_override?: unknown;
  parent_step_key?: string | null;
  subtask_id?: string | null;
  graph_revision?: number | null;
  output: Untyped;
  pending_input: Untyped;
  approval: Untyped;
  error: string | null;
}

export interface ExecutionFingerprint {
  version: 1;
  parts: Record<string, string>;
  digest: string;
  reusable: boolean;
  output_hash?: string;
}

export interface CheckpointRowInput {
  id: number;
  attempt_id: number | null;
  reason: string;
  data?: Record<string, unknown> | null;
  execution?: {
    version?: number;
    milestone?: string;
    binding?: {
      attempt_id?: number;
      generation?: number;
      snapshot_id?: number | null;
      context_hash?: string | null;
    };
    workspace_fingerprint?: string | null;
    workspace_unavailable?: boolean;
    workspace_artifact_id?: number | null;
    verification?: { digest: string; artifact_ids: number[] } | null;
    artifact_ids?: number[];
    completed_actions?: string[];
  } | null;
  created_at: string | Date;
}

export interface CheckpointAttemptInput {
  id: number;
  generation: number;
  invalidated_at?: unknown;
  metrics?: { verification?: { passed?: boolean } } | null;
}

export interface CheckpointArtifactInput {
  id: number;
  size?: number | string | null;
}

export interface AttemptRow {
  id: number;
  step_id: number;
  run_id: number;
  number: number;
  generation: number;
  status:
    | "RUNNING"
    | "COMPLETED"
    | "FAILED"
    | "WAITING_INPUT"
    | "WAITING_APPROVAL"
    | "CANCELED"
    | "STALE";
  job_id: number | null;
  fencing_token: number | null;
  input: Untyped;
  output: Untyped;
  agent_provider?: "claude" | "codex" | "cursor" | "antigravity" | "copilot" | null;
  agent_model?: string | null;
  effective_agent?: EffectiveAgent | null;
  executor_stopped_at?: string | null;
  context_snapshot_id: number | null;
  agent_session_id: string | null;
  error: Untyped;
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
  force: boolean;
  available_at?: Date | string;
}

export interface QuestionInput {
  question: string;
  context?: string;
  options?: string[];
  suggested_answer?: string;
}

/** What a step executor reports back. The engine turns it into state transitions. */
export type ExecResult =
  | { kind: "profile_escalation"; request: EscalationRequest }
  | { kind: "completed"; output: unknown }
  | { kind: "failed"; error: string; retryable?: boolean; details?: unknown }
  | {
      kind: "waiting_input";
      checkpoint?: Record<string, unknown>;
      questions?: QuestionInput[];
      output?: unknown;
    }
  /** Re-execute an upstream step with feedback (its dependants, including this step, are invalidated and rerun). */
  | { kind: "reexecute"; target: string; feedback: string; output?: unknown; reason?: string }
  | {
      kind: "waiting_approval";
      request: Record<string, unknown>;
      checkpoint?: Record<string, unknown>;
    };
