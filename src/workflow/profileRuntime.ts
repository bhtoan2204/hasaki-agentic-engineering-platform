import { q, json, type Db } from "../db/pool.ts";
import { planProfileTransition, type BusinessRisk } from "./profileTransitions.ts";
import { setStepStatus, stepsOf } from "./mutations.ts";
import { traceLog } from "./trace.ts";
import { runEvents } from "./events.ts";
import { topoOrder } from "./graph.ts";
import type { RunRow, StepRow, AttemptRow, WorkflowSpec } from "./types.ts";
import { classifyProfile, type Profile } from "./profiles.ts";
export interface EscalationRequest {
  reason: string;
  risk: BusinessRisk;
  target: Profile;
  expectedRevision: number;
}
/** Caller holds the run lock and owns the current fenced attempt. All graph/job/checkpoint writes commit together. */
export async function applyProfileEscalation(
  c: Db,
  run: RunRow,
  step: StepRow,
  attempt: AttemptRow,
  request: EscalationRequest,
) {
  const state = run.graph as WorkflowSpec & {
    original_spec?: WorkflowSpec;
    profile_revision?: number;
    transitions?: unknown[];
  };
  const rows = await stepsOf(c, run.id);
  const original = state.original_spec;
  if (!original)
    throw new Error("pinned original graph is unavailable; transition needs reconciliation");
  const reassessed = classifyProfile({
    title: request.reason,
    description: "",
    project: "",
    repositories: run.selected_repositories,
    knownRepository: null,
    matchingRepositories: run.selected_repositories.length,
    declaredRisk: request.risk,
  });
  const risk = reassessed.signals.business_risk === "high" ? "high" : request.risk;
  const plan = planProfileTransition({
    original,
    current: run.graph,
    from: run.profile ?? "STANDARD",
    target: request.target,
    risk,
    reason: request.reason,
    revision: state.profile_revision ?? 0,
    expectedRevision: request.expectedRevision,
    activeKey: step.key,
    completed: rows.filter((s) => s.status === "COMPLETED").map((s) => s.key),
    running: rows.filter((s) => s.status === "RUNNING").map((s) => s.key),
  });
  const extras = run.graph.steps.filter(
    (s) =>
      !plan.graph.steps.some((n) => n.key === s.key) &&
      !["agent", "coding_agent", "human_approval"].includes(s.type),
  );
  const graph = {
    ...state,
    ...plan.graph,
    steps: [...plan.graph.steps, ...extras],
    original_spec: original,
    profile: plan.to,
    profile_revision: plan.revision,
    transitions: [
      ...(state.transitions ?? []),
      { ...request, from: plan.from, to: plan.to, revision: plan.revision, attempt_id: attempt.id },
    ],
  };
  const order = topoOrder(graph.steps);
  for (const spec of graph.steps) {
    const old = rows.find((s) => s.key === spec.key);
    if (old?.status === "COMPLETED") continue;
    if (old && !["PENDING", "READY", "RETRYING", "RUNNING"].includes(old.status))
      throw new Error(`pending gate ${spec.key} needs reconciliation`);
    if (old) {
      if (old.key !== step.key && old.status === "RUNNING")
        throw new Error("concurrent attempt prevents transition");
      await q(
        c,
        "UPDATE workflow_jobs SET status='canceled', lease_expires_at=NULL WHERE step_id=$1 AND status='queued'",
        [old.id],
      );
      await setStepStatus(c, old, "PENDING", {
        config: spec.config,
        pending_input: { profile_transition: request, preserved_attempt_id: attempt.id },
      });
      await q(c, "UPDATE workflow_steps SET depends_on=$2,position=$3 WHERE id=$1", [
        old.id,
        spec.depends_on,
        order.indexOf(spec.key),
      ]);
    } else {
      await q(
        c,
        `INSERT INTO workflow_steps(run_id,key,type,name,position,depends_on,config,run_if,requires_approval,max_attempts,retry_backoff_s,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING')`,
        [
          run.id,
          spec.key,
          spec.type,
          spec.name ?? spec.key,
          order.indexOf(spec.key),
          spec.depends_on,
          json(spec.config),
          json(spec.run_if ?? null),
          spec.requires_approval ||
            (spec.type === "git_pull_request" && spec.config.mode === "approval"),
          spec.max_attempts,
          spec.retry_backoff_seconds,
        ],
      );
    }
  }
  await q(
    c,
    "UPDATE workflow_step_attempts SET status='CANCELED',finished_at=now(),output=$2 WHERE id=$1",
    [attempt.id, json({ profile_transition: plan, workspace_preserved: true })],
  );
  await q(c, "UPDATE workflow_jobs SET status='done',lease_expires_at=NULL WHERE id=$1", [
    attempt.job_id,
  ]);
  await q(
    c,
    "INSERT INTO workflow_checkpoints(run_id,step_id,attempt_id,reason,data) VALUES($1,$2,$3,'profile_transition',$4)",
    [run.id, step.id, attempt.id, json(plan)],
  );
  await q(
    c,
    `UPDATE workflow_runs SET profile=$2,graph=$3,profile_decision=COALESCE(profile_decision,'{}'::jsonb) || $4::jsonb WHERE id=$1`,
    [
      run.id,
      plan.to,
      json(graph),
      json({
        profile: plan.to,
        last_transition: {
          from: plan.from,
          to: plan.to,
          reason: plan.reason,
          risk: plan.risk,
          revision: plan.revision,
        },
      }),
    ],
  );
  run.profile = plan.to;
  run.graph = graph;
  await traceLog(
    {
      runId: run.id,
      stepId: step.id,
      attemptId: attempt.id,
      level: "INFO",
      event: "profile.transition",
      message: `${plan.from} → ${plan.to}: ${plan.reason}`,
      data: {
        from: plan.from,
        to: plan.to,
        revision: plan.revision,
        reason: plan.reason,
        risk: plan.risk,
      },
    },
    c,
  );
  await runEvents.add(
    c,
    run.id,
    "profile_transition",
    `${plan.from} → ${plan.to}: ${plan.reason}`,
    step.id,
    attempt.id,
    { ...request, from: plan.from, to: plan.to, revision: plan.revision, retained: plan.retained },
  );
}
