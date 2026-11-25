import { needsReplayReconciliation, planContinuation, planReplay } from "../replay.ts";
import { findRun, stepsOf } from "../runRepository.ts";
import { existsSync } from "node:fs";
import { advance } from "../progression.ts";
import {
  EngineError,
  lockRun,
  setStepStatus,
  setRunStatus,
  cancelStepJobs,
  type AfterCommit,
} from "../mutations.ts";
import { observe } from "../../runtimeMetrics.ts";
import { allWorkspacesOf } from "../../git/provider.ts";
import { pool, q, one, json, type Db } from "../../db/pool.ts";
import { downstream } from "../graph.ts";
import {
  classificationPrompt,
  decideFeedbackRoute,
  FEEDBACK_MODES,
  feedbackSignals,
  heuristicJudgement,
  parseJudgement,
  replanAnchors,
  routeTargets,
  type FeedbackJudgement,
  type FeedbackMode,
} from "../replan.ts";
import { snapshotUncommitted } from "../../git.ts";
import { localJobs } from "../local.ts";
import { runEvents } from "../events.ts";
import { DONE, RETRYABLE } from "../stateMachine.ts";
import type { RunRow } from "../types.ts";
import { recordDecision, savingsFrom } from "../decisions.ts";
import { adoptRun, getRun, txThenRun } from "./shared.ts";

// ---------------------------------------------------------------- re-execution

/**
 * Re-execute `stepKey`: bump its generation, make it READY, and reset every transitive dependant to PENDING
 * (their outputs were derived from context that is now stale). Steps that are not downstream keep their
 * results — e.g. retrying implementation reuses the completed analysis and plan.
 */
