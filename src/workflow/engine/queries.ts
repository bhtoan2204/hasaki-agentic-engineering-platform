import { planContinuation } from "../replay.ts";
import {
  loadRunDetail,
  loadStepDetail,
  loadOpenApprovals,
  type OwnerScope,
} from "../runRepository.ts";
import { delegationsOf } from "../delegation.ts";
import { EngineError } from "../mutations.ts";
import { config } from "../../config.ts";
import { instanceHealth } from "../../instances.ts";
import { pool, type Db } from "../../db/pool.ts";
import { recoveryEpisodesOf } from "../recovery.ts";
import { decisionsOf } from "../decisions.ts";
import { checkpointView, isRecoverable, latestRecoverable } from "../checkpointView.ts";

/** Run page view with worker state derived from the stored run and steps. */
export async function runDetail(runId: number) {
  const { run, steps, attempts, questions, artifacts, prs, workspaces, checkpoints } =
    await loadRunDetail(runId);
  if (!run) throw new EngineError(`run ${runId} not found`, 404);
  const { wi_id, wi_code, wi_title, wi_source, wi_project, ...row } = run;
  const work_item =
    wi_id != null
      ? { id: wi_id, code: wi_code, title: wi_title, source: wi_source, project: wi_project }
      : null;
  const [worker, decisions, recovery_episodes, delegation] = await Promise.all([
    instanceHealth(row.worker_instance ?? null),
    decisionsOf(runId),
    recoveryEpisodesOf(runId),
    delegationsOf(runId),
  ]);
  const recovery = steps.some((s) => s.status === "WAITING_INPUT" && s.pending_input?.recovery)
    ? "NEEDS_ATTENTION"
    : steps.some((s) => ["READY", "RUNNING"].includes(s.status) && s.pending_input?.recovery)
      ? "RECOVERING"
      : !["COMPLETED", "CANCELED", "FAILED"].includes(row.status) && worker.health !== "ONLINE"
        ? "WAITING_FOR_WORKER"
        : null;
  return {
    ...row,
    worker: {
      ...worker,
      local: row.worker_instance === config.instanceId,
      available: worker.health === "ONLINE",
      recovery,
    },
    steps,
    work_item,
    attempts,
    questions,
    artifacts,
    pull_requests: prs,
    workspaces,
    checkpoints: checkpoints.map((c) => ({
      ...c,
      kind: isRecoverable(String(c.reason)) ? "recoverable" : "note",
    })),
    decisions,
    recovery_episodes,
    delegation,
  };
}

export async function stepDetail(runId: number, stepKey: string) {
  const detail = await loadStepDetail(runId, stepKey);
  if (!detail.step) throw new EngineError(`step "${stepKey}" not found`, 404);
  const step = detail.step;
  // An integrity failure of the wait checkpoint is shown as "no recovery action", never as a read error.
  const [decisions, continuation] = await Promise.all([
    decisionsOf(runId, step.id),
    planContinuation(pool, step).catch(() => null),
  ]);
  const views = detail.checkpoints.map((row) =>
    checkpointView(row, {
      stepGeneration: step.generation,
      attempts: detail.attempts,
      artifacts: detail.artifacts,
      reconciledAt: decisions.filter((d) => d.kind === "reconcile" && d.outcome === "applied"),
    }),
  );
  return {
    ...detail,
    step,
    checkpoint_view: views,
    latest_recoverable: latestRecoverable(views),
    recovery_action: continuation,
    decisions,
  };
}

/**
 * Steps waiting for a human approval (same owner scoping as openQuestions), for the "Questions & approvals" inbox.
 * `quick` = can be decided from the inbox (and Telegram) with approve/reject + comment; repository selection, branch
 * input and fenced provider handoffs need the full step UI. Step outputs are not copied here (they stay in the run).
 */
export async function openApprovals(db: Db = pool, scope?: OwnerScope) {
  const rows = await loadOpenApprovals(db, scope);
  return rows.map(({ request, ...r }) => {
    const req = request ?? {};
    return {
      ...r,
      message: typeof req.message === "string" ? req.message : null,
      risk: req.scope?.risk ?? req.scope?.gate?.fix_risk ?? null,
      gate_missing: Array.isArray(req.scope?.gate?.missing)
        ? req.scope.gate.missing.slice(0, 6)
        : [],
      requires_risk_acknowledgement: req.requires_risk_acknowledgement === true,
      quick:
        !req.select_repositories &&
        !req.ask_branch &&
        !r.provider_handoff &&
        r.step_type !== "git_pull_request",
    };
  });
}
