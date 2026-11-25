import { latestWaitCheckpoint } from "../checkpoints.ts";
import { answerProblem } from "../questionOptions.ts";
import { loadAgentConfiguration } from "../../agent/configurationStore.ts";
import { advance } from "../progression.ts";
import { EngineError, lockRun, setStepStatus } from "../mutations.ts";
import { config } from "../../config.ts";
import { WORKSPACE_RELEASE_OPTIONS, type WorkspaceConflict } from "../../git/provider.ts";
import { pool, q, one, withTx, json } from "../../db/pool.ts";
import { normalizeBranchMap } from "../branches.ts";
import { downstream } from "../graph.ts";
import { runEvents } from "../events.ts";
import type { StepRow } from "../types.ts";
import { recordHumanApproval } from "../autonomy.ts";
import { reexecuteTx } from "./reexecution.ts";
import { setSelectedRepositories } from "./repositorySelection.ts";
import { type WorkflowActionGuard, txThenRun } from "./shared.ts";

// ---------------------------------------------------------------- human-in-the-loop

/**
 * Save answers. When a step has no open question left: a `human_input` step completes with the answers as
 * output; an agent step goes back to READY and its next attempt resumes from the persisted checkpoint.
 */
export async function answerQuestions(
  answers: Record<string, string>,
  answeredBy = "",
  guard?: WorkflowActionGuard,
) {
  const ids = Object.entries(answers)
    .filter(([, a]) => String(a ?? "").trim())
    .map(([id]) => Number(id));
  if (!ids.length) throw new EngineError("no answers given", 400);
  const runIds = (
    await q<{ run_id: number }>(
      pool,
      "SELECT DISTINCT run_id FROM workflow_questions WHERE id = ANY($1) AND status = 'open' ORDER BY run_id",
      [ids],
    )
  ).map((r) => r.run_id);
  if (!runIds.length) throw new EngineError("no open questions match", 400);
  const resumed: string[] = [];
  let answered = 0;
  for (const runId of runIds) {
    await withTx(async (c, afterCommit) => {
      await lockRun(c, runId);
      await guard?.(c);
      const qs = await q(
        c,
        "SELECT * FROM workflow_questions WHERE run_id = $1 AND id = ANY($2) AND status = 'open' FOR UPDATE",
        [runId, ids],
      );
      for (const x of qs) {
        const problem = answerProblem(x.options, String(answers[x.id]));
        if (problem) throw new EngineError(problem, 400);
      }
      if (qs.length) {
        await q(
          c,
          `UPDATE workflow_questions q SET status='answered',answer=a.answer,answered_by=$3,answered_at=now()
          FROM unnest($1::bigint[],$2::text[]) AS a(id,answer) WHERE q.id=a.id`,
          [qs.map((x) => x.id), qs.map((x) => String(answers[x.id]).trim()), answeredBy],
        );
        answered += qs.length;
      }
      for (const stepId of new Set(qs.map((x) => x.step_id as number))) {
        const s = (await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id = $1", [stepId]))!;
        if (s.pending_input?.provider_handoff?.status) continue; // Unconfirmed handoffs own the continuation.
        if (s.status !== "WAITING_INPUT") continue;
        // Answers to questions of an older attempt are recorded but never resume anything (no extra job).
        if (!qs.some((x) => x.step_id === stepId && x.attempt_id === s.current_attempt_id))
          continue;
        const open = await one<{ n: number }>(
          c,
          "SELECT count(*)::int AS n FROM workflow_questions WHERE step_id = $1 AND status = 'open'",
          [stepId],
        );
        if (open!.n) continue;
        await q(c, "UPDATE workflow_step_attempts SET resolved_at = now() WHERE id = $1", [
          s.current_attempt_id,
        ]);
        if (s.type === "human_input") {
          const all = await q(
            c,
            "SELECT id, question, answer FROM workflow_questions WHERE step_id = $1 AND status = 'answered' AND attempt_id = $2 ORDER BY id",
            [stepId, s.current_attempt_id],
          );
          const output = { answers: all };
          await q(
            c,
            "UPDATE workflow_step_attempts SET status = 'COMPLETED', output = $2, finished_at = now() WHERE id = $1",
            [s.current_attempt_id, json(output)],
          );
          await setStepStatus(c, s, "COMPLETED", { output, finished_at: new Date() }, "answered");
        } else {
          const cp = await latestWaitCheckpoint(c, s.current_attempt_id);
          if (cp?.data?.recovery?.kind === "REQUIRES_RECONCILIATION") {
            const reply = await one<{ answer: string }>(
              c,
              "SELECT answer FROM workflow_questions WHERE id = $1 AND status = 'answered'",
              [cp.data.recovery.question_id],
            );
            if (
              !reply ||
              !/^(Reconciled — continue|Đã đối soát — tiếp tục|Stop here|Dừng ở đây)$/i.test(
                reply.answer.trim(),
              )
            )
              throw new EngineError(
                "Choose reconciled continue or stop; inspect external effects before retrying.",
                409,
              );
          }
          const replies = await q<{ id: number; answer: string }>(
            c,
            "SELECT id, answer FROM workflow_questions WHERE attempt_id = $1 AND status = 'answered'",
            [s.current_attempt_id],
          );
          if (
            cp?.data?.workspace_recovery &&
            !replies.some((reply) => reply.answer.trim() === "Workspace reconciled — continue")
          )
            throw new EngineError("Confirm workspace reconciliation before continuing", 409);
          if (cp?.data?.agent_configuration_recovery) {
            if (
              !replies.some(
                (reply) => reply.answer.trim() === "Use current configuration for remaining steps",
              )
            )
              throw new EngineError(
                "Choose the explicit configuration recovery option to continue",
                409,
              );
            const currentRun = await lockRun(c, runId);
            if (!currentRun.agent_configuration) {
              const recovered = {
                ...(await loadAgentConfiguration(c)),
                captured_at: new Date().toISOString(),
                capture_source: "authorized-recovery",
              };
              await q(
                c,
                "UPDATE workflow_runs SET agent_configuration=$2 WHERE id=$1 AND agent_configuration IS NULL",
                [runId, json(recovered)],
              );
              await runEvents.add(
                c,
                runId,
                "user",
                `Agent configuration recovered from current settings by ${answeredBy}; historical attempts unchanged`,
                s.id,
              );
            }
          }
          // A step paused by failure recovery: "stop" ends it as FAILED; anything else runs it again.
          const stop =
            (cp?.data?.failure || cp?.data?.recovery || cp?.data?.workspace_conflict) &&
            replies.some((a) => /^\s*(dừng|stop)\b/i.test(a.answer));
          // Choosing the release option is an approval the platform executes itself (prepare_branch moves the holder).
          const release = Array.isArray(cp?.data?.workspace_conflict)
            ? replies.find((a) => WORKSPACE_RELEASE_OPTIONS.includes(a.answer.trim()))
            : undefined;
          if (stop) {
            await setStepStatus(
              c,
              s,
              "FAILED",
              {
                error: `stopped by the developer after ${cp.data.failure?.class ?? "interruption"} failure`,
                finished_at: new Date(),
              },
              "stopped after failure",
            );
          } else {
            const pending = {
              ...(s.pending_input ?? {}),
              ...(cp?.data?.workspace_recovery
                ? { provider_handoff: undefined, replay_workspace_recovery: undefined }
                : {}),
              resume: { from_attempt_id: s.current_attempt_id, checkpoint: cp?.data ?? {} },
              ...(release && {
                workspace_release: {
                  holders: (cp?.data.workspace_conflict as WorkspaceConflict[])
                    .filter((x) => x.release === "approval")
                    .map((x) => x.holder_path),
                  question_id: release.id,
                  approved_by: answeredBy,
                },
              }),
            };
            await setStepStatus(
              c,
              s,
              "READY",
              { pending_input: pending, ready_at: new Date() },
              release ? "workspace release approved, resuming" : "answers received, resuming",
            );
          }
        }
        resumed.push(`${runId}:${s.key}`);
      }
      await advance(c, runId, afterCommit);
    });
  }
  const stillOpen = (await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM workflow_questions WHERE run_id = ANY($1) AND status = 'open'",
    [runIds],
  ))!.n;
  return { answered, resumed, stillOpen };
}

