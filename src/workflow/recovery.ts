import type pg from "pg";
import { config } from "../config.ts";
import { ownsInstance } from "../instances.ts";
import { outputLocale } from "../agent/language.ts";
import { pool, q, one, withTx, json } from "../db/pool.ts";
import { runEvents } from "./events.ts";
import { lockRun, setStepStatus } from "./mutations.ts";
import { advance } from "./progression.ts";
import type { AttemptRow, JobRow, RunRow, StepRow } from "./types.ts";

// Interruption policy is shared by graceful shutdown and lease expiry. Preserve their transaction/lock order.
/**
 * Graceful shutdown uses the same interruption policy as lease expiry: safe control steps requeue, while
 * side-effecting work requires reconciliation. Interruptions do not consume the retry budget; ownership stays pinned.
 * Returns false when the job is no longer ours (fenced out, canceled, re-executed): then nothing is changed.
 */
export async function releaseAttempt(jobId: number, token: number, attemptId: number, reason: string) {
  return withTx(async (c, afterCommit) => {
    const attempt0 = await one<AttemptRow>(c, "SELECT run_id FROM workflow_step_attempts WHERE id = $1", [attemptId]);
    if (!attempt0) return false;
    const run = await lockRun(c, attempt0.run_id);
    const j = await one<JobRow>(c, "SELECT * FROM workflow_jobs WHERE id = $1 FOR UPDATE", [jobId]);
    const attempt = (await one<AttemptRow>(c, "SELECT * FROM workflow_step_attempts WHERE id = $1 FOR UPDATE", [attemptId]))!;
    if (attempt.status !== "RUNNING" || !j || j.status !== "running" || j.fencing_token !== token) return false;
    const step = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1 FOR UPDATE", [attempt.step_id]))!;
    if (run.worker_instance !== config.instanceId || !(await ownsInstance(c))) return false;
    await recoverInterrupted(c, run, step, attempt, j, reason);
    await advance(c, run.id, afterCommit);
    return true;
  });
}

/** Only control steps without external effects can replay automatically. Unknown executors default to reconciliation. */
export function safeRecovery(step: Pick<StepRow, "type" | "config">) {
  return ["condition", "human_input", "human_approval", "task_result_report"].includes(step.type)
    || (step.type === "integration" && ["noop", "select_repositories", "repository_discovery", "benchmark_case"].includes(step.config?.action));
}

