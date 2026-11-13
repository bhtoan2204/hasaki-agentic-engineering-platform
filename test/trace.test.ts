import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assembleTrace,
  loadTraceInput,
  purgeDebugEvents,
  redactEventRow,
  redactTraceValue,
  searchLogs,
  TRACE_LIMITS,
  traceLog,
  type TraceInput,
} from "../src/workflow/trace.ts";
import { one, pool, q, type Db } from "../src/db/pool.ts";
import { diagnoseTrace } from "../src/workflow/traceDiagnosis.ts";
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

const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

function input(over: Partial<TraceInput> = {}): TraceInput {
  return {
    run: { id: 1, status: "FAILED", created_at: t(0), finished_at: t(100) },
    steps: [{ id: 10, key: "implement", type: "coding_agent", status: "FAILED" }],
    attempts: [
      { id: 100, step_id: 10, number: 1, generation: 1, status: "FAILED", job_id: 7, started_at: t(1), finished_at: t(10), error: { message: "fatal: 'u1-REQ-83' is already used by worktree at /x (prepare_branch)" } },
      { id: 101, step_id: 10, number: 2, generation: 1, status: "FAILED", job_id: 8, started_at: t(20), finished_at: t(30), error: { message: "fatal: 'u1-REQ-83' is already used by worktree at /x (prepare_branch)" } },
    ],
    events: [
      {
        id: 5,
        attempt_id: 100,
        kind: "trace",
        content: "prepare_branch failed",
        data: { trace: { event: "tool.prepare_branch" }, details: { conflict: true } },
        created_at: t(2),
      },
      {
        id: 6,
        attempt_id: 101,
        kind: "trace",
        content: "prepare_branch failed",
        data: { trace: { event: "tool.prepare_branch" }, details: { conflict: true } },
        created_at: t(21),
      },
      { id: 1, attempt_id: 100, kind: "tool", content: "Task x", data: { id: "tu1", name: "Task", input: {} }, created_at: t(2) },
      { id: 2, attempt_id: 100, kind: "tool", content: "Bash ls", data: { id: "tu2", name: "Bash", input: { cmd: "ls" }, parent: "tu1" }, created_at: t(3) },
      { id: 3, attempt_id: 100, kind: "tool_result", content: "ok", data: { tool_use_id: "tu2", is_error: false }, created_at: t(4) },
      { id: 4, attempt_id: 100, kind: "tool", content: "Read y", data: { id: "tu3", name: "Read", input: {} }, created_at: t(5) },
    ],
    handoffs: [],
    ...over,
  };
}

describe("trace tree", () => {
  test("builds Run → Step → Attempt → Tool with subagent nesting and keeps every attempt", () => {
    const root = assembleTrace(input());
    const step = root.children[0];
    assert.equal(step.children.length, 2);
    assert.equal(step.children[1].attrs.retryOfAttemptId, 100);
    const [task, read] = step.children[0].children;
    assert.equal(task.ids.toolUseId, "tu1");
    assert.equal(task.children[0].ids.toolUseId, "tu2");
    assert.equal(task.children[0].durationMs, 1000);
    assert.equal(task.children[0].status, "OK");
    assert.equal(task.children[0].ids.attemptId, 100);
    // no result observed: nothing is inferred
    assert.equal(read.status, null);
    assert.equal(read.durationMs, null);
  });

  test("provider handoff links the source attempt", () => {
    const root = assembleTrace(input({ handoffs: [{ source_attempt_id: 100, target_attempt_id: 101, reason: "RATE_LIMIT", status: "RESUMED" }] }));
    assert.ok(root.children[0].children[0].children.some((c) => c.type === "handoff" && c.attrs.targetAttemptId === 101));
  });
});

describe("redaction and best-effort", () => {
  test("secrets are masked and payloads bounded", () => {
    const out = JSON.stringify(redactTraceValue({ Authorization: "Bearer abcdefghijklmnop123456", password: "hunter2hunter2", big: "x".repeat(20000) }));
    assert.ok(!out.includes("abcdefghijklmnop123456"));
    assert.ok(!out.includes("hunter2hunter2"));
    assert.ok(out.length < 9000);
  });

  test("traceLog writes level and trace block, redacted, and skips below threshold", async () => {
    const calls: unknown[][] = [];
    const db = { query: async (_sql: string, v: unknown[]) => (calls.push(v), { rows: [] }) } as unknown as Db;
    assert.equal(await traceLog({ runId: 1, level: "DEBUG", event: "x", message: "m" }, db, "INFO"), false);
    assert.equal(calls.length, 0);
    assert.equal(await traceLog({ runId: 1, attemptId: 5, level: "ERROR", event: "git.worktree", message: "token=abcd1234efgh", provider: "claude", data: { api_key: "supersecretvalue" } }, db, "INFO"), true);
    const v = calls[0];
    assert.equal(v[3], "trace");
    assert.equal(v[6], "ERROR");
    assert.ok(!String(v[4]).includes("abcd1234efgh"));
    assert.ok(!String(v[5]).includes("supersecretvalue"));
    assert.equal(JSON.parse(String(v[5])).trace.event, "git.worktree");
  });

  test("persistence failure never throws", async () => {
    const db = { query: async () => { throw new Error("db down"); } } as unknown as Db;
    const orig = console.error;
    console.error = () => {};
    try {
      assert.equal(await traceLog({ runId: 1, level: "ERROR", event: "x", message: "m" }, db, "INFO"), false);
    } finally {
      console.error = orig;
    }
  });
});