export async function approveStep(
  runId: number,
  stepKey: string,
  opts: {
    comment?: string;
    by?: string;
    repositories?: string[];
    data?: unknown;
    guard?: WorkflowActionGuard;
    /** Hash of the autonomy subject the approver was shown; a mismatch means the request changed (stale approval). */
    subject?: string;
  } = {},
) {
  return txThenRun(runId, async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    await opts.guard?.(c);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [
      runId,
      stepKey,
    ]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (s.status !== "WAITING_APPROVAL")
      throw new EngineError(`step "${stepKey}" is ${s.status}, not WAITING_APPROVAL`);
    const shown = s.approval?.request?.autonomy?.subject?.hash ?? null;
    if (opts.subject && shown && opts.subject !== shown)
      throw new EngineError(`step "${stepKey}" changed since it was shown; review it again`, 409);
    const decision = {
      granted: true,
      generation: s.generation,
      actor_type: "human" as const,
      comment: opts.comment ?? "",
      by: opts.by ?? "",
      at: new Date(),
      ...(opts.data !== undefined ? { data: opts.data } : {}),
    };
    await recordHumanApproval(c, run, s, decision.by, shown);
    if (s.approval?.gate || s.type !== "human_approval") {
      // Gate before execution (requires_approval) or an executor asking for a go-ahead: run the step now.
      await setStepStatus(
        c,
        s,
        "READY",
        { approval: { ...(s.approval ?? {}), ...decision }, ready_at: new Date() },
        "approved",
      );
    } else {
      let repos: string[] | undefined;
      if (s.config.select_repositories) {
        repos = opts.repositories ?? s.approval?.request?.recommended ?? run.selected_repositories;
        if (!repos?.length) throw new EngineError("select at least one repository", 400);
        await setSelectedRepositories(c, run, repos);
      }
      // Branches to review (and to commit fixes on), entered with the repositories: one per repository (`branches`),
      // and/or one for all the others (`branch`). A repository without one is reviewed on the base branch.
      if (s.config.ask_branch && opts.data && typeof opts.data === "object") {
        const d = opts.data as { branch?: unknown; branches?: Record<string, unknown> };
        const clean = (v: unknown) =>
          typeof v === "string" ? v.trim().replace(/^origin\//, "") : "";
        const common = clean(d.branch);
        const chosen = repos ?? run.selected_repositories;
        const perRepo: Record<string, string> = {};
        for (const r of chosen) {
          const b = clean(d.branches?.[r]) || common;
          if (b) perRepo[r] = b;
        }
        try {
          normalizeBranchMap(perRepo, config.baseBranch);
        } catch (e) {
          throw new EngineError((e as Error).message, 400);
        }
        const distinct = [...new Set(Object.values(perRepo))];
        const single =
          distinct.length === 1 && Object.keys(perRepo).length === chosen.length
            ? distinct[0]
            : null;
        await q(
          c,
          `UPDATE workflow_runs SET inputs = coalesce(inputs, '{}'::jsonb) || jsonb_build_object('branch', $2::text, 'branches', $3::jsonb), updated_at = now() WHERE id = $1`,
          [runId, single, Object.keys(perRepo).length ? json(perRepo) : null],
        );
      }
      // Evidence-gated approval: the approved scope is the proposal frozen at request time. A gap in the evidence gate
      // (e.g. a HIGH-risk state change on an unconfirmed root cause) needs an explicit, recorded acknowledgement.
      const scope = s.approval?.request?.scope;
      const acknowledged = Boolean(
        opts.data &&
        typeof opts.data === "object" &&
        "acknowledge_risk" in opts.data &&
        opts.data.acknowledge_risk === true,
      );
      if (scope && s.approval?.request?.requires_risk_acknowledgement && !acknowledged)
        throw new EngineError(
          `this proposal is ${scope.risk ?? "?"} risk with an unmet evidence gate (${(scope.gate?.missing ?? []).slice(0, 4).join("; ") || "invariants not verified"}): approving it requires an explicit risk acknowledgement`,
          400,
        );
      if (scope && acknowledged && !decision.comment.trim())
        throw new EngineError(
          "acknowledging an unmet evidence gate requires a comment explaining why",
          400,
        );
      const output = {
        approved: true,
        comment: decision.comment,
        by: decision.by,
        ...(repos ? { repositories: repos } : {}),
        ...(scope
          ? {
              approved_scope: {
                ...scope,
                approved_by: decision.by,
                approved_at: decision.at,
                comment: decision.comment,
                risk_acknowledged: acknowledged,
              },
            }
          : {}),
      };
      if (s.current_attempt_id)
        await q(
          c,
          "UPDATE workflow_step_attempts SET status = 'COMPLETED', output = $2, resolved_at = now(), finished_at = now() WHERE id = $1",
          [s.current_attempt_id, json(output)],
        );
      await setStepStatus(
        c,
        s,
        "COMPLETED",
        { output, approval: { ...(s.approval ?? {}), ...decision }, finished_at: new Date() },
        "approved",
      );
    }
    if (opts.comment)
      await runEvents.add(c, runId, "user", `approved ${stepKey}: ${opts.comment}`, s.id);
    await advance(c, runId, afterCommit);
    return;
  });
}