export async function reexecuteTx(
  c: Db,
  run: RunRow,
  stepKey: string,
  pending: Record<string, unknown> | null,
  afterCommit: AfterCommit,
  why: string,
  /** Pending input for specific invalidated dependants (e.g. "rediscover" for the discovery step). */
  dependantInput?: Record<string, Record<string, unknown>>,
  force = false,
) {
  if (run.status === "CANCELED") throw new EngineError("run is canceled");
  const steps = await stepsOf(c, run.id);
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const target = byKey.get(stepKey);
  if (!target) throw new EngineError(`step "${stepKey}" not found`, 404);
  if (target.pending_input?.provider_handoff?.source_attempt_id === target.current_attempt_id)
    throw new EngineError("Review and confirm the pending provider handoff", 409);
  if (needsReplayReconciliation(target))
    throw new EngineError("Resolve the current execution reconciliation before re-executing", 409);
  if (!RETRYABLE.includes(target.status))
    throw new EngineError(
      `step "${stepKey}" is ${target.status}; only ${RETRYABLE.join("/")} steps can be re-executed`,
    );
  const blocked = target.depends_on.filter((d) => !DONE.includes(byKey.get(d)!.status));
  if (blocked.length) throw new EngineError(`upstream steps not complete: ${blocked.join(", ")}`);

  const planning = performance.now();
  const plan = await planReplay(c, steps, target, force);
  observe("workflow.replay_plan_ms", performance.now() - planning);
  const blockedReplay = plan.find((item) => item.action === "RECONCILE");
  if (blockedReplay)
    throw new EngineError(
      `Reconcile step "${blockedReplay.key}" before replaying its dependencies`,
      409,
    );
  for (const item of plan) {
    const s = byKey.get(item.key)!;
    await recordDecision(c, {
      runId: run.id,
      stepId: s.id,
      attemptId: s.current_attempt_id,
      generation: s.generation,
      kind: "replay",
      action: item.action,
      outcome: "planned",
      reason: item.reason,
      sourceAttemptId: item.source_attempt_id ?? null,
      details: {
        target: stepKey,
        conditional: !!item.conditional,
        invalidated: item.invalidated,
        force,
      },
    });
  }
  // Every invalidated dependant, then the target, in plan order. Their jobs, running attempts and open questions are
  // fenced in one statement each (same transaction, run locked); each step's own transition and event follow in order.
  const invalidated = [
    ...plan
      .filter((item) => item.invalidated && item.key !== stepKey)
      .map((item) => ({
        s: byKey.get(item.key)!,
        to: "PENDING" as const,
        forced: item.action === "FORCE_REEXECUTE",
        candidate: item.source_attempt_id as number | undefined,
      })),
    {
      s: target,
      to: target.requires_approval ? ("PENDING" as const) : ("READY" as const),
      forced: true,
      candidate: undefined,
    },
  ];
  const ids = invalidated.map(({ s }) => s.id);
  const aborted = await cancelStepJobs(c, ids, `invalidated by re-execution of ${stepKey}`);
  await q(
    c,
    "UPDATE workflow_step_attempts SET status = 'CANCELED', finished_at = now() WHERE step_id = ANY($1::bigint[]) AND status = 'RUNNING'",
    [ids],
  );
  await q(
    c,
    "UPDATE workflow_step_attempts SET invalidated_at = now() WHERE step_id = ANY($1::bigint[]) AND invalidated_at IS NULL",
    [ids],
  );
  await q(
    c,
    "UPDATE workflow_questions SET status = 'dismissed' WHERE step_id = ANY($1::bigint[]) AND status = 'open'",
    [ids],
  );
  for (const { s, to, forced, candidate } of invalidated)
    await setStepStatus(
      c,
      s,
      to,
      {
        generation: s.generation + 1,
        attempt_count: 0,
        current_attempt_id: null,
        replay_source_attempt_id: candidate ?? null,
        replay_forced: forced,
        output: null,
        error: null,
        approval: null,
        pending_input: s === target ? pending : (dependantInput?.[s.key] ?? null),
        ready_at: to === "READY" ? new Date() : null,
        finished_at: null,
      },
      s === target
        ? why
        : `invalidated by ${stepKey}${candidate ? "; compare result at dispatch" : ""}`,
    );
  if (run.status !== "PAUSED") await setRunStatus(c, run, "RUNNING");
  afterCommit(() => aborted.forEach((id) => localJobs.abort(id)));
  await advance(c, run.id, afterCommit);
}

export async function previewReplay(runId: number, stepKey: string, force = false) {
  const run = await findRun(runId);
  if (!run) throw new EngineError(`run ${runId} not found`, 404);
  const steps = await stepsOf(pool, runId);
  const target = steps.find((s) => s.key === stepKey);
  if (!target) throw new EngineError(`step "${stepKey}" not found`, 404);
  const stepsByKey = new Map(steps.map((s) => [s.key, s]));
  const plan = await planReplay(pool, steps, target, force);
  // Estimated work a reuse would avoid: what the reused attempt reported when it ran.
  const withEstimates = await Promise.all(
    plan.map(async (item) => ({
      ...item,
      estimate:
        item.action === "REUSE" && item.source_attempt_id
          ? await savingsFrom(pool, item.source_attempt_id)
          : null,
    })),
  );
  const summary: Record<string, number> = {};
  for (const item of plan) summary[item.action] = (summary[item.action] ?? 0) + 1;
  const sum = (field: "invocations" | "tokens" | "cost_usd") => {
    const known = withEstimates
      .map((i) => i.estimate?.[field])
      .filter((v): v is number => v != null);
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };
  return {
    can_reexecute:
      run.status !== "CANCELED" &&
      RETRYABLE.includes(target.status) &&
      !plan.some((item) => item.action === "RECONCILE") &&
      target.depends_on.every((key) => DONE.includes(stepsByKey.get(key)!.status)),
    continuation: await planContinuation(pool, target),
    steps: withEstimates,
    summary: {
      actions: summary,
      estimated_avoided: {
        invocations: sum("invocations"),
        tokens: sum("tokens"),
        cost_usd: sum("cost_usd"),
      },
    },
  };
}