describe("diagnosis", () => {
  test("worktree conflict at prepare_branch is linked to job/attempt and explains the repeated retry", () => {
    const f = diagnoseTrace(assembleTrace(input()));
    const wt = f.filter((x) => x.kind === "git_worktree_conflict");
    assert.equal(wt.length, 2);
    assert.match(wt[0].summary, /job 7, attempt 100/);
    assert.ok(wt[0].evidence.includes("attempt:100"));
    assert.ok(wt[0].evidence.includes("event:5"));
    assert.ok(f.some((x) => x.kind === "repeated_failure" && x.evidence.length === 2));
  });

  test("classifies provider failures with the existing taxonomy", () => {
    const f = diagnoseTrace(assembleTrace(input({ attempts: [{ id: 1, step_id: 10, number: 1, generation: 1, status: "FAILED", job_id: 1, started_at: t(1), finished_at: t(2), error: { message: "429 rate limit" } }] })));
    assert.equal(f[0].category, "RATE_LIMIT");
    assert.equal(f[0].source, "provider");
  });

  test("an UNKNOWN telemetry category falls back to the error text", () => {
    const f = diagnoseTrace(
      assembleTrace(
        input({
          attempts: [
            {
              id: 1,
              step_id: 10,
              number: 1,
              generation: 1,
              status: "FAILED",
              job_id: 1,
              started_at: t(1),
              finished_at: t(2),
              error: { message: "429 rate limit" },
              failure_category: "UNKNOWN",
            },
          ],
        }),
      ),
    );
    assert.equal(f[0].category, "RATE_LIMIT");
  });

  test("worktree wording in the error text alone never replaces the failure category", () => {
    const f = diagnoseTrace(
      assembleTrace(
        input({
          events: [],
          attempts: [
            {
              id: 1,
              step_id: 10,
              number: 1,
              generation: 1,
              status: "FAILED",
              job_id: 1,
              started_at: t(1),
              finished_at: t(2),
              error: { message: "rate limit while the worktree already exists" },
              failure_category: "RATE_LIMIT",
            },
          ],
        }),
      ),
    );
    assert.ok(!f.some((x) => x.kind === "git_worktree_conflict"));
    assert.equal(f[0].kind, "failure");
    assert.equal(f[0].category, "RATE_LIMIT");
  });

  test("a recorded conflict keeps a real failure category next to it", () => {
    const f = diagnoseTrace(
      assembleTrace(
        input({
          attempts: [
            {
              id: 100,
              step_id: 10,
              number: 1,
              generation: 1,
              status: "FAILED",
              job_id: 7,
              started_at: t(1),
              finished_at: t(10),
              error: { message: "overloaded" },
              failure_category: "PROVIDER_UNAVAILABLE",
            },
          ],
        }),
      ),
    );
    assert.ok(f.some((x) => x.kind === "git_worktree_conflict"));
    assert.ok(f.some((x) => x.kind === "failure" && x.category === "PROVIDER_UNAVAILABLE"));
  });

  test("detects duplicate execution, loops and stuck steps", () => {
    const a = (id: number, n: number, status: string) => ({ id, step_id: 10, number: n, generation: 1, status, job_id: id, started_at: t(n), finished_at: null });
    const dup = diagnoseTrace(assembleTrace(input({ attempts: [a(1, 1, "RUNNING"), a(2, 2, "RUNNING")], steps: [{ id: 10, key: "s", type: "agent", status: "RUNNING" }], events: [] })));
    assert.ok(dup.some((x) => x.kind === "duplicate_execution" && x.source === "scheduler"));
    const loop = diagnoseTrace(assembleTrace(input({ attempts: [1, 2, 3, 4].map((n) => a(n, n, "COMPLETED")), events: [] })));
    assert.ok(loop.some((x) => x.kind === "retry_loop"));
    const stuck = diagnoseTrace(assembleTrace(input({ attempts: [a(1, 1, "COMPLETED")], steps: [{ id: 10, key: "s", type: "agent", status: "RUNNING" }], events: [] })));
    assert.ok(stuck.some((x) => x.kind === "stuck"));
  });

  test("a requeued or deferred step, or one inside the grace period, is not stuck", () => {
    const failed = {
      id: 1,
      step_id: 10,
      number: 1,
      generation: 1,
      status: "FAILED",
      job_id: 1,
      started_at: t(1),
      finished_at: t(2),
    };
    const queued = diagnoseTrace(
      assembleTrace(
        input({
          attempts: [failed],
          steps: [
            {
              id: 10,
              key: "s",
              type: "agent",
              status: "RUNNING",
              live_job_status: "queued",
              live_job_available_at: t(500),
            },
          ],
          events: [],
        }),
      ),
    );
    assert.ok(!queued.some((x) => x.kind === "stuck"));
    const recent = diagnoseTrace(
      assembleTrace(
        input({
          attempts: [failed],
          steps: [{ id: 10, key: "s", type: "agent", status: "RUNNING" }],
          events: [],
        }),
      ),
      { now: Date.parse(t(30)) },
    );
    assert.ok(!recent.some((x) => x.kind === "stuck"));
    const late = diagnoseTrace(
      assembleTrace(
        input({
          attempts: [failed],
          steps: [{ id: 10, key: "s", type: "agent", status: "RUNNING" }],
          events: [],
        }),
      ),
      { now: Date.parse(t(2)) + 10 * 60_000 },
    );
    assert.ok(late.some((x) => x.kind === "stuck"));
  });
});

