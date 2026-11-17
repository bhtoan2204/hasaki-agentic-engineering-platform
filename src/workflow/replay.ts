import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  FEATURE_REGRESSION_COMMAND,
  FEATURE_TARGETED_COMMAND,
  PLATFORM_REGRESSION_COMMAND,
  PLATFORM_TARGETED_COMMAND,
  TEST_COMMAND,
} from "./templates.ts";
import { config } from "../config.ts";
import { one, q, type Db } from "../db/pool.ts";
import { checkpointHash, latestWaitCheckpoint, readExecutionCheckpoint } from "./checkpoints.ts";
import { downstream } from "./graph.ts";
import type { AttemptRow, ExecutionFingerprint, RunRow, StepRow } from "./types.ts";

export type ReplayAction =
  "REUSE" | "RESUME" | "RESTORE" | "VERIFY_ONLY" | "REEXECUTE" | "FORCE_REEXECUTE" | "RECONCILE";

const platformVerificationCommands = new Set([
  TEST_COMMAND,
  PLATFORM_TARGETED_COMMAND,
  PLATFORM_REGRESSION_COMMAND,
  FEATURE_TARGETED_COMMAND,
  FEATURE_REGRESSION_COMMAND,
  "go test",
  "go test ./...",
  "go test -json",
  "go test -json ./...",
  "node --test",
  "npm test",
]);
export function isVerificationCommand(cfg: Record<string, unknown>) {
  return (
    cfg.reuse_test_evidence === true ||
    (typeof cfg.command === "string" &&
      (platformVerificationCommands.has(cfg.command) ||
        platformVerificationCommands.has(cfg.command.trim())))
  );
}

type Decision = {
  action: ReplayAction;
  reason: string;
  conditional?: true;
  source_attempt_id?: number;
};

type ReplayStep = Decision & { key: string; status: StepRow["status"]; invalidated: boolean };

function contextOnly(step: StepRow) {
  return (
    step.type === "agent" &&
    step.config.replay === "context_only" &&
    !step.requires_approval &&
    !step.config.independent &&
    !step.config.evaluation_phase &&
    !step.config.action &&
    !step.config.delegation?.enabled
  );
}

export function needsReplayReconciliation(step: StepRow) {
  return (
    step.status === "WAITING_INPUT" &&
    Boolean(
      step.pending_input?.provider_handoff?.status ||
      step.pending_input?.recovery?.kind === "REQUIRES_RECONCILIATION" ||
      step.pending_input?.replay_workspace_recovery === true,
    )
  );
}

export async function planReplay(db: Db, steps: StepRow[], target: StepRow, force: boolean) {
  const affected = downstream(steps, target.key);
  const sources = force
    ? []
    : steps
        .filter((s) => affected.has(s.key) && s.status === "COMPLETED" && contextOnly(s))
        .flatMap((s) => (s.current_attempt_id == null ? [] : [s.current_attempt_id]));
  const available = new Set(
    sources.length
      ? (
          await q<{ id: number }>(
            db,
            `SELECT id FROM workflow_step_attempts WHERE id=ANY($1::bigint[]) AND status='COMPLETED'
      AND invalidated_at IS NULL AND execution_fingerprint @> '{"version":1,"reusable":true}'::jsonb`,
            [sources],
          )
        ).map(({ id }) => id)
      : [],
  );
  return steps.flatMap<ReplayStep>((s) => {
    const invalidated = s.id === target.id || affected.has(s.key);
    if (!invalidated && !["COMPLETED", "SKIPPED"].includes(s.status)) return [];
    const base = { key: s.key, status: s.status, invalidated };
    if (!invalidated)
      return [{ ...base, action: "REUSE", reason: "Outside the replay dependency closure" }];
    if (needsReplayReconciliation(s))
      return [
        {
          ...base,
          action: "RECONCILE",
          reason: "Resolve the current interruption or handoff first",
          invalidated: false,
        },
      ];
    if (s.id === target.id || force)
      return [{ ...base, action: "FORCE_REEXECUTE", reason: "Explicit re-execution requested" }];
    if (s.current_attempt_id != null && available.has(s.current_attempt_id))
      return [
        {
          ...base,
          action: "REUSE",
          conditional: true,
          source_attempt_id: s.current_attempt_id,
          reason:
            "Compare the historical result with fresh resolved inputs after dependencies complete",
        },
      ];
    if (s.type === "command" && !s.requires_approval && isVerificationCommand(s.config))
      return [
        {
          ...base,
          action: "VERIFY_ONLY",
          conditional: true,
          reason: "Reuse only compatible passing test evidence; otherwise run the configured tests",
        },
      ];
    const reason =
      s.requires_approval || s.type.startsWith("human_")
        ? "Approval or human input must be collected for the new generation"
        : contextOnly(s)
          ? "No eligible fingerprint at this generation"
          : "Requires the normal execution and safety gates";
    return [{ ...base, action: "REEXECUTE", reason }];
  });
}

