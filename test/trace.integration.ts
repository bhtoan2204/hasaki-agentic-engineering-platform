import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleTrace,
  loadTraceInput,
  searchLogs,
  TRACE_LIMITS,
  traceLog,
} from "../src/workflow/trace.ts";
import { one, pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { runOnce } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { localJobs } from "../src/workflow/local.ts";
import { runEvents } from "../src/workflow/events.ts";
import { buildHandoffPackage } from "../src/agent/handoff.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { config } from "../src/config.ts";
import { instanceSession } from "../src/instances.ts";

describe("with a database", () => {
  let mode: "release" | "complete" = "complete";
  before(async () => {
    await migrate();
    await q(
      pool,
      `INSERT INTO platform_instances (instance_id, session_id, started_at, last_seen_at) VALUES ($1, $2, now(), now())
       ON CONFLICT (instance_id) DO UPDATE SET session_id = $2, stopped_at = NULL, last_seen_at = now()`,
      [config.instanceId, instanceSession],
    );
    registerExecutor("agent", {
      execute: async () => {
        if (mode === "complete") return { kind: "completed", output: { ok: true } };
        localJobs.abortAll();
        return { kind: "failed", error: "agent process killed", retryable: true };
      },
    });
  });
  after(async () => {
    await settleBackground();
    await pool.end();
  });

  let seq = 0;
  async function runAgentStep() {
    const key = `trace-wf-${++seq}`;
    await definitions.create({ key, spec: { name: key, steps: [{ key: "s", type: "agent" }] } });
    const run = await startRun({ definitionKey: key });
    assert.equal(await runOnce(), true);
    const attempt = (await one<{ id: number; step_id: number }>(
      pool,
      "SELECT id, step_id FROM workflow_step_attempts WHERE run_id = $1 ORDER BY id DESC LIMIT 1",
      [run.id],
    ))!;
    return { runId: run.id, stepId: Number(attempt.step_id), attemptId: Number(attempt.id) };
  }
  async function traceEvents(attemptId: number, wanted: string) {
    for (let i = 0; i < 50; i++) {
      const rows = await q<{ event: string }>(
        pool,
        "SELECT data->'trace'->>'event' AS event FROM workflow_events WHERE attempt_id = $1 AND kind = 'trace' ORDER BY id",
        [attemptId],
      );
      if (rows.some((r) => r.event === wanted)) return rows.map((r) => r.event);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(`no ${wanted} trace event for attempt ${attemptId}`);
  }

  test("a released (interrupted) attempt still ends its trace", async () => {
    mode = "release";
    try {
      const { attemptId } = await runAgentStep();
      const events = await traceEvents(attemptId, "attempt.released");
      assert.ok(events.includes("attempt.started"));
    } finally {
      mode = "complete";
    }
  });

  test("trace events stay out of the attempt transcript, the run timeline and the provider handoff package", async () => {
    const { runId, stepId, attemptId } = await runAgentStep();
    await traceEvents(attemptId, "attempt.finished");
    await traceLog({
      runId,
      stepId,
      attemptId,
      level: "INFO",
      event: "probe",
      message: "trace-probe-line",
    });
    await runEvents.add(pool, runId, "log", "command-output-line", stepId, attemptId);
    const transcript = await runEvents.transcript(attemptId);
    assert.ok(transcript.some((e) => e.content === "command-output-line"));
    assert.ok(!transcript.some((e) => e.kind === "trace"));
    assert.ok(!(await runEvents.list(runId)).some((e) => e.kind === "trace"));
    const [run, step, attempt] = await Promise.all([
      one(pool, "SELECT * FROM workflow_runs WHERE id = $1", [runId]),
      one(pool, "SELECT * FROM workflow_steps WHERE id = $1", [stepId]),
      one(pool, "SELECT * FROM workflow_step_attempts WHERE id = $1", [attemptId]),
    ]);
    const pkg = JSON.stringify((await buildHandoffPackage(run, step, attempt, "test")).content);
    assert.ok(pkg.includes("command-output-line"));
    assert.ok(!pkg.includes("trace-probe-line"));
    assert.ok(
      (await searchLogs(runId, { event: "probe" })).some((r) => r.content === "trace-probe-line"),
    );
  });

  test("a workspace conflict recorded on the attempt row reaches the trace input", async () => {
    const { runId, attemptId } = await runAgentStep();
    await q(
      pool,
      `UPDATE workflow_step_attempts SET metrics = COALESCE(metrics, '{}'::jsonb) || '{"workspace_conflict": true}' WHERE id = $1`,
      [attemptId],
    );
    const input = await loadTraceInput(runId);
    assert.equal(input.attempts.find((a) => Number(a.id) === attemptId)?.workspace_conflict, true);
    assert.equal(assembleTrace(input).children[0].children.at(-1)?.attrs.workspaceConflict, true);
  });

  test("the trace tree keeps the newest tool events when the run has more than the limit", async () => {
    const { runId, stepId, attemptId } = await runAgentStep();
    for (const id of ["old", "mid", "new"])
      await runEvents.add(pool, runId, "tool", `Bash ${id}`, stepId, attemptId, {
        id,
        name: "Bash",
        input: {},
      });
    const limit = TRACE_LIMITS.treeEvents;
    TRACE_LIMITS.treeEvents = 2;
    try {
      const input = await loadTraceInput(runId);
      assert.deepEqual(
        input.events.map((e) => e.data?.id),
        ["mid", "new"],
      );
    } finally {
      TRACE_LIMITS.treeEvents = limit;
    }
  });
});
