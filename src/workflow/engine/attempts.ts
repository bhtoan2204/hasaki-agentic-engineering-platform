import {
  continuationEvidence,
  readExecutionCheckpoint,
  saveExecutionPause,
  validateContinuation,
} from "../checkpoints.ts";
import {
  reapExpiredLeases as reapExpiredJobs,
  markEscalationNotified,
  recoveryForFailure,
} from "../recovery.ts";
import { questionRow } from "../questionOptions.ts";
import { stepsOf } from "../runRepository.ts";
import { advance } from "../progression.ts";
import { budgetPreflight, enforceBudget } from "../budgets.ts";
import { holdForChildren, kickDelegations, planChildWorkflows } from "../delegation.ts";
import { EngineError, lockRun, setStepStatus, ensureJob, type AfterCommit } from "../mutations.ts";
import { applyProfileEscalation } from "../profileRuntime.ts";
import {
  healthSkipReason,
  isUsableAgent,
  nextHealthyProvider,
  probeAgentHealth,
  sharedAgentHealth,
} from "../../agent/health.ts";
import { count } from "../../runtimeMetrics.ts";
import { fallbackPolicy, resolveStepAgent, effectiveStepConfig } from "../../agent/stepAgent.ts";
import { normalizeProviderFailure, safeDiagnostics } from "../../agent/telemetry.ts";
import type pg from "pg";
import { config } from "../../config.ts";
import { ownsInstance, instanceSession } from "../../instances.ts";
import { outputLocale } from "../../agent/language.ts";
import { pool, q, one, withTx, json, type Db } from "../../db/pool.ts";
import { notify, notifyStepWaiting } from "../../notify.ts";
import { classifyFailure } from "../failures.ts";
import { failurePolicy } from "../../agent/harness/failure.ts";
import { background } from "../background.ts";
import { localJobs } from "../local.ts";
import { runEvents } from "../events.ts";
import { buildStepInput, resolveContext } from "../context.ts";
import type {
  AttemptRow,
  ExecResult,
  JobRow,
  QuestionInput,
  RunRow,
  StepRow,
  WorkflowSpec,
} from "../types.ts";
import {
  evaluateGate,
  machineApproval,
  machineApprovalOutput,
  recordClarification,
} from "../autonomy.ts";
import { persistProviderPause } from "./handoff.ts";
import { reexecuteTx } from "./reexecution.ts";
import { setSelectedRepositories } from "./repositorySelection.ts";
import { frozenProviderFlags } from "./shared.ts";
import { type BegunAttempt, type PreparedHandoff } from "./types.ts";

/** What the worker needs to know about a claimed job before the attempt starts (read once, outside the run lock). */
export interface JobPreview {
  type: string;
  config: Record<string, unknown> & { delegation?: { enabled?: unknown } | null };
  agent_override: Record<string, unknown> | null;
  agent_provider: string | null;
  profile: string | null;
  agent_configuration: RunRow["agent_configuration"];
}

export function previewJob(jobId: number) {
  return one<JobPreview>(
    pool,
    `SELECT s.type, s.config, s.agent_override, r.agent_provider, r.profile, r.agent_configuration
       FROM workflow_jobs j
       JOIN workflow_steps s ON s.id = j.step_id
       JOIN workflow_runs r ON r.id = j.run_id
      WHERE j.id = $1`,
    [jobId],
  );
}

/** Probe outside the run lock. A disconnected or quota-exhausted agent is replaced before the attempt starts. */
async function healthyProviderSwitch(jobId: number, known?: JobPreview | null) {
  try {
    const preview = known === undefined ? await previewJob(jobId) : known;
    if (
      !preview ||
      !preview.agent_configuration ||
      !["agent", "coding_agent"].includes(preview.type)
    )
      return null;
    if (preview.config?.delegation?.enabled) return null;
    const policy = fallbackPolicy(preview);
    if (policy.mode === "disabled" || !policy.auto_health) return null;
    const effective = resolveStepAgent(preview, preview);
    if (!effective) return null;
    // The reading shared with chat admission (singleflight, reused up to HEALTH_REUSE_MS, invalidated by provider
    // failures) is enough to keep the chosen provider: the attempt itself still fails closed if it is not ready.
    // Switching away is decided on a fresh probe, never on a reused reading.
    const providers = new Set<string>(policy.providers);
    const shared = (await sharedAgentHealth()).filter((h) => providers.has(h.provider));
    if (isUsableAgent(shared.find((h) => h.provider === effective.provider))) return null;
    count("health.switch_probes");
    const health = await probeAgentHealth(policy.providers);
    const mine = health.find((h) => h.provider === effective.provider);
    if (isUsableAgent(mine)) return null;
    const next = nextHealthyProvider(
      policy.providers,
      new Set([effective.provider]),
      health,
      frozenProviderFlags(preview.agent_configuration),
    );
    if (!next) return null;
    return { from: effective.provider, to: next, reason: healthSkipReason(mine) };
  } catch {
    return null;
  }
}