/**
 * Re-execute a step, optionally with developer instructions and extra skills for THIS re-execution only. Skills are
 * pinned to their current version and stored with the instructions in the step's pending input before anything is
 * enqueued, so a worker restart or a job retry uses exactly the same input. Templates and default prompts are untouched.
 */
export async function reexecuteStep(
  runId: number,
  stepKey: string,
  opts: {
    input?: Record<string, unknown>;
    feedback?: string;
    skills?: string[];
    by?: string;
    /** Keep the instructions as a developer decision for every later step of the run (default true). */
    persist?: boolean;
    /** Internal retry continuation; authorization and observed evidence remain bound to the source attempt. */
    retry?: boolean;
    /** Disable result reuse throughout this replay dependency closure. */
    force?: boolean;
  } = {},
) {
  return txThenRun(runId, async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    const feedback = opts.feedback?.trim() || undefined;
    const keys = [...new Set((opts.skills ?? []).map(String).filter(Boolean))];
    // Only skills the run can actually load: enabled, and shared or owned by the run owner (resolution applies the
    // same rule; anything else would be pinned and then silently dropped).
    const pinnedNew = keys.length
      ? await q<{ key: string; version: number; title: string }>(
          c,
          `SELECT DISTINCT ON (key) key, current_version AS version, title FROM knowledge_items
            WHERE key = ANY($1) AND enabled AND (owner_id IS NULL OR owner_id = $2)
            ORDER BY key, (owner_id IS NULL)`,
          [keys, run.owner_id ?? null],
        )
      : [];
    const unknown = keys.filter((k) => !pinnedNew.some((p) => p.key === k));
    if (unknown.length)
      throw new EngineError(
        `unknown skill(s) or not available to this run (disabled or private to another user): ${unknown.join(", ")}`,
        400,
      );
    // A retry or feedback without a skill choice keeps the skills pinned for the current re-execution.
    const current = await one<{
      pending_input: { reexecute?: { skills?: unknown } | null } | null;
    }>(c, "SELECT pending_input FROM workflow_steps WHERE run_id = $1 AND key = $2", [
      runId,
      stepKey,
    ]);
    const pinned = keys.length
      ? pinnedNew
      : ((current?.pending_input?.reexecute?.skills ?? []) as typeof pinnedNew);
    const reexecute =
      feedback || pinned.length
        ? {
            instructions: feedback ?? null,
            skills: pinned,
            requested_by: opts.by ?? "",
            at: new Date().toISOString(),
          }
        : null;
    const retrySource = opts.retry
      ? await one<{ current_attempt_id: number | null; status: string }>(
          c,
          "SELECT current_attempt_id,status FROM workflow_steps WHERE run_id=$1 AND key=$2",
          [runId, stepKey],
        )
      : null;
    const retry =
      retrySource?.current_attempt_id &&
      ["FAILED", "CANCELED", "RETRYING"].includes(retrySource.status)
        ? { source_attempt_id: retrySource.current_attempt_id }
        : undefined;
    const pending =
      feedback || opts.input || reexecute || retry
        ? {
            ...(opts.input ?? {}),
            ...(retry ? { execution_retry: retry } : {}),
            ...(feedback ? { feedback } : {}),
            ...(reexecute ? { reexecute } : {}),
          }
        : null;
    await adoptRun(c, runId);
    // A developer decision (business rule, scope ruling) must outlive this one attempt: the automatic review → implement
    // loop re-runs steps with fresh input, and without this the next reviewer raises the overruled findings again.
    if (feedback && opts.persist !== false)
      await q(
        c,
        `UPDATE workflow_runs SET inputs = coalesce(inputs, '{}'::jsonb) || jsonb_build_object('developer_decisions',
           coalesce(inputs->'developer_decisions', '[]'::jsonb) || jsonb_build_array($2::jsonb)), updated_at = now()
         WHERE id = $1`,
        [
          runId,
          json({ step: stepKey, text: feedback, by: opts.by ?? "", at: new Date().toISOString() }),
        ],
      );
    const why = reexecute
      ? `re-executed with ${[feedback && (opts.persist !== false ? "instructions (kept for the rest of the run)" : "instructions"), pinned.length && `skills ${pinned.map((p) => `${p.key}@v${p.version}`).join(", ")}`].filter(Boolean).join(" + ")}`
      : "re-executed by user";
    await reexecuteTx(c, run, stepKey, pending, afterCommit, why, undefined, opts.force === true);
    if (feedback) await runEvents.add(c, runId, "user", feedback);
    return;
  });
}