/** Continuation uses existing question, provider handoff and artifact recovery entry points. */
export async function planContinuation(db: Db, step: StepRow): Promise<Decision | null> {
  if (step.status !== "WAITING_INPUT" || step.current_attempt_id == null) return null;
  const wait = await latestWaitCheckpoint(db, step.current_attempt_id);
  if (step.pending_input?.provider_handoff?.status)
    return {
      action: "RECONCILE",
      reason: "Confirm the provider handoff under its existing policy",
    };
  const workspace = wait?.data.workspace_recovery;
  if (workspace && typeof workspace === "object" && "artifact_id" in workspace) {
    const source = await one<{ attempt_id: number }>(
      db,
      `SELECT attempt_id FROM workflow_checkpoints WHERE workspace_artifact_id=$1
        AND run_id=$2 AND step_id=$3 ORDER BY id DESC LIMIT 1`,
      [workspace.artifact_id, step.run_id, step.id],
    );
    if (source && (await readExecutionCheckpoint(db, source.attempt_id)))
      return {
        action: "RESTORE",
        source_attempt_id: source.attempt_id,
        reason: "An encrypted workspace archive is available for operator reconciliation",
      };
    return { action: "RECONCILE", reason: "Inspect the current workspace before continuing" };
  }
  if (needsReplayReconciliation(step))
    return { action: "RECONCILE", reason: "Inspect possible external effects before resuming" };
  if (wait)
    return {
      action: "RESUME",
      source_attempt_id: step.current_attempt_id,
      conditional: true,
      reason:
        "Continue from the wait checkpoint after answers; native sessions must still pass compatibility checks",
    };
  return null;
}

type FingerprintInput = {
  run: unknown;
  work_item: unknown;
  upstream: Record<string, { status: string; output: unknown }>;
  answers: unknown[];
  pending: unknown;
  approval: unknown;
  previous_attempt?: unknown;
  execution_contract?: unknown;
};
type FingerprintContext = {
  knowledge: unknown;
  overridden: unknown;
  disclosure: unknown;
  upstream: { plan: Record<string, { attempt_id: number | null }>; text: unknown };
  fileRefs: unknown;
  unavailableSkills?: unknown[];
};

// Hash values in the same JSON representation PostgreSQL stores, including dates and omitted properties.
const digest = (value: unknown) => checkpointHash(JSON.parse(JSON.stringify(value ?? null)));

// Reuse is local to the prompt, context, and policy implementation that produced the evidence.
const runtimeRevision = (() => {
  try {
    const hash = createHash("sha256");
    for (const path of [
      "../../package-lock.json",
      "../agent/claude.ts",
      "../agent/stepPrompt.ts",
      "../agent/toolPolicy.ts",
      "../agent/platformTools.ts",
      "../context/pack.ts",
      "../context/plan.ts",
      "./context.ts",
    ])
      hash.update(readFileSync(new URL(path, import.meta.url))).update("\0");
    return hash.digest("hex");
  } catch {
    return null;
  }
})();

