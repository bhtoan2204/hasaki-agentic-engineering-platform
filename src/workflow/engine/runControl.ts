import { stepsOf } from "../runRepository.ts";
import { advance } from "../progression.ts";
import {
  EngineError,
  lockRun,
  setStepStatus,
  setRunStatus,
  ensureJob,
  cancelStepJobs,
  type AfterCommit,
} from "../mutations.ts";
import { resolveStepAgent, StepAgentOverrideConfig } from "../../agent/stepAgent.ts";
import type pg from "pg";
import { q, one, withTx, json } from "../../db/pool.ts";
import { localJobs } from "../local.ts";
import { runEvents } from "../events.ts";
import type { RunRow, StepRow } from "../types.ts";
import { adoptRun, txThenRun } from "./shared.ts";

export async function pauseRun(runId: number) {
  return txThenRun(runId, async (c) => {
    const run = await lockRun(c, runId);
    if (run.status === "PAUSED") return;
    await setRunStatus(c, run, "PAUSED");
    return;
  });
}

export async function resumeRun(runId: number) {
  return txThenRun(runId, async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    if (run.status !== "PAUSED") throw new EngineError(`run ${runId} is ${run.status}, not PAUSED`);
    await adoptRun(c, runId);
    await setRunStatus(c, run, "RUNNING");
    await advance(c, runId, afterCommit);
    return;
  });
}

export async function cancelRun(runId: number, reason = "canceled by user") {
  return txThenRun(runId, async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    await cancelLockedRun(c, run, afterCommit, reason);
  });
}

/** Cancel a run locked by the caller in the current transaction. */
export async function cancelLockedRun(
  c: pg.PoolClient,
  run: RunRow,
  afterCommit: AfterCommit,
  reason: string,
) {
  if (run.status === "CANCELED") return;
  const aborted: number[] = [];
  for (const s of await stepsOf(c, run.id)) {
    if (["COMPLETED", "SKIPPED", "CANCELED", "FAILED"].includes(s.status)) continue;
    aborted.push(...(await cancelStepJobs(c, s.id, reason)));
    await setStepStatus(c, s, "CANCELED", { finished_at: new Date() }, reason);
  }
  await q(
    c,
    "UPDATE workflow_step_attempts SET status = 'CANCELED', finished_at = now(), error = $2 WHERE run_id = $1 AND status = 'RUNNING'",
    [run.id, json({ message: reason })],
  );
  await q(
    c,
    "UPDATE workflow_questions SET status = 'dismissed' WHERE run_id = $1 AND status = 'open'",
    [run.id],
  );
  await setRunStatus(c, run, "CANCELED", afterCommit, reason);
  afterCommit(() => aborted.forEach((id) => localJobs.abort(id)));
}

/**
 * Step mode: execute one READY step of a PAUSED run now. The run stays paused, so nothing else starts; when the
 * step finishes its dependants become READY and can be run the same way (or the run resumed).
 */
export async function runStepNow(runId: number, stepKey: string) {
  return txThenRun(runId, async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    if (run.status !== "PAUSED")
      throw new EngineError(
        `run is ${run.status}: "run step" is for paused runs (step mode); running runs schedule steps automatically`,
      );
    await adoptRun(c, runId);
    await advance(c, runId, afterCommit);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [
      runId,
      stepKey,
    ]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (s.status !== "READY" && s.status !== "RETRYING")
      throw new EngineError(
        `step "${stepKey}" is ${s.status}; only READY steps can be run (dependencies must be complete)`,
      );
    await ensureJob(c, s);
    await q(
      c,
      "UPDATE workflow_jobs SET force = true, available_at = LEAST(available_at, now()) WHERE step_id = $1 AND status = 'queued'",
      [s.id],
    );
    await runEvents.add(c, runId, "user", `run step ${stepKey} (step mode)`, s.id);
    return;
  });
}