/** Claim-time validation + attempt creation. Returns null when the job is stale (nothing to do). */
export async function beginAttempt(
  job: JobRow,
  worker: string,
  preview?: JobPreview | null,
): Promise<BegunAttempt | null> {
  const healthSwitch = await healthyProviderSwitch(job.id, preview);
  return withTx(async (c) => {
    const run = await lockRun(c, job.run_id);
    if (run.worker_instance !== config.instanceId || !(await ownsInstance(c))) return null;
    if (run.owner_id == null) {
      await q(
        c,
        "UPDATE workflow_jobs SET status = 'canceled', last_error = 'unassigned owner', updated_at = now() WHERE id = $1",
        [job.id],
      );
      return null;
    }
    const owner = await one<{ active: boolean }>(c, "SELECT active FROM users WHERE id = $1", [
      run.owner_id,
    ]);
    if (!owner?.active) {
      await q(
        c,
        "UPDATE workflow_jobs SET status = 'canceled', last_error = 'owner inactive', updated_at = now() WHERE id = $1",
        [job.id],
      );
      return null;
    }
    const j = await one<JobRow>(
      c,
      "SELECT * FROM workflow_jobs WHERE id = $1 AND lease_expires_at > clock_timestamp() FOR UPDATE",
      [job.id],
    );
    if (!j || j.status !== "running" || j.fencing_token !== job.fencing_token) return null;
    const step = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1 FOR UPDATE", [
      j.step_id,
    ]))!;
    const runnable =
      !["PAUSED", "CANCELED", "PENDING"].includes(run.status) ||
      (run.status === "PAUSED" && j.force === true);
    if (
      step.generation !== j.generation ||
      !["READY", "RETRYING"].includes(step.status) ||
      !runnable
    ) {
      // Paused runs: hand the job back untouched; everything else is stale.
      if (run.status === "PAUSED" && step.generation === j.generation)
        await q(
          c,
          "UPDATE workflow_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1",
          [j.id],
        );
      else
        await q(
          c,
          "UPDATE workflow_jobs SET status = 'canceled', last_error = 'stale job', updated_at = now() WHERE id = $1",
          [j.id],
        );
      return null;
    }
    if (await deferForActiveWork(c, run, step, j)) return null;
    await applyHealthSwitch(c, run, step, healthSwitch);
    const effective = await resolveEffectiveAgent(c, run, step);
    const { n } = (await one<{ n: number }>(
      c,
      "SELECT COALESCE(max(number), 0)::int + 1 AS n FROM workflow_step_attempts WHERE step_id = $1",
      [step.id],
    ))!;
    const contextPreparationStarted = performance.now();
    const input = await buildStepInput(c, run, step);
    await validateContinuation(c, input, step.id, step.generation);
    const context = await resolveContext(c, run, step, input, effective?.provider ?? null);
    const contextPreparationMs = performance.now() - contextPreparationStarted;
    const attempt = (await one<AttemptRow>(
      c,
      `INSERT INTO workflow_step_attempts (step_id, run_id, number, generation, status, job_id, fencing_token, worker, input, context_snapshot_id, metrics, agent_provider, agent_model, effective_agent)
       VALUES ($1, $2, $3, $4, 'RUNNING', $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        step.id,
        run.id,
        n,
        step.generation,
        j.id,
        j.fencing_token,
        worker,
        json(input),
        context.snapshot_id,
        json({ context_preparation_ms: contextPreparationMs }),
        effective?.provider ?? null,
        effective?.model ?? null,
        effective ? json(effective) : null,
      ],
    ))!;
    await linkResumedHandoff(c, step, attempt);
    await setStepStatus(
      c,
      step,
      "RUNNING",
      {
        current_attempt_id: attempt.id,
        attempt_count: step.attempt_count + 1,
        started_at: new Date(),
        error: null,
      },
      `attempt #${n}`,
    );
    return { run, step, attempt, input, context };
  });
}

/**
 * Run lock makes the reader/writer gate durable: queues the job again (and reports true) while other consumers of the shared
 * worktree are active and this step may not run beside them. Runs inside beginAttempt's transaction.
 */