/** Retry = re-execute a FAILED/CANCELED step (same invalidation semantics). */
export const retryStep = (runId: number, stepKey: string, input?: Record<string, unknown>) =>
  reexecuteStep(runId, stepKey, { input, retry: true });

/** One model call that judges feedback (injected: the agent layer provides it; null → fallback cues only). */
let feedbackModel: ((run: RunRow, prompt: string) => Promise<string>) | null = null;

export function setFeedbackModel(fn: typeof feedbackModel) {
  feedbackModel = fn;
}

/** Decide where feedback sends the run (no state change). Exposed so the UI can preview the route. */
export async function classifyRunFeedback(runId: number, message: string, mode: FeedbackMode) {
  const run = await getRun(runId);
  const signals = feedbackSignals(message, run.allowed_repositories, run.selected_repositories);
  let judgement: FeedbackJudgement | null = null;
  let modelError: string | undefined;
  if (mode === "auto" && feedbackModel) {
    const steps = await stepsOf(pool, runId);
    const wi = run.work_item_id
      ? await one<{ title: string; description: string }>(
          pool,
          "SELECT title, description FROM work_items WHERE id = $1",
          [run.work_item_id],
        )
      : null;
    try {
      judgement = parseJudgement(
        await feedbackModel(
          run,
          classificationPrompt({
            message,
            task: [run.title, wi?.title, wi?.description].filter(Boolean).join("\n"),
            selected: run.selected_repositories,
            completed: steps
              .filter((x) => x.status === "COMPLETED" && x.output)
              .map((x) => ({
                key: x.key,
                summary: String(x.output?.summary ?? JSON.stringify(x.output)).slice(0, 400),
              })),
          }),
        ),
      );
      if (!judgement) modelError = "unparseable classification reply";
    } catch (e) {
      modelError = (e as Error).message.slice(0, 200);
    }
  }
  const decision = decideFeedbackRoute({
    mode,
    signals,
    judgement,
    fallback: heuristicJudgement(message),
  });
  if (modelError)
    decision.reasons.push(`model classification unavailable (${modelError}); fallback cues used`);
  return { run, decision, ...routeTargets(run.graph, decision.route) };
}

/**
 * Developer feedback. Auto mode judges how far back the run must go (code fix → coding step; design → planning;
 * repository scope → discovery; requirement / full recheck → first steps); an explicit mode is the developer's call.
 * The chosen steps are re-executed through the normal re-execution path (dependants invalidated, history kept), the
 * feedback becomes a developer decision for every later step, and uncommitted work is snapshotted to a ref first.
 */
