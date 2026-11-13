import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { assembleTrace, redactTraceValue, traceLog, type TraceInput } from "../src/workflow/trace.ts";
import { diagnoseTrace } from "../src/workflow/traceDiagnosis.ts";

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
    const calls: any[] = [];
    const db: any = { query: async (_sql: string, v: unknown[]) => (calls.push(v), { rows: [] }) };
    assert.equal(await traceLog({ runId: 1, level: "DEBUG", event: "x", message: "m" }, db, "INFO"), false);
    assert.equal(calls.length, 0);
    assert.equal(await traceLog({ runId: 1, attemptId: 5, level: "ERROR", event: "git.worktree", message: "token=abcd1234efgh", provider: "claude", data: { api_key: "supersecretvalue" } }, db, "INFO"), true);
    const v = calls[0];
    assert.equal(v[3], "log");
    assert.equal(v[6], "ERROR");
    assert.ok(!String(v[4]).includes("abcd1234efgh"));
    assert.ok(!String(v[5]).includes("supersecretvalue"));
    assert.equal(JSON.parse(v[5]).trace.event, "git.worktree");
  });

  test("persistence failure never throws", async () => {
    const db: any = { query: async () => { throw new Error("db down"); } };
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
    assert.ok(f.some((x) => x.kind === "repeated_failure" && x.evidence.length === 2));
  });

  test("classifies provider failures with the existing taxonomy", () => {
    const f = diagnoseTrace(assembleTrace(input({ attempts: [{ id: 1, step_id: 10, number: 1, generation: 1, status: "FAILED", job_id: 1, started_at: t(1), finished_at: t(2), error: { message: "429 rate limit" } }] })));
    assert.equal(f[0].category, "RATE_LIMIT");
    assert.equal(f[0].source, "provider");
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
});
