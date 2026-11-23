/**
 * Delegation dispatcher (scheduler reconcile tick, and right after a commit that created delegation work): spawns queued
 * children within the bounds, records finished ones, resumes waiting parent steps, joins parallel runs and cascades
 * cancellation. Every action is idempotent and driven by workflow_delegations rows, so a crash at any point is
 * recovered by the next pass. See workflow/delegation.ts for the model.
 */
import { pool, q, one, json, withTx } from "../db/pool.ts";
import { config } from "../config.ts";
import { runEvents } from "./events.ts";
import { lockRun, setStepStatus } from "./mutations.ts";
import { advance } from "./progression.ts";
import { startRun, startPendingRun, cancelRun } from "./engine.ts";
import { LIMITS, setDelegationDispatcher, type ChildWorkflowsConfig, type DelegationRow as Row } from "./delegation.ts";
import type { AttemptRow, RunRow, StepRow } from "./types.ts";

const TERMINAL_RUN = ["COMPLETED", "FAILED", "CANCELED"];

/** Child run → compact, bounded result (status, link and the final step's summary when it has one). */
async function resultOf(childId: number) {
  const run = await one<{ id: number; status: string; title: string; error: string | null }>(
    pool,
    "SELECT id, status, title, error FROM workflow_runs WHERE id=$1",
    [childId],
  );
  const last = await one<{ key: string; output: Record<string, unknown> | null }>(
    pool,
    "SELECT key, output FROM workflow_steps WHERE run_id=$1 AND status='COMPLETED' AND output IS NOT NULL ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1",
    [childId],
  );
  const o = last?.output ?? {};
  const summary =
    typeof o.summary === "string" ? o.summary : typeof o.business_summary === "string" ? o.business_summary : JSON.stringify(o);
  return {
    run_id: Number(childId),
    run_status: run?.status ?? "UNKNOWN",
    title: run?.title ?? "",
    error: run?.error ? String(run.error).slice(0, 500) : null,
    final_step: last?.key ?? null,
    summary: summary.slice(0, 2000),
  };
}