export async function sendFeedback(
  runId: number,
  message: string,
  opts: { mode?: FeedbackMode; by?: string } = {},
) {
  const mode = opts.mode ?? "auto";
  if (!FEEDBACK_MODES.includes(mode)) throw new EngineError(`unknown feedback mode: ${mode}`, 400);
  const { run, decision, route, targets } = await classifyRunFeedback(runId, message, mode);
  if (!targets.length) throw new EngineError("this workflow has no step that accepts feedback");
  if (run.status === "CANCELED") throw new EngineError("run is canceled");
  const id = `${Date.now().toString(36)}`;
  // Re-planning may discard the approach the code was written for: keep the uncommitted part retrievable.
  const snapshots: Array<{ repo: string; ref: string; commit: string; files: string[] }> = [];
  if (route !== "reimplement")
    for (const w of (await allWorkspacesOf(runId)).filter((x) => existsSync(x.path)))
      try {
        const snap = await snapshotUncommitted(
          w.path,
          `refs/platform/replan/run-${runId}/${id}${w.subtask_id ? `--${w.subtask_id}` : ""}`,
          `platform: uncommitted work before ${route} (run ${runId})`,
        );
        if (snap) snapshots.push({ repo: w.repo, ...snap });
      } catch (e) {
        throw new EngineError(
          `${w.repo}: cannot snapshot uncommitted changes before ${route} (${(e as Error).message.split("\n")[0]}); commit or resolve them first`,
          409,
        );
      }
  const discovery = replanAnchors(run.graph).rediscover;
  const rediscover = route === "rediscover" || route === "restart";
  const replan = {
    id,
    at: new Date().toISOString(),
    by: opts.by ?? "",
    mode,
    route,
    source: decision.source,
    reasons: decision.reasons,
    signals: decision.signals,
    judgement: decision.judgement ?? null,
    targets,
    invalidated: [
      ...new Set(targets.flatMap((t) => [t, ...downstream(run.graph.steps, t)])),
    ].filter((k) => run.graph.steps.some((s) => s.key === k)),
    snapshots,
    feedback: message.slice(0, 4000),
  };
  return txThenRun(runId, async (c, afterCommit) => {
    let locked = await lockRun(c, runId);
    await adoptRun(c, runId);
    await q(
      c,
      `UPDATE workflow_runs SET inputs = coalesce(inputs, '{}'::jsonb)
         || jsonb_build_object('developer_decisions', coalesce(inputs->'developer_decisions', '[]'::jsonb) || jsonb_build_array($2::jsonb))
         || jsonb_build_object('replans', coalesce(inputs->'replans', '[]'::jsonb) || jsonb_build_array($3::jsonb)),
         updated_at = now() WHERE id = $1`,
      [
        runId,
        json({ step: targets[0], text: message, by: opts.by ?? "", at: replan.at, route }),
        json(replan),
      ],
    );
    const pending = { feedback: message, replan: { id, route, reasons: decision.reasons } };
    const rediscoverInput =
      rediscover && discovery ? { rediscover: { id, feedback: message } } : null;
    for (const t of targets) {
      locked = await lockRun(c, runId);
      const prev = await one<{ pending_input: { reexecute?: { skills?: unknown } | null } | null }>(
        c,
        "SELECT pending_input FROM workflow_steps WHERE run_id = $1 AND key = $2",
        [runId, t],
      );
      const skills = prev?.pending_input?.reexecute?.skills;
      const own = {
        ...pending,
        ...(Array.isArray(skills) && skills.length
          ? {
              reexecute: { instructions: null, skills, requested_by: opts.by ?? "", at: replan.at },
            }
          : {}),
      };
      await reexecuteTx(
        c,
        locked,
        t,
        t === discovery && rediscoverInput ? { ...own, ...rediscoverInput } : own,
        afterCommit,
        `feedback → ${route} (${decision.source})`,
        rediscoverInput && discovery ? { [discovery]: rediscoverInput } : undefined,
      );
    }
    await runEvents.add(
      c,
      runId,
      "user",
      `Feedback → ${route} [${decision.source}]: re-executing ${targets.join(", ")}${snapshots.length ? `; uncommitted work kept at ${snapshots.map((x) => `${x.repo}@${x.ref}`).join(", ")}` : ""}\n${decision.reasons.map((r) => `- ${r}`).join("\n")}\n\n${message}`,
      null,
      null,
      { replan },
    );
  });
}