async function deferForActiveWork(
  c: pg.PoolClient,
  run: RunRow,
  step: StepRow,
  j: JobRow,
): Promise<boolean> {
  // Run lock makes this a durable reader/writer gate. Concurrent coding is admitted only when
  // each step will get its own worktree (isolated_workspace and a distinct subtask id). A separate
  // checkout still does not name the files a step may edit, so an empty file list stays queued.
  const consumers = ["agent", "coding_agent", "command", "git_pull_request"];
  const writers = ["coding_agent", "command", "git_pull_request"];
  type ScopeConfig = {
    isolated_workspace?: unknown;
    max_concurrent_subtasks?: unknown;
    scope?: { owned_files?: string[]; repositories?: string[] } | null;
    subtask?: { owned_files?: string[]; target_repos?: string[] } | null;
    owned_files?: string[];
    target_repos?: string[];
  };
  const isolatedCoding = (
    type: string,
    config: ScopeConfig | null | undefined,
    subtaskId: string | null | undefined,
  ) =>
    type === "coding_agent" &&
    config?.isolated_workspace === true &&
    typeof subtaskId === "string" &&
    /^[a-z0-9][a-z0-9_-]*$/.test(subtaskId);
  const filesOf = (config: ScopeConfig | null | undefined): string[] =>
    config?.scope?.owned_files ?? config?.subtask?.owned_files ?? config?.owned_files ?? [];
  const reposOf = (config: ScopeConfig | null | undefined): string[] =>
    config?.scope?.repositories ?? config?.subtask?.target_repos ?? config?.target_repos ?? [];
  if (consumers.includes(step.type)) {
    const active = await q<{
      id: number;
      step_id: number;
      step_type: string;
      config: ScopeConfig;
      subtask_id: string | null;
    }>(
      c,
      `SELECT a.id, s.id AS step_id, s.type AS step_type, s.config, s.subtask_id
         FROM workflow_step_attempts a
         JOIN workflow_steps s ON s.id = a.step_id
         WHERE a.run_id = $1 AND (a.status = 'RUNNING' OR a.job_id = ANY($2::bigint[])) AND s.type = ANY($3::text[])`,
      [run.id, localJobs.activeIds(), consumers],
    );

    if (active.length > 0) {
      const isConcurrentCandidate = isolatedCoding(step.type, step.config, step.subtask_id);

      let conflict = false;
      if (!isConcurrentCandidate) {
        const isWriter = writers.includes(step.type);
        conflict = active.some((a) => isWriter || writers.includes(a.step_type));
      } else {
        const maxConcurrent = Number(step.config?.max_concurrent_subtasks ?? 4);
        if (active.length >= maxConcurrent) {
          conflict = true;
        } else {
          const stepFiles = filesOf(step.config);
          const stepRepos = reposOf(step.config);
          for (const a of active) {
            if (
              !isolatedCoding(a.step_type, a.config, a.subtask_id) ||
              a.subtask_id === step.subtask_id
            ) {
              conflict = true;
              break;
            }
            const activeFiles = filesOf(a.config);
            if (
              stepFiles.length > 0 &&
              activeFiles.length > 0 &&
              stepFiles.some((f) => activeFiles.includes(f))
            ) {
              conflict = true;
              break;
            }
            const activeRepos = reposOf(a.config);
            const disjointRepos =
              stepRepos.length > 0 &&
              activeRepos.length > 0 &&
              !stepRepos.some((r) => activeRepos.includes(r));
            if (!disjointRepos && (stepFiles.length === 0 || activeFiles.length === 0)) {
              conflict = true;
              break;
            }
          }
        }
      }

      if (conflict) {
        await q(
          c,
          "UPDATE workflow_jobs SET status='queued', lease_owner=NULL, lease_expires_at=NULL, available_at=now()+interval '1 second', updated_at=now() WHERE id=$1",
          [j.id],
        );
        return true;
      }
    }
  }
  return false;
}

/** An automatic health switch rewrites the step's provider override before the attempt is created (same transaction). */
async function applyHealthSwitch(
  c: pg.PoolClient,
  run: RunRow,
  step: StepRow,
  healthSwitch: Awaited<ReturnType<typeof healthyProviderSwitch>>,
) {
  if (
    healthSwitch &&
    run.agent_configuration &&
    ["agent", "coding_agent"].includes(step.type) &&
    !step.config.delegation?.enabled
  ) {
    const policy = fallbackPolicy(step);
    const current = resolveStepAgent(run, step);
    if (
      policy.mode !== "disabled" &&
      policy.auto_health &&
      current?.provider === healthSwitch.from &&
      policy.providers.includes(healthSwitch.to)
    ) {
      const override = {
        ...((step.agent_override ?? {}) as object),
        provider: healthSwitch.to,
        model: null,
        reasoning_effort: null,
      };
      await q(c, "UPDATE workflow_steps SET agent_override=$2 WHERE id=$1", [
        step.id,
        json(override),
      ]);
      step.agent_override = override;
      await runEvents.add(
        c,
        run.id,
        "provider_handoff",
        `${healthSwitch.from} skipped (${healthSwitch.reason}); using ${healthSwitch.to}`,
        step.id,
      );
    }
  }
}

