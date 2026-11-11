import { q, one, json, type Db } from "../db/pool.ts";
import { notify } from "../notify.ts";
import { isEvaluationRun as isEvaluationTelegramRun } from "../eval/scope.ts";
import { background } from "./background.ts";
import { dispatchRunEffects, effectKindsFor, enqueueRunEffects } from "./effects.ts";
import { runEvents } from "./events.ts";
import { assertRunTransition, assertStepTransition } from "./stateMachine.ts";
import type { RunRow, RunStatus, StepRow, StepStatus } from "./types.ts";

/** Internal mutation primitives. Callers own the transaction and acquire the run lock first.
 * These helpers never acquire a connection or commit; pass the same client through every mutation.
 */
export type AfterCommit = (cb: () => unknown) => void;

export class EngineError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export async function lockRun(c: Db, runId: number): Promise<RunRow> {
  const run = await one<RunRow>(c, "SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE", [runId]);
  if (!run) throw new EngineError(`run ${runId} not found`, 404);
  return run;
}

export const stepsOf = (c: Db, runId: number) => q<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 ORDER BY position", [runId]);

const JSON_COLS = new Set(["output", "pending_input", "approval", "config"]);

async function updateStep(c: Db, step: StepRow, patch: Partial<Record<keyof StepRow | "ready_at" | "started_at" | "finished_at", unknown>>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  await q(
    c,
    `UPDATE workflow_steps SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
    [step.id, ...keys.map((k) => (JSON_COLS.has(k) ? json((patch as any)[k]) : (patch as any)[k]))],
  );
  Object.assign(step, patch);
}

export async function setStepStatus(c: Db, step: StepRow, to: StepStatus, patch: Parameters<typeof updateStep>[2] = {}, note = "") {
  assertStepTransition(step.status, to);
  const from = step.status;
  await updateStep(c, step, { ...patch, status: to });
  if (from !== to) await runEvents.add(c, step.run_id, "status", `${step.key}: ${from} → ${to}${note ? ` (${note})` : ""}`, step.id);
}

export async function setRunStatus(c: Db, run: RunRow, to: RunStatus, afterCommit?: AfterCommit, error: string | null = null) {
  if (run.status === to) return;
  assertRunTransition(run.status, to);
  const from = run.status;
  await q(
    c,
    `UPDATE workflow_runs SET status = $2, error = $3, updated_at = now(),
       started_at = COALESCE(started_at, CASE WHEN $2 = 'RUNNING' THEN now() END),
       finished_at = CASE WHEN $2 IN ('COMPLETED', 'FAILED', 'CANCELED') THEN now() ELSE NULL END
     WHERE id = $1`,
    [run.id, to, error],
  );
  run.status = to;
  await runEvents.add(c, run.id, "status", `run: ${from} → ${to}`);
  if (afterCommit && (to === "COMPLETED" || to === "FAILED" || to === "WAITING")) {
    const icon = { COMPLETED: "✅", FAILED: "❌", WAITING: "⏸️" }[to];
    afterCommit(() => background(`notify run ${run.id}`, () => notify(`${icon} Run #${run.id} ${run.title}: ${to}`, `/runs/${run.id}`)));
    if (to === "COMPLETED" || to === "FAILED") afterCommit(() => background(`private Telegram run ${run.id}`, async () => {
      if (!await isEvaluationTelegramRun(run.id)) await (await import("../telegram/workflow.ts")).notifyTelegramRun(run.id, to);
    }));
  }
  // Summary, outcome, memory and learning are rows in this transaction. The worker deletes a row only
  // after the effect succeeds, so a crash after COMMIT retries instead of dropping them. Cancel used to
  // pass no hook, which skipped summary and outcome entirely.
  await enqueueRunEffects(c, run.id, to);
  if (afterCommit && effectKindsFor(to).length) afterCommit(() => background(`run ${run.id} effects`, () => dispatchRunEffects()));
}

export async function ensureJob(c: Db, step: StepRow, delaySeconds = 0) {
  await q(
    c,
    `INSERT INTO workflow_jobs (run_id, step_id, generation, idempotency_key, available_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5)) ON CONFLICT DO NOTHING`,
    [step.run_id, step.id, step.generation, `step:${step.id}:gen:${step.generation}:n:${step.attempt_count}`, delaySeconds],
  );
}

/** Cancel live jobs of a step and fence out whoever holds them. Returns ids for local abort. */
export async function cancelStepJobs(c: Db, stepId: number, reason: string): Promise<number[]> {
  const rows = await q<{ id: number }>(
    c,
    `UPDATE workflow_jobs SET status = 'canceled', fencing_token = fencing_token + 1, last_error = $2, updated_at = now()
      WHERE step_id = $1 AND status IN ('queued', 'running') RETURNING id`,
    [stepId, reason],
  );
  return rows.map((r) => r.id);
}