export async function fingerprintExecution(
  db: Db,
  run: RunRow,
  step: StepRow,
  attempt: AttemptRow,
  input: FingerprintInput,
  context: FingerprintContext,
): Promise<ExecutionFingerprint> {
  const effective = attempt.effective_agent;
  const noRepositoryScope =
    run.selected_repositories.length === 0 && run.allowed_repositories.length === 0;
  const mayReuse =
    runtimeRevision &&
    contextOnly(step) &&
    noRepositoryScope &&
    !input.answers.length &&
    !input.pending &&
    !input.approval &&
    !context.unavailableSkills?.length &&
    Array.isArray(effective?.allowed_tools) &&
    effective.allowed_tools.every((tool) => tool === "platform.submit_result");
  const withoutWorkspace =
    mayReuse &&
    !(await one(db, "SELECT 1 FROM execution_workspaces WHERE run_id=$1 LIMIT 1", [run.id]));
  const parts = {
    inputs: digest([
      input.run,
      input.work_item,
      input.answers,
      input.pending,
      input.approval,
      input.previous_attempt,
    ]),
    upstream: digest(
      Object.fromEntries(
        Object.entries(input.upstream).map(([key, { status, output }]) => [
          key,
          { status, output },
        ]),
      ),
    ),
    configuration: digest([
      run.definition_version_id,
      run.profile,
      step.key,
      step.name,
      step.type,
      step.depends_on,
      step.run_if,
      step.config,
      effective,
    ]),
    knowledge: digest([
      context.knowledge,
      context.overridden,
      context.disclosure,
      context.unavailableSkills,
    ]),
    context: digest([
      context.fileRefs,
      Object.fromEntries(
        Object.entries(context.upstream.plan).map(([key, { attempt_id: _attemptId, ...plan }]) => [
          key,
          plan,
        ]),
      ),
    ]),
    policy: digest([
      run.policy_versions,
      config.organization,
      config.agent.settingSources,
      process.version,
      runtimeRevision,
    ]),
    contract: digest(input.execution_contract),
    workspace: withoutWorkspace ? "none" : "unknown",
  };
  return { version: 1, parts, digest: digest(parts), reusable: Boolean(withoutWorkspace) };
}

export function attachWorkspace(fingerprint: ExecutionFingerprint, workspace: string | undefined) {
  if (!workspace) return fingerprint;
  const parts = { ...fingerprint.parts, workspace };
  return { ...fingerprint, parts, digest: digest(parts), reusable: false };
}

export function replayOutputHash(output: unknown) {
  return digest(output);
}

export function safeReplayOutput(output: unknown) {
  return (
    !!output &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    ![
      "selected_repositories",
      "approval",
      "approved_scope",
      "verification",
      "tested_heads",
      "verified_heads",
      "verdict",
      "risk_acknowledgement",
      "pull_requests",
    ].some((key) => key in output)
  );
}

export async function findReplayResult(db: Db, step: StepRow, fingerprint: ExecutionFingerprint) {
  if (!fingerprint.reusable || step.replay_source_attempt_id == null) return;
  const source = await one<{
    id: number;
    output: unknown;
    execution_fingerprint: ExecutionFingerprint;
  }>(
    db,
    `SELECT a.id,a.output,a.execution_fingerprint FROM workflow_step_attempts a
      WHERE a.id=$1 AND a.run_id=$2 AND a.step_id=$3 AND a.generation=$4 AND a.status='COMPLETED'
        AND NOT EXISTS (SELECT 1 FROM workflow_artifacts w WHERE w.attempt_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM workflow_questions w WHERE w.attempt_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM agent_context_tool_calls c
          WHERE c.attempt_id=a.id AND c.status='ok' AND c.tool NOT IN ('submit_result','platform.submit_result'))`,
    [step.replay_source_attempt_id, step.run_id, step.id, step.generation - 1],
  );
  const prior = source?.execution_fingerprint;
  if (
    source &&
    prior?.version === 1 &&
    prior.reusable &&
    prior.digest === fingerprint.digest &&
    prior.output_hash === replayOutputHash(source.output) &&
    safeReplayOutput(source.output)
  )
    return source;
}

export function verificationReplay(hasCompatibleEvidence: boolean): Decision {
  return hasCompatibleEvidence
    ? {
        action: "REUSE",
        reason:
          "Verification evidence matches workspace, environment, test configuration and policy",
      }
    : { action: "VERIFY_ONLY", reason: "Run verification on the current workspace" };
}