/** The agent configuration the attempt will run with (frozen per run, or the previous attempt's for legacy runs); folds it into the step config. */
async function resolveEffectiveAgent(c: pg.PoolClient, run: RunRow, step: StepRow) {
  const previous =
    run.agent_configuration === null
      ? await one<{ effective_agent: AttemptRow["effective_agent"] }>(
          c,
          "SELECT effective_agent FROM workflow_step_attempts WHERE step_id=$1 AND effective_agent IS NOT NULL ORDER BY id DESC LIMIT 1",
          [step.id],
        )
      : null;
  const effective =
    run.agent_configuration === null
      ? (previous?.effective_agent ?? null)
      : resolveStepAgent(run, step);
  step.config = effectiveStepConfig(step.config, effective);
  return effective;
}

/** A resumed provider handoff is linked to the attempt that continues it; a stale link is a 409. */
async function linkResumedHandoff(c: pg.PoolClient, step: StepRow, attempt: AttemptRow) {
  if (step.pending_input?.provider_handoff?.id) {
    const linked = await q(
      c,
      "UPDATE provider_handoffs SET target_attempt_id=$2 WHERE id=$1 AND status='RESUMED' AND target_attempt_id IS NULL AND step_id=$3 AND generation=$4 RETURNING id",
      [step.pending_input.provider_handoff.id, attempt.id, step.id, step.generation],
    );
    if (
      !linked.length &&
      !(await one(
        c,
        "SELECT id FROM provider_handoffs WHERE id=$1 AND step_id=$2 AND generation=$3 AND status='RESUMED' AND target_attempt_id IS NOT NULL",
        [step.pending_input.provider_handoff.id, step.id, step.generation],
      ))
    )
      throw new EngineError("Handoff continuation stale", 409);
  }
}

/** Extend the lease iff we still hold the job. false = fenced out (canceled, re-executed, reaped). */
export async function heartbeat(
  jobId: number,
  token: number,
  leaseSeconds: number,
  attemptId?: number,
) {
  const r = await pool.query(
    `UPDATE workflow_jobs SET lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
      WHERE id = $1 AND fencing_token = $2 AND status = 'running' AND lease_expires_at > clock_timestamp()
        AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id = workflow_jobs.run_id AND r.worker_instance = $4)
        AND NOT EXISTS (SELECT 1 FROM platform_instances i WHERE i.instance_id = $4 AND (i.session_id <> $5 OR i.stopped_at IS NOT NULL))
        AND ($6::int IS NULL OR NOT EXISTS (SELECT 1 FROM provider_handoffs h WHERE h.source_attempt_id = $6 AND h.status = 'STOPPING'))`,
    [jobId, token, leaseSeconds, config.instanceId, instanceSession, attemptId ?? null],
  );
  return r.rowCount === 1;
}

export async function insertQuestions(
  c: Db,
  step: StepRow,
  attemptId: number,
  qs: QuestionInput[],
) {
  for (const x of qs)
    await q(
      c,
      "INSERT INTO workflow_questions (run_id, step_id, attempt_id, question, context, options, suggested_answer) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        step.run_id,
        step.id,
        attemptId,
        x.question,
        x.context ?? "",
        json(questionRow(x).options),
        questionRow(x).suggested,
      ],
    );
}

export function reapExpiredLeases() {
  return reapExpiredJobs(async (c, run, step, attempt, jobId, result, afterCommit) => {
    await applyResult(c, run, step, attempt, jobId, result, afterCommit);
    await enforceBudget(c, run, step.id, attempt.id);
  });
}