/** Stop a RUNNING step now: its attempt is canceled, the worker is fenced out and aborted; the step becomes FAILED. */
export async function stopStep(runId: number, stepKey: string, reason = "stopped by user") {
  return txThenRun(runId, async (c, afterCommit) => {
    await lockRun(c, runId);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [
      runId,
      stepKey,
    ]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (s.status !== "RUNNING" && s.status !== "RETRYING")
      throw new EngineError(`step "${stepKey}" is ${s.status}, not running`);
    const aborted = await cancelStepJobs(c, s.id, reason);
    await q(
      c,
      "UPDATE workflow_step_attempts SET status = 'CANCELED', finished_at = now(), error = $2 WHERE step_id = $1 AND status = 'RUNNING'",
      [s.id, json({ message: reason })],
    );
    await setStepStatus(c, s, "FAILED", { error: reason, finished_at: new Date() }, reason);
    await runEvents.add(c, runId, "user", `${reason}: ${stepKey}`, s.id);
    afterCommit(() => aborted.forEach((id) => localJobs.abort(id)));
    await advance(c, runId, afterCommit);
    return;
  });
}

export async function skipStep(runId: number, stepKey: string, reason = "skipped by user") {
  return txThenRun(runId, async (c, afterCommit) => {
    await lockRun(c, runId);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [
      runId,
      stepKey,
    ]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (!["PENDING", "READY", "FAILED", "WAITING_INPUT", "WAITING_APPROVAL"].includes(s.status))
      throw new EngineError(`cannot skip a ${s.status} step`);
    const aborted = await cancelStepJobs(c, s.id, reason);
    await q(
      c,
      "UPDATE workflow_questions SET status = 'dismissed' WHERE step_id = $1 AND status = 'open'",
      [s.id],
    );
    await setStepStatus(
      c,
      s,
      "SKIPPED",
      { output: { skipped: true, reason }, finished_at: new Date() },
      reason,
    );
    afterCommit(() => aborted.forEach((id) => localJobs.abort(id)));
    await advance(c, runId, afterCommit);
    return;
  });
}

/** Caller must pass through requireRun; config is server-owned, never read from pending input. */
export async function setStepAgent(runId: number, key: string, value: unknown, actorId: number) {
  return withTx(async (c) => {
    const run = await lockRun(c, runId);
    const step = await one<StepRow>(
      c,
      "SELECT * FROM workflow_steps WHERE run_id=$1 AND key=$2 FOR UPDATE",
      [runId, key],
    );
    if (!step || !["agent", "coding_agent"].includes(step.type))
      throw new EngineError("Agent step required", 400);
    if (
      !["PENDING", "READY", "RETRYING", "FAILED", "CANCELED", "WAITING_INPUT"].includes(
        step.status,
      ) ||
      run.status === "CANCELED"
    )
      throw new EngineError("Only pending or retryable agent steps can be changed", 409);
    let override;
    let effective;
    try {
      override = value === null ? null : StepAgentOverrideConfig.parse(value);
      const baselineTools = step.config.agent?.allowed_tools;
      if (
        baselineTools != null &&
        override &&
        Object.hasOwn(override, "allowed_tools") &&
        (override.allowed_tools == null ||
          override.allowed_tools.some((t) => !baselineTools.includes(t)))
      )
        throw new Error("Manual tool permissions must be a subset of the workflow's allowed_tools");
      effective = resolveStepAgent(run, { ...step, agent_override: override });
    } catch (error) {
      throw new EngineError((error as Error).message, 400);
    }
    await q(c, "UPDATE workflow_steps SET agent_override=$2 WHERE id=$1", [
      step.id,
      override == null ? null : json(override),
    ]);
    await q(
      c,
      `INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES($1,'step.agent_override','run',$2,$3)`,
      [
        actorId,
        String(runId),
        json({ step: key, previous: step.agent_override ?? null, override, effective }),
      ],
    );
    return { agent_override: override, effective_agent: effective };
  });
}