/** Records every query; returns the canned rows. No database involved. */
function fakeDb(rows: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  } as unknown as Db;
  return { db, calls };
}

describe("log search", () => {
  test("filters by step/attempt/provider/event/level/time and pages with afterId", async () => {
    const { db, calls } = fakeDb([]);
    await searchLogs(
      5,
      { stepId: 2, attemptId: 3, provider: "claude", event: "attempt.finished", level: "ERROR", from: t(0), to: t(9), afterId: 40, limit: 10 },
      db,
    );
    const { sql, params } = calls[0];
    for (const c of ["e.run_id = $1", "e.id > $2", "e.step_id =", "e.attempt_id =", "'provider'", "'event'", "e.level =", "created_at >=", "created_at <="])
      assert.ok(sql.includes(c), c);
    assert.equal(params[0], 5);
    assert.equal(params[1], 40);
    assert.equal(params.at(-1), 10);
  });

  test("clamps the page size and redacts secrets again on read", async () => {
    const secret = "Zx9" + "q".repeat(30);
    const { db, calls } = fakeDb([{ id: 1, content: `Bearer ${secret}`, data: { details: { api_key: secret } } }]);
    const out = await searchLogs(1, { limit: 100000 }, db);
    assert.equal(calls[0].params.at(-1), 500);
    assert.ok(!JSON.stringify(out).includes(secret));
  });
});

describe("redacted rows", () => {
  test("a large payload stays an object with its event name and within the cap", () => {
    const row = redactEventRow({
      content: "m",
      data: {
        trace: { event: "tool.prepare_branch" },
        details: {
          password: "hunter2hunter2",
          stack: "x".repeat(20000),
          nested: { out: "y".repeat(9000) },
        },
      },
    });
    const data = row.data as { trace: { event: string }; details: Record<string, unknown> };
    assert.equal(typeof data, "object");
    assert.equal(data.trace.event, "tool.prepare_branch");
    assert.ok(!JSON.stringify(data).includes("hunter2hunter2"));
    assert.ok(JSON.stringify(data).length <= TRACE_LIMITS.payloadBytes + 100);
  });

  test("a payload that cannot be shortened keeps the event and a bounded preview", () => {
    const data = redactTraceValue({
      trace: { event: "x.y" },
      details: Array.from({ length: 5000 }, (_, i) => i),
    }) as {
      trace: { event: string };
      truncated: string;
    };
    assert.equal(data.trace.event, "x.y");
    assert.ok(JSON.stringify(data).length <= TRACE_LIMITS.payloadBytes + 100);
  });
});

describe("retention", () => {
  test("only DEBUG events are purged, in bounded batches counted by rowCount under a single-instance lock", async () => {
    const counts = [2, 2, 1];
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async (sql: string, params: unknown[]) => (
        calls.push({ sql, params }),
        { rows: [], rowCount: counts.shift() ?? 0 }
      ),
    } as unknown as Db;
    const batch = TRACE_LIMITS.purgeBatch;
    TRACE_LIMITS.purgeBatch = 2;
    try {
      assert.equal(await purgeDebugEvents(3, db), 5);
    } finally {
      TRACE_LIMITS.purgeBatch = batch;
    }
    assert.equal(calls.length, 3);
    assert.match(calls[0].sql, /level = 'DEBUG'/);
    assert.match(calls[0].sql, /LIMIT \$2/);
    assert.match(calls[0].sql, /pg_try_advisory_xact_lock/);
    assert.doesNotMatch(calls[0].sql, /RETURNING/);
    assert.deepEqual(calls[0].params.slice(0, 2), [3, 2]);
  });
});

describe("migration 057", () => {
  test("is additive: a nullable level column and an index, nothing dropped or rewritten", () => {
    const sql = readFileSync(
      new URL("../migrations/057_trace_levels.sql", import.meta.url),
      "utf8",
    );
    assert.match(sql, /ADD COLUMN level TEXT CHECK \(level IS NULL OR/);
    assert.doesNotMatch(sql, /\bDROP\b|\bUPDATE\b|ADD COLUMN[^;]*NOT NULL/i);
    assert.match(sql, /ON workflow_events\(created_at\) WHERE level = 'DEBUG'/);
  });
});

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