async function applyResult(
  c: pg.PoolClient,
  run: RunRow,
  step: StepRow,
  attempt: AttemptRow,
  jobId: number | null,
  result: ExecResult,
  afterCommit: AfterCommit,
) {
  if (result.kind === "failed")
    await q(
      c,
      `UPDATE workflow_step_attempts SET metrics = COALESCE(metrics, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [
        attempt.id,
        json({
          normalized_failure_category: normalizeProviderFailure(result.error),
          failure_diagnostics: safeDiagnostics(result.error),
        }),
      ],
    );

  const now = new Date();
  const closeJob = (status: "done" | "failed", err: string | null = null) =>
    jobId
      ? q(
          c,
          "UPDATE workflow_jobs SET status = $2, last_error = $3, lease_expires_at = NULL, updated_at = now() WHERE id = $1",
          [jobId, status, err],
        )
      : null;
  const closeAttempt = (status: AttemptRow["status"], output: unknown, error: unknown = null) =>
    q(
      c,
      "UPDATE workflow_step_attempts SET status = $2, output = $3, error = $4, finished_at = now() WHERE id = $1",
      [attempt.id, status, json(output), json(error)],
    );

  if (run.profile === "MICRO" && result.kind === "failed") {
    const pending = await one<{ data: import("../types.ts").EscalationRequest }>(
      c,
      "SELECT data FROM workflow_checkpoints WHERE attempt_id=$1 AND reason='profile_escalation_requested' ORDER BY id DESC LIMIT 1",
      [attempt.id],
    );
    result = {
      kind: "profile_escalation",
      request: pending?.data ?? {
        target: "STANDARD",
        risk: "unknown",
        reason: result.error,
        expectedRevision:
          (run.graph as WorkflowSpec & { profile_revision?: number }).profile_revision ?? 0,
      },
    };
  }
  const ctx: ApplyContext = {
    c,
    run,
    step,
    attempt,
    jobId,
    afterCommit,
    now,
    closeJob,
    closeAttempt,
  };
  // A case returns false when it already finished the step itself (recursive applyResult, re-execution) and the
  // run must not be advanced again here.
  let advanceRun = true;
  switch (result.kind) {
    case "profile_escalation":
      advanceRun = await applyProfileEscalationResult(ctx, result);
      break;
    case "completed":
      advanceRun = await applyCompletedResult(ctx, result);
      break;
    case "waiting_input":
      advanceRun = await applyWaitingInputResult(ctx, result);
      break;
    case "waiting_approval":
      advanceRun = await applyWaitingApprovalResult(ctx, result);
      break;
    case "reexecute":
      advanceRun = await applyReexecuteResult(ctx, result);
      break;
    case "failed":
      advanceRun = await applyFailedResult(ctx, result);
      break;
  }
  if (advanceRun) await advance(c, run.id, afterCommit);
}

interface ApplyContext {
  c: pg.PoolClient;
  run: RunRow;
  step: StepRow;
  attempt: AttemptRow;
  jobId: number | null;
  afterCommit: AfterCommit;
  now: Date;
  closeJob: (status: "done" | "failed", err?: string | null) => Promise<unknown> | null;
  closeAttempt: (
    status: AttemptRow["status"],
    output: unknown,
    error?: unknown,
  ) => Promise<unknown>;
}

async function applyProfileEscalationResult(
  x: ApplyContext,
  result: Extract<ExecResult, { kind: "profile_escalation" }>,
): Promise<boolean> {
  const { c, run, step, attempt, jobId, afterCommit } = x;
  const previousGraph = run.graph;
  const previousProfile = run.profile;
  await q(c, "SAVEPOINT profile_transition");
  try {
    await applyProfileEscalation(c, run, step, attempt, result.request);
    await q(c, "RELEASE SAVEPOINT profile_transition");
  } catch (error) {
    await q(c, "ROLLBACK TO SAVEPOINT profile_transition");
    run.graph = previousGraph;
    run.profile = previousProfile;
    await applyResult(
      c,
      run,
      step,
      attempt,
      jobId,
      {
        kind: "waiting_input",
        checkpoint: { profile_transition: result.request },
        questions: [
          {
            question:
              "The profile transition requires reconciliation before execution can continue.",
            context: (error as Error).message,
            options: ["Review the preserved checkpoint and resume"],
          },
        ],
      },
      afterCommit,
    );
    return false;
  }
  return true;
}

async function applyCompletedResult(
  x: ApplyContext,
  result: Extract<ExecResult, { kind: "completed" }>,
): Promise<boolean> {
  const { c, run, step, attempt, afterCommit, now, closeJob, closeAttempt } = x;
  let out = result.output ?? {};
  if (
    typeof out === "object" &&
    "selected_repositories" in out &&
    Array.isArray(out.selected_repositories)
  )
    await setSelectedRepositories(c, run, out.selected_repositories);
  // Workflow-to-workflow delegation: requested children are recorded with this completion (same transaction); a
  // blocking request holds the step until the children finish (workflow/delegation.ts).
  if (
    (step.type === "agent" || step.type === "coding_agent") &&
    out &&
    typeof out === "object" &&
    "child_workflows" in out
  ) {
    const plan = await planChildWorkflows(c, run, step, attempt, out);
    out = plan.output as typeof out;
    if (plan.waitFor) {
      await closeAttempt("WAITING_INPUT", out);
      await holdForChildren(c, step, plan.waitFor, afterCommit);
      await closeJob("done");
      return true;
    }
    afterCommit(() => kickDelegations());
  }
  await closeAttempt("COMPLETED", out);
  await setStepStatus(c, step, "COMPLETED", {
    output: out,
    pending_input: null,
    error: null,
    finished_at: now,
  });
  await closeJob("done");
  return true;
}

async function applyWaitingInputResult(
  x: ApplyContext,
  result: Extract<ExecResult, { kind: "waiting_input" }>,
): Promise<boolean> {
  const { c, run, step, attempt, jobId, afterCommit, closeJob, closeAttempt } = x;
  if (result.questions?.length) await insertQuestions(c, step, attempt.id, result.questions);
  const open = (await one<{ n: number }>(
    c,
    "SELECT count(*)::int AS n FROM workflow_questions WHERE attempt_id = $1 AND status = 'open'",
    [attempt.id],
  ))!.n;
  if (!open) {
    await applyResult(
      c,
      run,
      step,
      attempt,
      jobId,
      { kind: "failed", error: "step requested input but asked no question", retryable: false },
      afterCommit,
    );
    return false;
  }
  await recordClarification(
    c,
    run,
    step,
    await q(
      c,
      "SELECT question, options FROM workflow_questions WHERE attempt_id = $1 AND status = 'open'",
      [attempt.id],
    ),
  );
  await closeAttempt("WAITING_INPUT", result.output ?? null);
  const sealed = await readExecutionCheckpoint(c, attempt.id);
  await saveExecutionPause(
    c,
    attempt.id,
    "waiting_input",
    sealed
      ? {
          ...result.checkpoint,
          // Type-only cast: validate() returns `result` as optional, ExecutionCheckpoint requires it.
          execution: continuationEvidence(sealed as Parameters<typeof continuationEvidence>[0]),
        }
      : (result.checkpoint ?? {}),
  );
  await setStepStatus(
    c,
    step,
    "WAITING_INPUT",
    result.checkpoint?.workspace_recovery
      ? { pending_input: { ...step.pending_input, replay_workspace_recovery: true } }
      : {},
    `${open} question(s)`,
  );
  await closeJob("done");
  const diagnosisSummary = (
    result.output as { diagnosis?: { summary?: string } | null } | null | undefined
  )?.diagnosis?.summary;
  afterCommit(() =>
    background(`notify run ${run.id}`, () => {
      const en = outputLocale(run) === "en";
      return notifyStepWaiting(
        en
          ? `❓ Run #${run.id} (${run.title}) – ${step.name} has ${open} question(s) to answer`
          : `❓ Run #${run.id} (${run.title}) – bước ${step.name} có ${open} câu hỏi cần trả lời`,
        {
          runId: run.id,
          runTitle: run.title,
          stepKey: step.key,
          stepName: step.name,
          status: "WAITING_INPUT",
          detail: diagnosisSummary
            ? `${diagnosisSummary} — ${en ? "choose how to proceed" : "chọn cách xử lý"}`
            : en
              ? `${open} question(s) to answer`
              : `${open} câu hỏi cần trả lời`,
          stepId: step.id,
          generation: step.generation,
          attemptId: attempt.id,
          locale: outputLocale(run),
          ownerId: run.owner_id ?? undefined,
        },
      );
    }),
  );
  return true;
}