async function recoverInterrupted(c: pg.PoolClient, run: RunRow, step: StepRow, attempt: AttemptRow, job: JobRow, reason: string) {
  if (step.current_attempt_id !== attempt.id || step.generation !== attempt.generation || step.status !== "RUNNING") return;
  const safe = safeRecovery(step);
  const cp = await one(c, "SELECT data FROM workflow_checkpoints WHERE attempt_id = $1 ORDER BY id DESC LIMIT 1", [attempt.id]);
  const session = await one(c, "SELECT session_id, cwd FROM agent_sessions WHERE attempt_id = $1 AND provider = $2 AND resumable ORDER BY id DESC LIMIT 1", [attempt.id, attempt.agent_provider ?? run.agent_provider]);
  const checkpoint = { ...(cp?.data ?? {}), ...(session ?? {}), recovery: { kind: safe ? "SAFE_RETRY" : "REQUIRES_RECONCILIATION", reason, from_attempt_id: attempt.id, question_id: null as number | null } };
  await q(c, "UPDATE workflow_step_attempts SET status = $2, error = $3, finished_at = now() WHERE id = $1", [attempt.id, safe ? "STALE" : "WAITING_INPUT", json({ message: reason, interrupted: true })]);
  const pending = { ...(step.pending_input ?? {}), resume: { from_attempt_id: attempt.id, checkpoint }, recovery: checkpoint.recovery };
  const handoff = await one(c, "UPDATE provider_handoffs SET status='BLOCKED',blocked_reason='Worker interrupted before termination could be confirmed' WHERE source_attempt_id=$1 AND status='STOPPING' RETURNING id", [attempt.id]);
  if (handoff) (pending as any).provider_handoff = { id: handoff.id, source_attempt_id: attempt.id, status: "BLOCKED" };
  if (!safe) {
    const en = outputLocale(run) === "en";
    const question = {
      question: en ? `Interrupted ${step.name}: reconcile before continuing.` : `Bước ${step.name} bị gián đoạn: cần đối soát trước khi tiếp tục.`,
      context: en ? "Inspect existing worktrees, checkpoints, provider session and external effects (push/PR/API). Continuing authorizes retry/resume with this state; never discard local changes." : "Kiểm tra worktree, checkpoint, phiên agent và tác động bên ngoài (push/PR/API). Tiếp tục cho phép thử lại/khôi phục từ trạng thái này; không xóa thay đổi cục bộ.",
      options: en ? ["Reconciled — continue", "Stop here"] : ["Đã đối soát — tiếp tục", "Dừng ở đây"],
    };
    const row = await one(c, `INSERT INTO workflow_questions (run_id, step_id, attempt_id, question, context, options)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [run.id, step.id, attempt.id, question.question, question.context, json(question.options)]);
    checkpoint.recovery.question_id = row!.id;
  }
  await q(c, "INSERT INTO workflow_checkpoints (run_id, step_id, attempt_id, reason, data) VALUES ($1, $2, $3, 'waiting_input', $4)", [run.id, step.id, attempt.id, json(checkpoint)]);
  await setStepStatus(c, step, safe ? "READY" : "WAITING_INPUT", { pending_input: pending, attempt_count: Math.max(0, step.attempt_count - 1), error: null }, reason);
  await q(c, `UPDATE workflow_jobs SET status = $2, lease_owner = NULL, lease_expires_at = NULL, fencing_token = fencing_token + 1,
    available_at = now(), last_error = $3, idempotency_key = CASE WHEN $4 THEN idempotency_key ELSE idempotency_key || ':interrupted:' || $5::text END, updated_at = now() WHERE id = $1`, [job.id, safe ? "queued" : "done", reason, safe, attempt.id]);
  await runEvents.add(c, run.id, "system", `${step.key}: interrupted; ${checkpoint.recovery.kind}`, step.id, attempt.id);
}

/**
 * Reconcile expired leases without treating worker availability as a permanent executor failure.
 * A reaper can run anywhere; only the owning instance can execute the resulting work.
 */
export async function reapExpiredLeases() {
  const expired = await q<JobRow>(pool, "SELECT * FROM workflow_jobs WHERE status = 'running' AND lease_expires_at < now() ORDER BY id LIMIT 50");
  let reaped = 0;
  for (const job of expired) {
    await withTx(async (c, afterCommit) => {
      const run = await lockRun(c, job.run_id);
      const j = await one<JobRow>(c, "SELECT * FROM workflow_jobs WHERE id = $1 AND status = 'running' AND lease_expires_at < now() FOR UPDATE", [job.id]);
      if (!j) return;
      reaped++;
      const attempt = await one<AttemptRow>(c, "SELECT * FROM workflow_step_attempts WHERE job_id = $1 AND status = 'RUNNING' FOR UPDATE", [j.id]);
      const step = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1 FOR UPDATE", [j.step_id]))!;
      if (!attempt || step.current_attempt_id !== attempt.id) {
        if (attempt) await q(c, "UPDATE workflow_step_attempts SET status = 'STALE', finished_at = now() WHERE id = $1", [attempt.id]);
        // Claimed but never started (or already superseded): hand the job back.
        await q(c, "UPDATE workflow_jobs SET status = 'queued', fencing_token = fencing_token + 1, lease_owner = NULL, lease_expires_at = NULL, last_error = 'lease expired before start' WHERE id = $1", [j.id]);
        return;
      }
      await recoverInterrupted(c, run, step, attempt, j, `worker lease expired (${j.lease_owner})`);
      await advance(c, run.id, afterCommit);
    });
  }
  return reaped;
}

