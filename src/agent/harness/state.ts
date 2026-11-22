import type { RevisionView } from "../../workflow/sourceRevision.ts";
import type { ExecutionContext } from "../../workflow/executors/registry.ts";
import type { ExecResult } from "../../workflow/types.ts";
import type { EffectiveAgent } from "../stepAgent.ts";
import type { AgentMetrics } from "../metrics.ts";
import type { PolicyContext, ToolMode } from "../toolPolicy.ts";
import type { VerificationRound } from "../verify.ts";
import type { executionWorkspaces, implementationBaseline } from "../implementationEvidence.ts";
import type { liveRuntime } from "../../eval/liveRuntime.ts";
import type { ClaudeTurnInput } from "../claude.ts";
import type { GuaranteeCheck } from "../providerCapabilities.ts";
import type { StageTrace } from "./lifecycle.ts";

export type Workspace = Awaited<ReturnType<typeof executionWorkspaces>>[number];
type Submitted = Record<string, unknown>;

/** What every provider turn returns to the lifecycle. */
export interface TurnResult {
  isError: boolean;
  text: string;
  assistantTurns: number;
  /** Harness failure code or a legacy provider label (see failure.ts). */
  failure?: string;
}

/** Values one stage computes once and later stages read. Fields are set by the stage named in the comment. */
export interface LifecycleState {
  ctx: ExecutionContext;
  trace: StageTrace[];
  live: ReturnType<typeof liveRuntime.getStore>;
  mode: ToolMode;
  // preflight
  effective: EffectiveAgent;
  provider: EffectiveAgent["provider"];
  ws: Workspace[];
  restoreWorkspaces: () => Promise<ExecResult | null>;
  guarantees: GuaranteeCheck;
  /** Source revision per selected repository (pinned for the run; drift when the checkout is elsewhere). */
  revisions?: RevisionView[];
  // context
  policy: PolicyContext;
  delegation: boolean;
  settingSources: Array<"user" | "project" | "local">;
  nativeTools: string[];
  agents: ClaudeTurnInput["agents"];
  routed: { model: string; source: string; effort?: string };
  metrics: AgentMetrics;
  cwd: string;
  independent: boolean;
  // budget
  budget: {
    /** The configured cost policy: "pause" (platform soft pause) or "warn" (events only). */
    action: "pause" | "warn";
    /** Scopes whose overrun was acknowledged by resuming a budget pause. */
    acknowledged: Array<"run" | "work_item">;
    remainingUsd: number | null;
    scopes: Array<"run" | "work_item">;
    enforcement: "between_turns" | "preflight_only";
  };
  /** Where the turn's context came from; set by execute. */
  checkpointSource: "fresh" | "session_resume" | "rebuilt";
  // checkpoint
  implementationStart: Awaited<ReturnType<typeof implementationBaseline>> | null;
  resume: { sessionId: string; fromAttempt?: number } | null;
  reviewKey: string | null;
  baseTips: Record<string, string>;
  incremental: { brief: string; diff: string; attemptId: number } | null;
  evidence: { heads: Record<string, string>; problems: string[]; text: string } | null;
  // execute
  submitted: Submitted | undefined;
  freshPrompt: () => string;
  run: (prompt: string, resumeId?: string) => Promise<TurnResult>;
  result: TurnResult;
  rounds: VerificationRound[];
  openQuestions: () => Promise<boolean>;
  pause: (lastText: string) => Promise<ExecResult>;
  // output
  output: Submitted;
  terminalCodingFailure: (candidate: Submitted | undefined) => ExecResult | null;
  // verify
  unrestored: Map<string, string>;
}

export const newLifecycleState = (ctx: ExecutionContext, live: LifecycleState["live"]) =>
  ({
    ctx,
    live,
    trace: [],
    mode: ctx.step.type === "coding_agent" ? "coding" : "analysis",
    implementationStart: null,
    resume: null,
    reviewKey: null,
    baseTips: {},
    incremental: null,
    evidence: null,
    submitted: undefined,
    unrestored: new Map(),
  }) as Partial<LifecycleState> as LifecycleState;