export async function rejectStep(
  runId: number,
  stepKey: string,
  opts: { comment?: string; by?: string; reexecute?: string; guard?: WorkflowActionGuard } = {},
) {
  return txThenRun(runId, async (c, afterCommit) => {
    const run = await lockRun(c, runId);
    await opts.guard?.(c);
    const s = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE run_id = $1 AND key = $2", [
      runId,
      stepKey,
    ]);
    if (!s) throw new EngineError(`step "${stepKey}" not found`, 404);
    if (s.status !== "WAITING_APPROVAL")
      throw new EngineError(`step "${stepKey}" is ${s.status}, not WAITING_APPROVAL`);
    const comment = opts.comment ?? "";
    const target = opts.reexecute ?? s.config.on_reject?.reexecute;
    await runEvents.add(
      c,
      runId,
      "user",
      `rejected ${stepKey}${comment ? `: ${comment}` : ""}`,
      s.id,
    );
    if (target) {
      if (
        !run.graph.steps.some((x) => x.key === target) ||
        !downstream(run.graph.steps, target).has(stepKey)
      )
        throw new EngineError(`"${target}" is not upstream of "${stepKey}"`, 400);
      // The approval step itself is downstream of the target, so it is reset and will ask again.
      await reexecuteTx(
        c,
        run,
        target,
        { feedback: `Reviewer rejected at "${s.name}": ${comment}` },
        afterCommit,
        `re-executed after rejection of ${stepKey}`,
      );
    } else {
      if (s.current_attempt_id)
        await q(
          c,
          "UPDATE workflow_step_attempts SET status = 'FAILED', error = $2, resolved_at = now(), finished_at = now() WHERE id = $1",
          [s.current_attempt_id, json({ message: `rejected: ${comment}` })],
        );
      await setStepStatus(
        c,
        s,
        "FAILED",
        {
          error: `rejected: ${comment}`,
          approval: {
            ...(s.approval ?? {}),
            granted: false,
            comment,
            by: opts.by ?? "",
            at: new Date(),
          },
        },
        "rejected",
      );
      await advance(c, runId, afterCommit);
    }
    return;
  });
}