async function applyWaitingApprovalResult(
  x: ApplyContext,
  result: Extract<ExecResult, { kind: "waiting_approval" }>,
): Promise<boolean> {
  const { c, run, step, attempt, jobId, afterCommit, now, closeJob, closeAttempt } = x;
  const gate = await evaluateGate(c, run, step, await stepsOf(c, run.id), result.request);
  if (gate?.enforced) {
    step.approval = machineApproval(gate);
    await q(c, "UPDATE workflow_steps SET approval = $2 WHERE id = $1", [
      step.id,
      json(step.approval),
    ]);
    await runEvents.add(
      c,
      run.id,
      "system",
      `${step.key} auto-approved (${gate.mode}): ${gate.reasons.join("; ")}`,
      step.id,
    );
    await applyResult(
      c,
      run,
      step,
      attempt,
      jobId,
      { kind: "completed", output: machineApprovalOutput(gate, result.request) },
      afterCommit,
    );
    return false;
  }
  const request = gate ? { ...(result.request as object), autonomy: gate } : result.request;
  await closeAttempt("WAITING_APPROVAL", request);
  await saveExecutionPause(c, attempt.id, "waiting_approval", result.checkpoint ?? {});
  await setStepStatus(c, step, "WAITING_APPROVAL", {
    approval: { request, generation: step.generation, requested_at: now },
  });
  await closeJob("done");
  afterCommit(() =>
    background(`notify run ${run.id}`, () => {
      const en = outputLocale(run) === "en";
      return notifyStepWaiting(
        en
          ? `✋ Run #${run.id} (${run.title}) – ${step.name} is waiting for approval`
          : `✋ Run #${run.id} (${run.title}) – bước ${step.name} chờ duyệt`,
        {
          runId: run.id,
          runTitle: run.title,
          stepKey: step.key,
          stepName: step.name,
          status: "WAITING_APPROVAL",
          detail: String(
            result.request?.message ??
              (step.type === "task_result_report"
                ? en
                  ? "review the task result report"
                  : "xem lại báo cáo kết quả task"
                : en
                  ? "waiting for approval"
                  : "chờ duyệt"),
          ).slice(0, 300),
          stepId: step.id,
          generation: step.generation,
          attemptId: attempt.id,
          locale: outputLocale(run),
          ownerId: run.owner_id ?? undefined,
        },
      );
    }),
  );
  return true;
}

