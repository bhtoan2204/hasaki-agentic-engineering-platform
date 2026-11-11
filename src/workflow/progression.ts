import { outputLocale } from "../agent/language.ts";
import { notifyStepWaiting } from "../notify.ts";
import type { Db } from "../db/pool.ts";
import { background } from "./background.ts";
import { budgetPreflight } from "./budgets.ts";
import { getPath } from "./graph.ts";
import { lockRun, stepsOf, setStepStatus, setRunStatus, ensureJob, type AfterCommit } from "./mutations.ts";
import { deriveRunStatus, DONE } from "./stateMachine.ts";
import type { RunRow, StepRow } from "./types.ts";

// Graph progression shares the caller's transaction; it does not execute providers or acquire another client.
function runIfMatches(runIf: NonNullable<StepRow["run_if"]>, byKey: Map<string, StepRow>) {
  const src = byKey.get(runIf.step);
  if (runIf.status) return src?.status === runIf.status;
  if (!src || src.status !== "COMPLETED") return false;
  return JSON.stringify(getPath(src.output, runIf.path ?? "result")) === JSON.stringify(runIf.equals);
}

// ---------------------------------------------------------------- advance

/**
 * Move the run forward: promote PENDING steps whose dependencies are done, enqueue READY steps, and derive
 * the run status. Idempotent: calling it twice changes nothing the second time.
 */
export async function advance(c: Db, runId: number, afterCommit?: AfterCommit): Promise<RunRow> {
  const run = await lockRun(c, runId);
  if (run.status === "CANCELED" || run.status === "PENDING") return run;
  // PAUSED runs still promote steps (so step mode shows what is runnable next) but nothing is enqueued.
  const steps = await stepsOf(c, runId);
  const byKey = new Map(steps.map((s) => [s.key, s]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of steps) {
      if (s.status !== "PENDING") continue;
      if (!s.depends_on.every((d) => DONE.includes(byKey.get(d)!.status))) continue;
      if (s.run_if && !runIfMatches(s.run_if, byKey)) {
        await setStepStatus(c, s, "SKIPPED", { output: { skipped: true, reason: `run_if ${s.run_if.step} not matched` }, finished_at: new Date() });
      } else if (s.requires_approval && !(s.approval?.granted && s.approval.generation === s.generation)) {
        await setStepStatus(c, s, "WAITING_APPROVAL", { approval: { gate: true, generation: s.generation, requested_at: new Date() } }, "approval gate");
        afterCommit?.(() => background(`notify run ${run.id}`, () => {
          const en = outputLocale(run) === "en";
          return notifyStepWaiting(en ? `✋ Run #${run.id}: ${s.name} needs approval before it runs` : `✋ Run #${run.id}: bước ${s.name} cần duyệt trước khi chạy`, {
            runId: run.id, runTitle: run.title, stepKey: s.key, stepName: s.name, status: "WAITING_APPROVAL",
            detail: en ? "approve before this step runs" : "cần duyệt trước khi chạy bước này",
            stepId: s.id, generation: s.generation, locale: outputLocale(run), ownerId: run.owner_id ?? undefined,
          });
        }));
      } else {
        await setStepStatus(c, s, "READY", { ready_at: new Date() });
      }
      changed = true;
    }
  }
  if (run.status !== "PAUSED")
    for (const s of steps)
      if (s.status === "READY") {
        // Cost preflight before an (expensive) agent attempt is scheduled; may pause the run instead.
        if ((s.type === "agent" || s.type === "coding_agent") && !(await budgetPreflight(c, run, s))) break;
        await ensureJob(c, s);
      }
  await setRunStatus(c, run, deriveRunStatus(run.status, steps), afterCommit);
  return run;
}