/** One pass: spawn queued children, record finished ones, resume waiting parents, join parallel runs, cascade cancels. */
async function pass() {
  const report = { spawned: 0, finished: 0, resumed: 0, joined: 0, canceled: 0, errors: 0 };

  // 1. Cascade: a parent that ended (canceled / failed) takes its non-detached children with it.
  const orphans = await q<Row & { parent_status: string; child_status: string | null }>(
    pool,
    `SELECT d.*, p.status AS parent_status, c.status AS child_status FROM workflow_delegations d
       JOIN workflow_runs p ON p.id = d.parent_run_id LEFT JOIN workflow_runs c ON c.id = d.child_run_id
      WHERE d.status IN ('queued','proposed','started') AND d.mode <> 'detached' AND p.status IN ('CANCELED','FAILED') LIMIT 50`,
  );
  for (const o of orphans) {
    if (o.child_run_id && o.child_status && !TERMINAL_RUN.includes(o.child_status))
      await cancelRun(Number(o.child_run_id), `parent run #${o.parent_run_id} ${o.parent_status.toLowerCase()}`).catch(() => {});
    await q(pool, "UPDATE workflow_delegations SET status='canceled', updated_at=now() WHERE id=$1 AND status IN ('queued','proposed','started')", [o.id]);
    report.canceled++;
  }

  // 2. Spawn queued requests, within the per-tree concurrency bound.
  const queued = await q<Row>(pool, "SELECT * FROM workflow_delegations WHERE status='queued' ORDER BY id LIMIT 20");
  for (const d of queued) {
    try {
      await withTx(async (c) => {
        const row = await one<Row>(c, "SELECT * FROM workflow_delegations WHERE id=$1 AND status='queued' FOR UPDATE SKIP LOCKED", [d.id]);
        if (!row) return; // another instance is spawning it
        const parent = (await one<RunRow>(c, "SELECT * FROM workflow_runs WHERE id=$1", [row.parent_run_id]))!;
        if (row.mode !== "propose") {
          const active = (await one<{ n: number }>(
            c,
            `SELECT count(*)::int AS n FROM workflow_delegations d JOIN workflow_runs r ON r.id = d.child_run_id
              WHERE d.root_run_id=$1 AND d.status='started' AND d.mode <> 'propose' AND r.status NOT IN ('COMPLETED','FAILED','CANCELED')`,
            [row.root_run_id],
          ))!.n;
          if (active >= LIMITS.activePerTree) return; // stays queued; a later pass starts it
        }
        // Idempotent: a child created by an earlier, interrupted pass is found again, never created twice.
        let child = await one<{ id: number; status: string }>(
          c,
          "SELECT id, status FROM workflow_runs WHERE inputs->'delegation'->>'id' = $1",
          [String(row.id)],
        );
        if (!child) {
          const created = await startRun({
            definitionKey: row.workflow_key,
            title: `↳ #${row.parent_run_id} ${row.request.title}`.slice(0, 160),
            inputs: {
              request: row.request.request,
              ...(parent.inputs?.project ? { project: parent.inputs.project } : {}),
              delegation: { id: row.id, parent_run_id: row.parent_run_id, mode: row.mode, depth: row.depth, reason: row.request.reason },
            },
            repositories: row.request.repositories.length ? row.request.repositories : undefined,
            ownerId: Number(parent.owner_id),
            outputLocale: parent.output_locale ?? undefined,
            start: false,
          });
          child = { id: Number(created.id), status: "PENDING" };
          const cfg = await one<{ config: { child_workflows?: ChildWorkflowsConfig } }>(c, "SELECT config FROM workflow_steps WHERE id=$1", [row.parent_step_id]);
          const budget = cfg?.config.child_workflows?.budget_usd ?? config.costBudget.runUsd ?? LIMITS.defaultBudgetUsd;
          await q(pool, "UPDATE workflow_runs SET budget_usd=$2 WHERE id=$1 AND budget_usd IS NULL", [child.id, budget]);
        }
        if (row.mode !== "propose" && child.status === "PENDING") await startPendingRun(child.id);
        await q(
          c,
          "UPDATE workflow_delegations SET child_run_id=$2, status=$3, spawn_attempts=spawn_attempts+1, error=NULL, updated_at=now() WHERE id=$1",
          [row.id, child.id, row.mode === "propose" ? "proposed" : "started"],
        );
        await runEvents.add(c, row.parent_run_id, "system", `child workflow ${row.workflow_key} → run #${child.id} (${row.mode})`, row.parent_step_id, null, { delegation_id: row.id, child_run_id: child.id });
        report.spawned++;
      });
    } catch (e) {
      report.errors++;
      await q(
        pool,
        `UPDATE workflow_delegations SET spawn_attempts=spawn_attempts+1, error=$2,
                status=CASE WHEN spawn_attempts+1 >= $3 THEN 'failed' ELSE status END, updated_at=now() WHERE id=$1 AND status='queued'`,
        [d.id, (e as Error).message.slice(0, 500), LIMITS.spawnAttempts],
      );
    }
  }

  // 3. Record finished children (their result is read once, then kept on the row).
  const done = await q<Row & { child_status: string }>(
    pool,
    `SELECT d.*, r.status AS child_status FROM workflow_delegations d JOIN workflow_runs r ON r.id = d.child_run_id
      WHERE d.status IN ('started','proposed') AND r.status IN ('COMPLETED','FAILED','CANCELED') LIMIT 100`,
  );
  for (const d of done) {
    const result = await resultOf(Number(d.child_run_id));
    await q(
      pool,
      "UPDATE workflow_delegations SET status=$2, result=$3, updated_at=now() WHERE id=$1 AND status IN ('started','proposed')",
      [d.id, d.child_status === "COMPLETED" ? "completed" : d.child_status === "FAILED" ? "failed" : "canceled", json(result)],
    );
    report.finished++;
  }

  // 4. Resume parent steps whose blocking children are all finished.
  const waiting = await q<{ run_id: number; id: number; ids: number[] }>(
    pool,
    `SELECT s.run_id, s.id, ARRAY(SELECT jsonb_array_elements_text(s.pending_input->'child_workflows'))::bigint[] AS ids
       FROM workflow_steps s WHERE s.status='WAITING_INPUT' AND s.pending_input ? 'child_workflows'`,
  );
  for (const w of waiting) {
    const rows = await q<Row>(pool, "SELECT * FROM workflow_delegations WHERE id = ANY($1)", [w.ids]);
    if (rows.length !== w.ids.length || rows.some((r) => !["completed", "failed", "canceled"].includes(r.status))) continue;
    await withTx(async (c, afterCommit) => {
      await lockRun(c, Number(w.run_id));
      const step = await one<StepRow>(c, "SELECT * FROM workflow_steps WHERE id=$1 FOR UPDATE", [w.id]);
      if (!step || step.status !== "WAITING_INPUT" || !step.pending_input?.child_workflows) return;
      const attempt = await one<AttemptRow>(c, "SELECT * FROM workflow_step_attempts WHERE id=$1", [step.current_attempt_id]);
      const results = rows.map((r) => ({ ...(r.result ?? {}), delegation_id: Number(r.id), workflow: r.workflow_key, mode: r.mode, status: r.status }));
      const base = (attempt?.output ?? {}) as Record<string, unknown>;
      const prior = (base.child_workflows ?? {}) as Record<string, unknown>;
      const output = { ...base, child_workflows: { ...prior, results } };
      const failed = rows.filter((r) => r.status !== "completed");
      if (failed.length) {
        const error = `blocking child workflow(s) did not complete: ${failed.map((r) => `#${r.child_run_id ?? "?"} ${r.workflow_key} ${r.status}`).join(", ")}`;
        await q(c, "UPDATE workflow_step_attempts SET status='FAILED', output=$2, error=$3, finished_at=now(), resolved_at=now() WHERE id=$1", [step.current_attempt_id, json(output), json({ message: error })]);
        await setStepStatus(c, step, "FAILED", { output, pending_input: null, error, finished_at: new Date() }, "child workflow failed");
      } else {
        await q(c, "UPDATE workflow_step_attempts SET status='COMPLETED', output=$2, finished_at=now(), resolved_at=now() WHERE id=$1", [step.current_attempt_id, json(output)]);
        await setStepStatus(c, step, "COMPLETED", { output, pending_input: null, error: null, finished_at: new Date() }, "child workflows completed");
      }
      await advance(c, Number(w.run_id), afterCommit);
    });
    report.resumed++;
  }

  // 5. Parallel join: a run held in WAITING only by parallel children moves on once they are all finished.
  const held = await q<{ id: number }>(
    pool,
    `SELECT r.id FROM workflow_runs r WHERE r.status='WAITING'
        AND EXISTS (SELECT 1 FROM workflow_delegations d WHERE d.parent_run_id=r.id AND d.mode='parallel')
        AND NOT EXISTS (SELECT 1 FROM workflow_delegations d WHERE d.parent_run_id=r.id AND d.mode='parallel' AND d.status IN ('queued','started','proposed'))
        AND NOT EXISTS (SELECT 1 FROM workflow_steps s WHERE s.run_id=r.id AND s.status IN ('WAITING_INPUT','WAITING_APPROVAL'))
      LIMIT 50`,
  );
  for (const h of held) {
    await withTx((c, afterCommit) => advance(c, Number(h.id), afterCommit));
    report.joined++;
  }
  return report;
}

let running: Promise<Awaited<ReturnType<typeof pass>>> | null = null;
let again = false;
/**
 * One dispatcher pass at a time in this process (the reconcile tick and post-commit kicks share it). A call during a pass
 * waits for it and then runs one more pass, so work committed meanwhile is never missed.
 */
export async function dispatchDelegations(): Promise<Awaited<ReturnType<typeof pass>>> {
  if (running) {
    again = true;
    await running.catch(() => {});
    if (running) return running;
  }
  again = false;
  running = pass().finally(() => (running = null));
  const r = await running;
  return again ? dispatchDelegations() : r;
}

setDelegationDispatcher(dispatchDelegations);
