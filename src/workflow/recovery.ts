import {
  continuationEvidence,
  latestWaitCheckpoint,
  readExecutionCheckpoint,
  saveExecutionPause,
} from "./checkpoints.ts";
import { traceLog } from "./trace.ts";
import type pg from "pg";
import { config } from "../config.ts";
import { ownsInstance } from "../instances.ts";
import { outputLocale } from "../agent/language.ts";
import { pool, q, one, withTx, json, noteCommitted } from "../db/pool.ts";
import { runEvents } from "./events.ts";
import { JOBS_RUNNABLE, lockRun, setStepStatus, type AfterCommit } from "./mutations.ts";
import { recordDecision } from "./decisions.ts";
import { advance } from "./progression.ts";
import type { AttemptRow, ExecResult, JobRow, RunRow, StepRow } from "./types.ts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { GUARANTEES } from "../agent/providerCapabilities.ts";
import { isolationEnforced } from "../agent/isolation.ts";
import { workspacesOf } from "../git/provider.ts";
import { executionWorkspace } from "../git/workspaceCheckpoint.ts";
import { livePolicy } from "./autonomy.ts";
import { logError } from "../logging.ts";
import {
  diagnoseFailure,
  failureSignature,
  jittered,
  RECOVERY_LIMITS,
  WORK_CATEGORIES,
  type FailureDecision,
  type RecoveryStrategy,
} from "./failures.ts";

const exec = promisify(execFile);

// Interruption policy is shared by graceful shutdown and lease expiry. Preserve their transaction/lock order.
/**
 * Graceful shutdown uses the same interruption policy as lease expiry: safe control steps requeue, while
 * side-effecting work requires reconciliation. Interruptions do not consume the retry budget; ownership stays pinned.
 * Returns false when the job is no longer ours (fenced out, canceled, re-executed): then nothing is changed.
 */
export async function releaseAttempt(
  jobId: number,
  token: number,
  attemptId: number,
  reason: string,
) {
  return withTx(async (c, afterCommit) => {
    const attempt0 = await one<AttemptRow>(
      c,
      "SELECT run_id FROM workflow_step_attempts WHERE id = $1",
      [attemptId],
    );
    if (!attempt0) return false;
    const run = await lockRun(c, attempt0.run_id);
    const j = await one<JobRow>(c, "SELECT * FROM workflow_jobs WHERE id = $1 FOR UPDATE", [jobId]);
    const attempt = (await one<AttemptRow>(
      c,
      "SELECT * FROM workflow_step_attempts WHERE id = $1 FOR UPDATE",
      [attemptId],
    ))!;
    if (
      attempt.status !== "RUNNING" ||
      !j ||
      j.status !== "running" ||
      j.fencing_token !== token ||
      attempt.fencing_token !== token ||
      attempt.job_id !== j.id ||
      attempt.run_id !== j.run_id ||
      attempt.step_id !== j.step_id ||
      attempt.generation !== j.generation
    )
      return false;
    const step = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1 FOR UPDATE", [
      attempt.step_id,
    ]))!;
    if (run.worker_instance !== config.instanceId || !(await ownsInstance(c))) return false;
    await recoverInterrupted(c, run, step, attempt, j, reason);
    await advance(c, run.id, afterCommit);
    return true;
  });
}

/** Only control steps without external effects can replay automatically. Unknown executors default to reconciliation. */
export function safeRecovery(step: Pick<StepRow, "type" | "config">) {
  return (
    ["condition", "human_input", "human_approval", "task_result_report"].includes(step.type) ||
    (step.type === "integration" &&
      ["noop", "select_repositories", "repository_discovery", "benchmark_case"].includes(
        step.config?.action,
      ))
  );
}