async function applyReexecuteResult(
  x: ApplyContext,
  result: Extract<ExecResult, { kind: "reexecute" }>,
): Promise<boolean> {
  const { c, run, step, afterCommit, closeJob, closeAttempt } = x;
  // Close this attempt first (it decided), then re-execute the target: this step is downstream and becomes PENDING.
  await closeAttempt("COMPLETED", result.output ?? { reexecute: result.target });
  await closeJob("done");
  await reexecuteTx(
    c,
    run,
    result.target,
    { feedback: result.feedback },
    afterCommit,
    `re-executed by ${step.key} (${result.reason ?? "developer decision after test failure"})`,
  );
  return false;
}

async function applyFailedResult(
  x: ApplyContext,
  result: Extract<ExecResult, { kind: "failed" }>,
): Promise<boolean> {
  const { c, run, step, attempt, afterCommit, now, closeJob, closeAttempt } = x;
  // Workspace-conflict pauses ran no agent turn: they do not consume the retry budget.
  const pauses = await one<{ n: number }>(
    c,
    `SELECT count(*)::int AS n FROM workflow_checkpoints k JOIN workflow_step_attempts a ON a.id = k.attempt_id
          WHERE a.step_id = $1 AND a.generation = $2 AND k.data ? 'workspace_conflict'`,
    [step.id, step.generation],
  );
  const shaped = await recoveryForFailure(
    c,
    run,
    step,
    attempt,
    result,
    classifyFailure(result.error, {
      failureClass: failurePolicy(
        (result.details as { failure_code?: string } | undefined)?.failure_code,
      )?.failureClass,
      executorRetryable: result.retryable,
      attempt: step.attempt_count - (pauses?.n ?? 0),
      maxAttempts: attempt.effective_agent?.retry?.max_attempts ?? step.max_attempts,
      baseBackoff: attempt.effective_agent?.retry?.backoff_seconds ?? step.retry_backoff_s,
    }),
  );
  const decision = shaped.decision;
  await closeAttempt("FAILED", null, {
    message: result.error,
    details: result.details ?? null,
    failure: decision,
  });
  if (decision.action === "human") {
    // Pause instead of failing: the developer resolves the cause and answers; the step then runs again.
    const en = outputLocale(run) === "en";
    await insertQuestions(c, step, attempt.id, [
      {
        question: en
          ? `Step "${step.name}" needs you (${decision.class}): ${result.error.slice(0, 600)}`
          : `Bước "${step.name}" cần bạn xử lý (${decision.class}): ${result.error.slice(0, 600)}`,
        context:
          decision.reason +
          (en
            ? `\nDiagnosis: ${shaped.diagnosis.category}. Work so far is kept (worktree and checkpoint); "Rerun this step" continues from it.`
            : `\nChẩn đoán: ${shaped.diagnosis.category}. Kết quả đã làm được giữ nguyên (worktree và checkpoint); "chạy lại bước" sẽ tiếp tục từ đó.`),
        options: en
          ? ["Rerun this step", "Stop here"]
          : ["Đã xử lý xong — chạy lại bước", "Dừng ở đây"],
      },
    ]);
    await saveExecutionPause(c, attempt.id, "waiting_input", { failure: decision });
    await setStepStatus(c, step, "WAITING_INPUT", {}, `paused: ${decision.class}`);
    await closeJob("done", result.error);
    if (shaped.notify) await markEscalationNotified(c, run.id, step.id);
    if (shaped.notify)
      afterCommit(() =>
        background(`notify run ${run.id}`, () =>
          notifyStepWaiting(
            en
              ? `⏸ Run #${run.id} (${run.title}) – ${step.name} is paused: ${decision.class}`
              : `⏸ Run #${run.id} (${run.title}) – bước ${step.name} tạm dừng: ${decision.class}`,
            {
              runId: run.id,
              runTitle: run.title,
              stepKey: step.key,
              stepName: step.name,
              status: "WAITING_INPUT",
              detail: decision.reason,
              stepId: step.id,
              generation: step.generation,
              attemptId: attempt.id,
              locale: outputLocale(run),
              ownerId: run.owner_id ?? undefined,
            },
          ),
        ),
      );
    return true;
  }
  if (decision.action === "retry") {
    const sealed = ["agent", "coding_agent"].includes(step.type)
      ? await readExecutionCheckpoint(c, attempt.id)
      : undefined;
    await setStepStatus(
      c,
      step,
      "RETRYING",
      {
        error: result.error,
        ...(sealed && {
          pending_input: {
            ...step.pending_input,
            resume: {
              from_attempt_id: attempt.id,
              checkpoint: {
                execution: {
                  ...continuationEvidence(sealed),
                  workspace_reconciliation_required: true,
                },
              },
            },
          },
        }),
      },
      `attempt ${step.attempt_count}/${step.max_attempts} failed (${decision.class}); retry in ${decision.delay_s}s`,
    );
    await closeJob("done", result.error);
    // Automatic retries are budget-checked too: a projected overrun pauses the run (the queued job waits for resume).
    if (step.type === "agent" || step.type === "coding_agent") await budgetPreflight(c, run, step);
    await ensureJob(c, step, decision.delay_s);
  } else {
    await setStepStatus(c, step, "FAILED", { error: result.error, finished_at: now });
    await closeJob("failed", result.error);
    afterCommit(() =>
      background(`notify run ${run.id}`, () =>
        notify(
          `❌ Run #${run.id} (${run.title}) – bước ${step.name} lỗi: ${result.error.slice(0, 300)}`,
          `/runs/${run.id}`,
        ),
      ),
    );
  }
  return true;
}

