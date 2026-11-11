import { config } from "../config.ts";
import { budgetsForRun } from "../report/cost.ts";
import { q, one, type Db } from "../db/pool.ts";
import { runEvents } from "./events.ts";
import { setRunStatus } from "./mutations.ts";
import type { RunRow, RunStatus, StepRow } from "./types.ts";

// Budget gates run on the caller's locked-run transaction, including their status changes/events.
/**
 * Budget preflight, BEFORE an agent attempt is queued. Projects run / work-item spend with an upper-bound estimate of
 * the next attempt (max of this step's earlier attempts in the run, else the historical median of the same step, else
 * unknown) and pauses the run when the projection exceeds a budget (once per step attempt; resuming acknowledges it).
 * Unknown estimates warn (or pause with COST_BUDGET_UNKNOWN=pause). This is a platform soft pause: no provider here
 * enforces a hard spending cap, and the events say so. Returns false when the run was paused.
 */
export async function budgetPreflight(c: Db, run: RunRow, s: StepRow): Promise<boolean> {
  if (await one(c, "SELECT 1 FROM workflow_jobs WHERE step_id = $1 AND status IN ('queued','running')", [s.id])) return true;
  const b = await budgetsForRun(run.id, c).catch(() => null);
  if (!b || (b.run.limit_usd == null && !b.work_item?.limit_usd)) return true;
  const prior = await one<{ max: number | null }>(c, "SELECT max(reported_cost_usd) AS max FROM execution_attempt_telemetry WHERE step_id = $1", [s.id]);
  let estimate: number | null = prior?.max != null ? Number(prior.max) : null;
  let basis = estimate != null ? "max of this step's earlier attempts" : "";
  if (estimate == null) {
    const h = await one<{ median: number | null; n: number }>(
      c,
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY t.reported_cost_usd) AS median, count(*)::int AS n FROM (
         SELECT x.reported_cost_usd FROM execution_attempt_telemetry x JOIN workflow_steps st ON st.id = x.step_id JOIN workflow_runs r ON r.id = x.run_id
          WHERE r.definition_key = $1 AND st.key = $2 AND x.reported_cost_usd IS NOT NULL ORDER BY x.attempt_id DESC LIMIT 50) t`,
      [run.definition_key, s.key],
    ).catch(() => null);
    if (h && Number(h.n) >= 5 && h.median != null) {
      estimate = Number(h.median);
      basis = `historical median of step "${s.key}" (${h.n} attempts)`;
    }
  }
  const events = await q<{ k: string | null; scope: string; level: string }>(c, "SELECT data->>'key' AS k, data->>'scope' AS scope, data->>'level' AS level FROM workflow_events WHERE run_id = $1 AND kind = 'budget'", [run.id]);
  const fired = new Set(events.map((e) => e.k).filter(Boolean));
  // A scope whose budget already paused this run was acknowledged by the resume: warn from now on, never pause again.
  const acknowledged = new Set(events.filter((e) => e.level === "exceeded" || e.level === "preflight_projected").map((e) => e.scope));
  const nextAttempt = Number(s.attempt_count ?? 0) + 1;
  let pause = false;
  for (const [scope, line] of [["run", b.run], ["work_item", b.work_item]] as const) {
    if (!line || line.limit_usd == null) continue;
    const projected = line.used_usd + (estimate ?? 0);
    // Uncertainty only matters once the budget is mostly spent; earlier unknown estimates are not noise-worthy.
    const unknown = estimate == null && line.used_usd >= line.limit_usd * config.costBudget.warnPct;
    const over = estimate != null && projected > line.limit_usd;
    if (!over && !unknown) continue;
    const level = over ? "preflight_projected" : "preflight_unknown_estimate";
    const key = `${scope}:${level}:${s.key}:${nextAttempt}`;
    if (fired.has(key)) continue;
    const willPause = config.costBudget.action === "pause" && !acknowledged.has(scope) && (over || config.costBudget.unknownEstimate === "pause");
    await runEvents.add(
      c, run.id, "budget",
      over
        ? `cost preflight (${scope === "run" ? "run" : "work item"}): next "${s.key}" attempt may cost ~$${estimate!.toFixed(3)} (${basis}); $${line.used_usd} spent of $${line.limit_usd} → projected $${projected.toFixed(3)}${willPause ? " — run paused before the attempt; resume to proceed" : " — warning only"}`
        : `cost preflight (${scope === "run" ? "run" : "work item"}): no cost estimate for "${s.key}" yet; $${line.used_usd} spent of $${line.limit_usd}${willPause ? " — run paused (unknown-cost policy)" : " — proceeding (cost uncertainty)"}`,
      s.id, null,
      { key, scope, level, step: s.key, attempt: nextAttempt, estimate_usd: estimate, estimate_basis: basis || "unknown", used_usd: line.used_usd, limit_usd: line.limit_usd, enforcement: "platform_soft_pause", provider_hard_limit: false },
    );
    if (willPause) pause = true;
  }
  if (!pause) return true;
  if (run.status === "RUNNING" || run.status === "WAITING") {
    await setRunStatus(c, run, "PAUSED");
    return false;
  }
  return true;
}

/**
 * Cost budget gate, after every applied attempt (see report/cost.ts). Each (scope, level) alert fires once per run:
 * reaching warnPct logs a warning; reaching 100% logs and — with action "pause" — pauses an active run. Resuming is the
 * acknowledgement: the run is not paused again for the same budget. A failing check never blocks the workflow.
 */
export async function enforceBudget(c: Db, run: RunRow, stepId: number, attemptId: number) {
  const b = await budgetsForRun(run.id, c).catch(() => null);
  if (!b) return;
  const fired = new Set((await q<{ k: string }>(c, "SELECT (data->>'scope') || ':' || (data->>'level') AS k FROM workflow_events WHERE run_id = $1 AND kind = 'budget'", [run.id])).map((r) => r.k));
  let pause = false;
  for (const [scope, line] of [["run", b.run], ["work_item", b.work_item]] as const) {
    if (!line || (line.status !== "warning" && line.status !== "exceeded")) continue;
    if (fired.has(`${scope}:${line.status}`)) continue;
    const over = line.status === "exceeded";
    const willPause = over && config.costBudget.action === "pause";
    await runEvents.add(
      c, run.id, "budget",
      `cost budget ${over ? "exceeded" : "warning"} (${scope === "run" ? "run" : "work item"}): $${line.used_usd} of $${line.limit_usd} (${line.pct}%)${willPause ? " — run paused; resume to continue past the budget" : ""}`,
      stepId, attemptId, { scope, level: line.status, limit_usd: line.limit_usd, used_usd: line.used_usd, pct: line.pct, source: line.source },
    );
    if (willPause) pause = true;
  }
  if (!pause) return;
  const cur = await one<{ status: RunStatus }>(c, "SELECT status FROM workflow_runs WHERE id = $1", [run.id]);
  if (cur && (cur.status === "RUNNING" || cur.status === "WAITING")) {
    run.status = cur.status;
    await setRunStatus(c, run, "PAUSED");
  }
}