async function recoverInterrupted(
  c: pg.PoolClient,
  run: RunRow,
  step: StepRow,
  attempt: AttemptRow,
  job: JobRow,
  reason: string,
) {
  if (
    step.current_attempt_id !== attempt.id ||
    step.generation !== attempt.generation ||
    step.status !== "RUNNING"
  )
    return;
  const safe = safeRecovery(step);
  const auto = safe ? null : await automaticRecovery(c, run, step, attempt, job);
  const resumes = !!auto?.enforce;
  const cp = await latestWaitCheckpoint(c, attempt.id);
  const execution = await readExecutionCheckpoint(c, attempt.id);
  const progress = await one<{ note: string | null }>(
    c,
    "SELECT left(data->>'note', 2000) AS note FROM workflow_checkpoints WHERE attempt_id=$1 AND reason='progress' ORDER BY id DESC LIMIT 1",
    [attempt.id],
  );
  const session = await one(
    c,
    "SELECT session_id, cwd FROM agent_sessions WHERE attempt_id = $1 AND provider = $2 AND resumable ORDER BY id DESC LIMIT 1",
    [attempt.id, attempt.agent_provider ?? run.agent_provider],
  );
  const checkpoint = {
    ...(progress?.note ? { note: progress.note } : {}),
    ...(cp?.data ?? {}),
    ...(session ?? {}),
    recovery: {
      kind: safe ? "SAFE_RETRY" : resumes ? auto!.action : "REQUIRES_RECONCILIATION",
      reason,
      from_attempt_id: attempt.id,
      question_id: null as number | null,
    },
  };
  await q(
    c,
    "UPDATE workflow_step_attempts SET status = $2, error = $3, finished_at = now() WHERE id = $1",
    [
      attempt.id,
      safe || resumes ? "STALE" : "WAITING_INPUT",
      json({ message: reason, interrupted: true }),
    ],
  );
  const pending = {
    ...(step.pending_input ?? {}),
    resume: { from_attempt_id: attempt.id, checkpoint: checkpoint as Record<string, unknown> },
    recovery: checkpoint.recovery,
  };
  const handoff = await one(
    c,
    "UPDATE provider_handoffs SET status='BLOCKED',blocked_reason='Worker interrupted before termination could be confirmed' WHERE source_attempt_id=$1 AND status='STOPPING' RETURNING id",
    [attempt.id],
  );
  if (handoff)
    pending.provider_handoff = {
      id: handoff.id,
      source_attempt_id: attempt.id,
      status: "BLOCKED",
    };
  if (!safe && !resumes) {
    const en = outputLocale(run) === "en";
    const missing = auto?.missing.length
      ? (en ? "\nNot proven automatically: " : "\nPlatform chưa chứng minh được: ") +
        auto.missing.join("; ")
      : "";
    const question = {
      question: en
        ? `Interrupted ${step.name}: reconcile before continuing.`
        : `Bước ${step.name} bị gián đoạn: cần đối soát trước khi tiếp tục.`,
      context:
        (en
          ? "Inspect existing worktrees, checkpoints, provider session and external effects (push/PR/API). Continuing authorizes retry/resume with this state; never discard local changes."
          : "Kiểm tra worktree, checkpoint, phiên agent và tác động bên ngoài (push/PR/API). Tiếp tục cho phép thử lại/khôi phục từ trạng thái này; không xóa thay đổi cục bộ.") +
        missing,
      options: en
        ? ["Reconciled — continue", "Stop here"]
        : ["Đã đối soát — tiếp tục", "Dừng ở đây"],
    };
    const row = await one(
      c,
      `INSERT INTO workflow_questions (run_id, step_id, attempt_id, question, context, options)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [run.id, step.id, attempt.id, question.question, question.context, json(question.options)],
    );
    checkpoint.recovery.question_id = row!.id;
  }
  const sealed = execution
    ? {
        ...checkpoint,
        execution: { ...continuationEvidence(execution), workspace_reconciliation_required: true },
      }
    : checkpoint;
  const pause = await saveExecutionPause(c, attempt.id, "waiting_input", sealed);
  pending.resume.checkpoint =
    !execution && pause ? { ...sealed, execution: continuationEvidence(pause) } : sealed;
  await setStepStatus(
    c,
    step,
    safe || resumes ? "READY" : "WAITING_INPUT",
    { pending_input: pending, attempt_count: Math.max(0, step.attempt_count - 1), error: null },
    reason,
  );
  await q(
    c,
    `UPDATE workflow_jobs SET status = $2, lease_owner = NULL, lease_expires_at = NULL, fencing_token = fencing_token + 1,
    available_at = now(), last_error = $3, idempotency_key = CASE WHEN $4 THEN idempotency_key ELSE idempotency_key || ':interrupted:' || $5::text END, updated_at = now() WHERE id = $1`,
    [job.id, safe || resumes ? "queued" : "done", reason, safe || resumes, attempt.id],
  );
  await runEvents.add(
    c,
    run.id,
    "system",
    `${step.key}: interrupted; ${checkpoint.recovery.kind}`,
    step.id,
    attempt.id,
  );
  const expired = job.lease_expires_at ? new Date(job.lease_expires_at).getTime() : NaN;
  await recordDecision(c, {
    runId: run.id,
    stepId: step.id,
    attemptId: attempt.id,
    generation: attempt.generation,
    kind: "recovery",
    action: checkpoint.recovery.kind,
    outcome: "applied",
    reason,
    // Time from the lost lease to the recovery decision; a graceful release has no expiry to measure from.
    latencyMs: Number.isFinite(expired) && expired <= Date.now() ? Date.now() - expired : null,
    details: {
      question_id: checkpoint.recovery.question_id,
      execution_checkpoint: !!execution,
      wait_checkpoint: !!cp,
      session: !!session,
      handoff_blocked: !!handoff,
      ...(auto
        ? {
            proposed: auto.action,
            shadow: auto.shadow,
            not_proven: auto.missing,
            evidence: auto.evidence,
          }
        : {}),
    },
  });
  if (auto && auto.shadow && !auto.missing.length)
    await recordDecision(c, {
      runId: run.id,
      stepId: step.id,
      attemptId: attempt.id,
      generation: attempt.generation,
      kind: "recovery",
      action: auto.action,
      outcome: "planned",
      reason: "shadow: the recovery proof holds; a human still reconciles",
      details: { evidence: auto.evidence },
    });
}

// ---------------------------------------------------------------- automatic recovery of interrupted work

type AutoRecovery = {
  action: "RESUME" | "RECONCILE";
  /** Every condition holds and the policy enforces (not shadow). */
  enforce: boolean;
  shadow: boolean;
  missing: string[];
  evidence: Record<string, unknown>;
};

/** Live processes whose working directory is inside one of `roots` (Linux /proc); null when it cannot be told. */
export async function processesInside(roots: string[]): Promise<number[] | null> {
  if (process.platform !== "linux" || !roots.length) return roots.length ? null : [];
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  const found: number[] = [];
  for (const e of entries) {
    if (!/^\d+$/.test(e) || Number(e) === process.pid) continue;
    const cwd = await readlink(`/proc/${e}/cwd`).catch(() => null);
    if (cwd && roots.some((r) => cwd === r || cwd.startsWith(`${r}/`))) found.push(Number(e));
  }
  return found;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** HEAD branch and any git operation left half-done (a crash mid-commit/merge/rebase). */
async function worktreeState(path: string) {
  try {
    const branch = (
      await exec("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"])
    ).stdout.trim();
    const head = (await exec("git", ["-C", path, "rev-parse", "HEAD"])).stdout.trim();
    let busy: string | null = null;
    for (const marker of [
      "index.lock",
      "MERGE_HEAD",
      "rebase-merge",
      "rebase-apply",
      "CHERRY_PICK_HEAD",
    ]) {
      const p = (await exec("git", ["-C", path, "rev-parse", "--git-path", marker])).stdout.trim();
      if (existsSync(isAbsolute(p) ? p : join(path, p))) busy = marker;
    }
    return { branch, head, busy };
  } catch {
    return null;
  }
}

/**
 * Stage two of interruption recovery (stage one is safeRecovery for control steps): an agent, coding or PR step may
 * resume or reconcile without a human only when the policy allowlists `recovery` and every fact below is proven.
 * Anything unproven is listed for the human instead. Local changes are never touched here.
 */
async function automaticRecovery(
  c: pg.PoolClient,
  run: RunRow,
  step: StepRow,
  attempt: AttemptRow,
  job: JobRow,
): Promise<AutoRecovery | null> {
  if (!["agent", "coding_agent", "git_pull_request"].includes(step.type)) return null;
  const policy = await livePolicy(c, run);
  if (!policy || policy.mode === "MANUAL" || policy.paused || !policy.gates.includes("recovery"))
    return null;
  const action = step.type === "git_pull_request" ? "RECONCILE" : "RESUME";
  const missing: string[] = [];
  const evidence: Record<string, unknown> = {};
  const workspaces = (await workspacesOf(run.id)).filter(
    (w) => !run.selected_repositories.length || run.selected_repositories.includes(w.repo),
  );
  // 1. The interrupted executor and anything it started are gone (the job is fenced in the same transaction).
  if (!attempt.executor_stopped_at) {
    // Lease owners are "<instance>:<pid>:<nonce>:<lane>" (scheduler.ts).
    const owner = String(job.lease_owner ?? "");
    const pid = owner.startsWith(`${config.instanceId}:`)
      ? Number(owner.slice(config.instanceId.length + 1).split(":")[0])
      : NaN;
    if (!Number.isInteger(pid) || pid <= 0)
      missing.push("the interrupted worker process is unknown");
    else if (pid === process.pid)
      missing.push("the interrupted executor runs in this process and may still be active");
    else if (alive(pid)) missing.push(`the interrupted worker process ${pid} is still alive`);
    const inside = await processesInside(workspaces.map((w) => w.path));
    evidence.processes_in_worktree = inside;
    if (inside === null) missing.push("processes in the worktree cannot be inspected on this host");
    else if (inside.length)
      missing.push(`processes still run in the worktree (pid ${inside.slice(0, 5).join(", ")})`);
  }
  // 2. Each worktree is ours, on the run branch, with no git operation half done.
  const heads: Record<string, string> = {};
  for (const w of workspaces) {
    const state = await worktreeState(w.path);
    if (!state) missing.push(`${w.repo}: worktree unreadable`);
    else {
      heads[w.repo] = state.head;
      if (state.branch !== w.branch)
        missing.push(`${w.repo}: worktree is on ${state.branch}, not ${w.branch}`);
      if (state.busy) missing.push(`${w.repo}: interrupted git operation (${state.busy})`);
    }
  }
  evidence.heads = heads;
  // 3. A sealed checkpoint, if any, is intact and the workspace has not moved since it was sealed.
  const sealed = await one(
    c,
    "SELECT 1 FROM workflow_checkpoints WHERE attempt_id=$1 AND reason='executor_returned'",
    [attempt.id],
  );
  const execution = sealed ? await readExecutionCheckpoint(c, attempt.id) : undefined;
  if (sealed && !execution) missing.push("the execution checkpoint failed integrity validation");
  const current = workspaces.length
    ? await executionWorkspace(run, step).catch(() => null)
    : undefined;
  if (current === null) missing.push("the workspace fingerprint cannot be computed");
  evidence.workspace_fingerprint = current?.fingerprint ?? null;
  if (execution?.workspace_fingerprint && execution.workspace_fingerprint !== current?.fingerprint)
    missing.push("the workspace changed after the checkpoint was sealed");
  // An unattended resume of an agent is unattended write work: only inside the enforced OS sandbox.
  if (action === "RESUME" && !(await isolationEnforced()))
    missing.push(
      "agents do not run in the enforced OS sandbox (isolation.mode): no unattended resume",
    );
  // 4. No uncertain external effect: agents act through the enforced tool policy (no push, no network unless allowed);
  //    a PR step only calls the host's query-then-update operation, keyed by source and target branch.
  if (action === "RESUME") {
    const provider = attempt.agent_provider ?? run.agent_provider ?? "claude";
    if (!GUARANTEES[provider]?.includes("pre_tool_policy"))
      missing.push(`${provider} cannot enforce the tool policy: external effects are unknown`);
    if (step.config?.network === true)
      missing.push("the step may use the network: external effects are unknown");
  }
  if (
    await one(
      c,
      "SELECT 1 FROM provider_handoffs WHERE source_attempt_id=$1 AND status='STOPPING'",
      [attempt.id],
    )
  )
    missing.push("a provider handoff was in progress when the worker stopped");
  // 5. Bounded: a restart, a new attempt or a new generation does not reset the counter.
  const episode = await one<{ auto_recoveries: number }>(
    c,
    "SELECT auto_recoveries FROM recovery_episodes WHERE run_id=$1 AND step_id=$2 AND signature=$3",
    [run.id, step.id, `interrupted:${step.type}`],
  );
  if ((episode?.auto_recoveries ?? 0) >= RECOVERY_LIMITS.interruptedResumes)
    missing.push(`automatic resume limit reached (${RECOVERY_LIMITS.interruptedResumes})`);
  if ((await runRecoveries(c, run.id)) >= RECOVERY_LIMITS.perRun)
    missing.push(`run recovery budget exhausted (${RECOVERY_LIMITS.perRun})`);
  const enforce = !missing.length && !policy.shadow;
  await upsertEpisode(c, run.id, step, attempt, {
    signature: `interrupted:${step.type}`,
    category: "worker_lost",
    strategy: enforce ? action : "WAIT",
    automatic: enforce,
    fingerprint: current?.fingerprint ?? null,
    status: enforce ? "open" : "escalated",
    reason: missing.join("; ") || (policy.shadow ? "shadow" : action),
    evidence,
    nextEligibleAt: null,
  });
  return { action, enforce, shadow: policy.shadow, missing, evidence };
}

async function runRecoveries(c: pg.PoolClient, runId: number) {
  return Number(
    (
      await one<{ n: number }>(
        c,
        "SELECT COALESCE(sum(auto_recoveries), 0)::int AS n FROM recovery_episodes WHERE run_id=$1",
        [runId],
      )
    )?.n ?? 0,
  );
}

async function upsertEpisode(
  c: pg.PoolClient,
  runId: number,
  step: StepRow,
  attempt: AttemptRow,
  e: {
    signature: string;
    category: string;
    strategy: RecoveryStrategy;
    automatic: boolean;
    fingerprint: string | null;
    status: "open" | "escalated" | "stopped";
    reason: string;
    evidence: Record<string, unknown>;
    nextEligibleAt: Date | null;
  },
) {
  return one<{ id: number; occurrences: number; notified_at: string | null }>(
    c,
    `INSERT INTO recovery_episodes (run_id, step_id, signature, category, status, occurrences, auto_recoveries, strategies,
       last_generation, last_attempt_id, last_fingerprint, next_eligible_at, evidence, reason)
     VALUES ($1, $2, $3, $4, $5, 1, $6, jsonb_build_array($7::jsonb), $8, $9, $10, $11, $12, $13)
     ON CONFLICT (run_id, step_id, signature) DO UPDATE SET
       status = EXCLUDED.status, occurrences = recovery_episodes.occurrences + 1,
       auto_recoveries = recovery_episodes.auto_recoveries + EXCLUDED.auto_recoveries,
       strategies = (recovery_episodes.strategies || EXCLUDED.strategies),
       last_generation = EXCLUDED.last_generation, last_attempt_id = EXCLUDED.last_attempt_id,
       last_fingerprint = EXCLUDED.last_fingerprint, next_eligible_at = EXCLUDED.next_eligible_at,
       evidence = EXCLUDED.evidence, reason = EXCLUDED.reason, updated_at = now()
     RETURNING id, occurrences, notified_at`,
    [
      runId,
      step.id,
      e.signature,
      e.category,
      e.status,
      e.automatic ? 1 : 0,
      json({
        strategy: e.strategy,
        attempt_id: attempt.id,
        generation: attempt.generation,
        at: new Date().toISOString(),
      }),
      attempt.generation,
      attempt.id,
      e.fingerprint,
      e.nextEligibleAt,
      json(e.evidence),
      e.reason.slice(0, 2000),
    ],
  );
}

/**
 * Every failed attempt passes here after the step's own classification: the failure is diagnosed (machine code first),
 * bound to an episode, and the retry is shaped — Retry-After honoured with jitter, a repeat of the same failure on an
 * unchanged workspace escalates as no progress, and a run never exceeds its recovery budget. The episode and decision
 * are always recorded; the escalations are enforced only when the run's policy allowlists `recovery` (else shadow).
 */
export async function recoveryForFailure(
  c: pg.PoolClient,
  run: RunRow,
  step: StepRow,
  attempt: AttemptRow,
  result: { error: string; details?: unknown },
  decision: FailureDecision,
) {
  const diagnosis = diagnoseFailure({
    error: result.error,
    failureCode: (result.details as { failure_code?: string } | undefined)?.failure_code,
    details: result.details,
  });
  const signature = failureSignature(diagnosis.category, result.error);
  const execution = ["agent", "coding_agent"].includes(step.type)
    ? await readExecutionCheckpoint(c, attempt.id)
    : undefined;
  const fingerprint = execution?.workspace_fingerprint ?? null;
  const prev = await one<{
    occurrences: number;
    last_fingerprint: string | null;
    notified_at: string | null;
  }>(
    c,
    "SELECT occurrences, last_fingerprint, notified_at FROM recovery_episodes WHERE run_id=$1 AND step_id=$2 AND signature=$3 FOR UPDATE",
    [run.id, step.id, signature],
  );
  const policy = await livePolicy(c, run);
  const enforce =
    !!policy &&
    policy.mode !== "MANUAL" &&
    !policy.paused &&
    policy.gates.includes("recovery") &&
    !policy.shadow;
  let out = decision;
  let proposal: FailureDecision | null = null;
  if (decision.action === "retry") {
    let escalate: string | null = null;
    if (
      WORK_CATEGORIES.includes(diagnosis.category) &&
      prev &&
      prev.last_fingerprint === fingerprint &&
      prev.occurrences + 1 >= RECOVERY_LIMITS.sameSignature
    )
      escalate = `the same ${diagnosis.category} failure happened ${prev.occurrences + 1} times with no change to the workspace or evidence — no progress`;
    else if ((await runRecoveries(c, run.id)) >= RECOVERY_LIMITS.perRun)
      escalate = `the run used its automatic recovery budget (${RECOVERY_LIMITS.perRun})`;
    if (escalate) {
      proposal = { class: "no_progress", action: "human", delay_s: 0, reason: escalate };
      if (enforce) out = proposal;
    }
    if (out.action === "retry")
      out = { ...out, delay_s: jittered(Math.max(decision.delay_s, diagnosis.retry_after_s ?? 0)) };
  }
  const strategy: RecoveryStrategy =
    out.action === "retry"
      ? (["RESUME", "REPAIR", "RETRY_BACKOFF"] as RecoveryStrategy[]).includes(diagnosis.strategy)
        ? diagnosis.strategy
        : "RETRY_BACKOFF"
      : out.action === "human"
        ? "WAIT"
        : "STOP";
  const nextEligibleAt = out.action === "retry" ? new Date(Date.now() + out.delay_s * 1000) : null;
  await upsertEpisode(c, run.id, step, attempt, {
    signature,
    category: diagnosis.category,
    strategy,
    automatic: out.action === "retry",
    fingerprint,
    status: out.action === "retry" ? "open" : out.action === "human" ? "escalated" : "stopped",
    reason: out.reason,
    evidence: { diagnosis, workspace_fingerprint: fingerprint, error: result.error.slice(0, 500) },
    nextEligibleAt,
  });
  await recordDecision(c, {
    runId: run.id,
    stepId: step.id,
    attemptId: attempt.id,
    generation: attempt.generation,
    kind: "recovery",
    action: strategy,
    outcome: "applied",
    reason: out.reason,
    details: {
      category: diagnosis.category,
      source: diagnosis.source,
      attempt: step.attempt_count,
      occurrences: (prev?.occurrences ?? 0) + 1,
      retry_after_s: diagnosis.retry_after_s,
      next_retry_at: nextEligibleAt?.toISOString() ?? null,
      workspace_fingerprint: fingerprint,
      ...(proposal && !enforce ? { shadow_escalation: proposal.reason } : {}),
    },
  });
  return { decision: out, diagnosis, notify: out.action !== "human" || !prev?.notified_at };
}

/** One notification per episode: the escalation is marked once it has been sent. */
export async function markEscalationNotified(c: pg.PoolClient, runId: number, stepId: number) {
  await q(
    c,
    "UPDATE recovery_episodes SET notified_at = now() WHERE run_id=$1 AND step_id=$2 AND status='escalated' AND notified_at IS NULL",
    [runId, stepId],
  );
}

/**
 * Reconcile expired leases without treating worker availability as a permanent executor failure.
 * A reaper can run anywhere; only the owning instance can execute the resulting work.
 */
type ApplyCompleted = (
  db: pg.PoolClient,
  run: RunRow,
  step: StepRow,
  attempt: AttemptRow,
  jobId: number,
  result: Extract<ExecResult, { kind: "completed" }>,
  afterCommit: AfterCommit,
) => Promise<void>;

export async function reapExpiredLeases(applyCompleted: ApplyCompleted) {
  const expired = await q<JobRow>(
    pool,
    "SELECT * FROM workflow_jobs WHERE status = 'running' AND lease_expires_at < now() ORDER BY id LIMIT 50",
  );
  let reaped = 0;
  for (const job of expired) {
    reaped += await withTx(async (c, afterCommit) => {
      const run = await lockRun(c, job.run_id);
      const j = await one<JobRow>(
        c,
        "SELECT * FROM workflow_jobs WHERE id = $1 AND status = 'running' AND lease_expires_at < now() FOR UPDATE",
        [job.id],
      );
      if (!j) return 0;
      const attempt = await one<AttemptRow>(
        c,
        "SELECT * FROM workflow_step_attempts WHERE job_id = $1 AND status = 'RUNNING' FOR UPDATE",
        [j.id],
      );
      const step = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1 FOR UPDATE", [
        j.step_id,
      ]))!;
      if (!attempt || step.current_attempt_id !== attempt.id) {
        if (attempt)
          await q(
            c,
            "UPDATE workflow_step_attempts SET status = 'STALE', finished_at = now() WHERE id = $1",
            [attempt.id],
          );
        // Claimed but never started (or already superseded): hand the job back.
        await q(
          c,
          "UPDATE workflow_jobs SET status = 'queued', fencing_token = fencing_token + 1, lease_owner = NULL, lease_expires_at = NULL, last_error = 'lease expired before start' WHERE id = $1",
          [j.id],
        );
        noteCommitted(c, JOBS_RUNNABLE);
        return 1;
      }
      void traceLog({
        runId: run.id,
        stepId: step.id,
        attemptId: attempt.id,
        level: "WARN",
        event: "lease.expired",
        status: "RECOVERING",
        message: `worker lease expired (${j.lease_owner}); recovering attempt ${attempt.id}`,
        data: {
          job_id: j.id,
          fencing_token: j.fencing_token,
          lease_expires_at: j.lease_expires_at,
        },
      });
      // Only pure control results can commit without operator reconciliation or local workspace access.
      if (
        (step.type === "condition" ||
          (step.type === "integration" && step.config?.action === "noop")) &&
        step.status === "RUNNING" &&
        step.generation === attempt.generation &&
        j.generation === attempt.generation &&
        j.fencing_token === attempt.fencing_token &&
        attempt.executor_stopped_at &&
        run.status !== "CANCELED"
      ) {
        const checkpoint = await readExecutionCheckpoint(c, attempt.id);
        if (
          checkpoint?.result?.kind === "completed" &&
          !checkpoint.workspace_fingerprint &&
          !checkpoint.workspace_unavailable &&
          !(await one(
            c,
            "SELECT 1 FROM provider_handoffs WHERE source_attempt_id=$1 AND status='STOPPING'",
            [attempt.id],
          ))
        ) {
          await applyCompleted(c, run, step, attempt, j.id, checkpoint.result, afterCommit);
          await runEvents.add(
            c,
            run.id,
            "system",
            "Recovered sealed executor result",
            step.id,
            attempt.id,
          );
          return 1;
        }
      }
      await recoverInterrupted(c, run, step, attempt, j, `worker lease expired (${j.lease_owner})`);
      await advance(c, run.id, afterCommit);
      return 1;
    }).catch((error) => {
      logError("workflow.lease_recovery_failed", "Expired job recovery failed", error, {
        job_id: job.id,
        run_id: job.run_id,
        step_id: job.step_id,
        worker_id: job.lease_owner,
      });
      return 0;
    });
  }
  return reaped;
}

/** Recovery episodes of a run for the run view and trace (newest first; bounded). */
export function recoveryEpisodesOf(runId: number) {
  return q(
    pool,
    `SELECT e.id, s.key AS step_key, e.category, e.status, e.occurrences, e.auto_recoveries,
            e.strategies -> -1 AS last_strategy, e.last_generation, e.last_attempt_id, e.next_eligible_at,
            e.reason, e.notified_at, e.updated_at
       FROM recovery_episodes e JOIN workflow_steps s ON s.id = e.step_id
      WHERE e.run_id = $1 ORDER BY e.updated_at DESC LIMIT 50`,
    [runId],
  );
}