/**
 * Apply an executor's result. Discarded (attempt marked STALE) if the job was fenced out or the step was
 * re-executed meanwhile — output computed from invalidated context is never written back.
 */
export async function finishAttempt(
  jobId: number,
  token: number,
  attemptId: number,
  result: ExecResult,
  handoff?: PreparedHandoff,
  /** The attempt's run when the caller has it (an attempt never changes run); read from the attempt otherwise. */
  runId?: number,
) {
  return withTx(async (c, afterCommit) => {
    const attempt0 =
      runId != null
        ? { run_id: runId }
        : await one<AttemptRow>(c, "SELECT run_id FROM workflow_step_attempts WHERE id = $1", [
            attemptId,
          ]);
    if (!attempt0) return { applied: false, reason: "attempt not found" };
    const run = await lockRun(c, attempt0.run_id);
    const j = await one<JobRow>(c, "SELECT * FROM workflow_jobs WHERE id = $1 FOR UPDATE", [jobId]);
    const attempt = (await one<AttemptRow>(
      c,
      "SELECT * FROM workflow_step_attempts WHERE id = $1 FOR UPDATE",
      [attemptId],
    ))!;
    if (attempt.status !== "RUNNING")
      return { applied: false, reason: `attempt already ${attempt.status}` };
    const step = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1 FOR UPDATE", [
      attempt.step_id,
    ]))!;
    const live = await one(
      c,
      "SELECT 1 FROM workflow_jobs WHERE id = $1 AND lease_expires_at > clock_timestamp()",
      [jobId],
    );
    const fenced =
      !j ||
      j.id !== attempt.job_id ||
      j.run_id !== run.id ||
      j.step_id !== step.id ||
      j.status !== "running" ||
      j.fencing_token !== token ||
      !live ||
      run.worker_instance !== config.instanceId ||
      !(await ownsInstance(c));
    const stale =
      step.current_attempt_id !== attempt.id ||
      step.generation !== attempt.generation ||
      step.status !== "RUNNING";
    if (fenced && !stale && j?.status === "running") {
      // Keep RUNNING until the reaper reconciles this attempt. Marking it STALE here would strand its RUNNING step.
      return { applied: false, reason: "lease lost (fenced out); awaiting reconciliation" };
    }
    if (fenced || stale) {
      const reason = fenced ? "lease lost (fenced out)" : "step was invalidated while running";
      await q(
        c,
        "UPDATE workflow_step_attempts SET status = 'STALE', output = $2, error = $3, finished_at = now() WHERE id = $1",
        [
          attempt.id,
          json(result.kind === "completed" ? result.output : null),
          json({ message: reason }),
        ],
      );
      await runEvents.add(
        c,
        run.id,
        "system",
        `${step.key}: attempt #${attempt.number} result discarded: ${reason}`,
        step.id,
        attempt.id,
      );
      return { applied: false, reason };
    }
    const request = await one(
      c,
      "SELECT * FROM provider_handoffs WHERE source_attempt_id=$1 AND status='STOPPING' FOR UPDATE",
      [attempt.id],
    );
    // A request may commit after the scheduler inspected the result. Keep that race fail-closed.
    if (request && attempt.executor_stopped_at && !handoff)
      handoff = {
        blocked:
          "Switch request arrived after checkpoint preparation; reinspect the stopped executor's preserved state",
      };
    const microEscalating =
      run.profile === "MICRO" &&
      !request &&
      (result.kind === "profile_escalation" ||
        (result.kind === "failed" && /execution timeout|context.*budget/i.test(result.error)) ||
        !!(await one(
          c,
          "SELECT 1 FROM workflow_checkpoints WHERE attempt_id=$1 AND reason='profile_escalation_requested' LIMIT 1",
          [attempt.id],
        )));
    if (
      !microEscalating &&
      handoff &&
      attempt.executor_stopped_at &&
      (request || handoff.failure)
    ) {
      await persistProviderPause(c, run, step, attempt, j!, result, handoff, request, afterCommit);
    } else {
      await applyResult(c, run, step, attempt, jobId, result, afterCommit);
      await enforceBudget(c, run, step.id, attempt.id);
    }
    return { applied: true };
  });
}
