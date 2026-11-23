/**
 * Workflow-to-workflow delegation through the real engine, scheduler, approval gates, budgets and PostgreSQL. Agents are
 * stubs (no model call): a parent step's submitted output asks for children; children are ordinary runs.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser } from "../src/auth/users.ts";
import { registerInstance } from "../src/instances.ts";
import { definitions } from "../src/workflow/definitions.ts";
import {
  startRun,
  cancelRun,
  getRun,
  runDetail,
  reexecuteStep,
  startPendingRun,
} from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { setHandoffReadinessForTests } from "../src/agent/handoff.ts";
import { dispatchDelegations } from "../src/workflow/delegationDispatch.ts";
import { LIMITS } from "../src/workflow/delegation.ts";
import { runtimeMetricsSnapshot } from "../src/runtimeMetrics.ts";

let ownerId = 0;
/** What each parent "plan" step submits, by run title. */
const plans = new Map<string, unknown[]>();
const runs: number[] = [];

before(async () => {
  await migrate();
  await registerInstance();
  ownerId = (
    await createUser({ username: "deleg-owner", password: "deleg-test-password", role: "member" })
  ).id;
  setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
  registerExecutor("agent", {
    async execute(ctx) {
      if (ctx.step.key === "plan") {
        const child_workflows = plans.get(ctx.run.title) ?? [];
        return {
          kind: "completed",
          output: { summary: "planned", ...(child_workflows.length ? { child_workflows } : {}) },
        };
      }
      const request = String(ctx.run.inputs?.request ?? "");
      if (/FAIL/.test(request))
        return { kind: "failed", error: "child failed on purpose", retryable: false };
      return {
        kind: "completed",
        output: { summary: `done: ${request}`, upstream: Object.keys(ctx.input.upstream) },
      };
    },
  });
  const delegate = (workflows: string[], extra: Record<string, unknown> = {}) => ({
    workflows,
    ...extra,
  });
  await definitions.create({
    key: "deleg-parent",
    spec: {
      name: "Delegating parent",
      steps: [
        {
          key: "plan",
          type: "agent",
          config: {
            child_workflows: delegate(["deleg-child", "deleg-gated", "deleg-mid"], {
              max_children: 5,
            }),
          },
        },
        { key: "summarize", type: "agent", depends_on: ["plan"] },
      ],
    },
  });
  await definitions.create({
    key: "deleg-ro",
    spec: {
      name: "Read-only parent",
      execution_mode: "read_only",
      steps: [
        { key: "plan", type: "agent", config: { child_workflows: delegate(["deleg-child"]) } },
      ],
    },
  });
  await definitions.create({
    key: "deleg-plain",
    spec: { name: "No delegation", steps: [{ key: "plan", type: "agent" }] },
  });
  await definitions.create({
    key: "deleg-child",
    spec: { name: "Child", steps: [{ key: "work", type: "agent" }] },
  });
  // A child that stops at a human approval gate (stays active until someone approves it).
  await definitions.create({
    key: "deleg-gated",
    spec: {
      name: "Gated child",
      steps: [{ key: "work", type: "agent", requires_approval: true }],
    },
  });
  // A child that itself delegates (depth and cycle checks).
  await definitions.create({
    key: "deleg-mid",
    spec: {
      name: "Middle",
      steps: [
        {
          key: "plan",
          type: "agent",
          config: {
            child_workflows: delegate(["deleg-parent", "deleg-child", "deleg-mid", "deleg-mid2"]),
          },
        },
      ],
    },
  });
  await definitions.create({
    key: "deleg-mid2",
    spec: {
      name: "Second level",
      steps: [
        { key: "plan", type: "agent", config: { child_workflows: delegate(["deleg-child"]) } },
      ],
    },
  });
});
after(async () => {
  setHandoffReadinessForTests(undefined);
  for (const id of runs) await cancelRun(id).catch(() => {});
  await settleBackground();
  await pool.end();
});

/** Drive the scheduler and the dispatcher until nothing moves. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    const jobs = await drain();
    const r = await dispatchDelegations();
    if (!jobs && !r.spawned && !r.finished && !r.resumed && !r.joined && !r.canceled) return;
  }
}
async function parent(title: string, children: unknown[], key = "deleg-parent") {
  plans.set(title, children);
  const run = await startRun({ definitionKey: key, title, ownerId });
  runs.push(Number(run.id));
  await settle();
  return Number(run.id);
}
const ask = (over: Record<string, unknown> = {}) => ({
  workflow: "deleg-child",
  title: "child task",
  request: "verify the refund path independently",
  reason: "independent verification with its own deliverable",
  mode: "blocking",
  ...over,
});
const rowsOf = (runId: number) =>
  q<{
    id: number;
    mode: string;
    status: string;
    child_run_id: number | null;
    depth: number;
    spawn_attempts: number;
    result: Record<string, unknown> | null;
  }>(pool, "SELECT * FROM workflow_delegations WHERE parent_run_id=$1 ORDER BY id", [runId]);
const step = (runId: number, key: string) =>
  one<{ status: string; output: Record<string, unknown> | null; error: string | null }>(
    pool,
    "SELECT status, output, error FROM workflow_steps WHERE run_id=$1 AND key=$2",
    [runId, key],
  ).then((s) => s!);

test("collects three finished children in one read with one guarded update per child", async () => {
  const parent = await startRun({ definitionKey: "deleg-parent", ownerId, start: false });
  runs.push(parent.id);
  const states = ["COMPLETED", "FAILED", "CANCELED"] as const;
  for (const status of states) {
    const child = await startRun({
      definitionKey: "deleg-child",
      title: status,
      ownerId,
      start: false,
    });
    await q(pool, "UPDATE workflow_runs SET status=$2 WHERE id=$1", [child.id, status]);
    if (status === "COMPLETED") {
      await q(pool, "UPDATE workflow_steps SET status='COMPLETED', output=$2 WHERE run_id=$1", [
        child.id,
        JSON.stringify({ summary: "finished work" }),
      ]);
    }
    await q(
      pool,
      `INSERT INTO workflow_delegations
        (parent_run_id, parent_step_id, root_run_id, depth, dedupe_key, workflow_key, mode, request, status, child_run_id)
       SELECT $1, id, $1, 1, $3, 'deleg-child', 'detached', '{}', 'started', $2
         FROM workflow_steps WHERE run_id=$1 AND key='plan'`,
      [parent.id, child.id, status],
    );
  }
  await settleBackground();
  const before = runtimeMetricsSnapshot().counters["db.statements"] ?? 0;
  assert.equal((await dispatchDelegations()).finished, 3);
  const statements = (runtimeMetricsSnapshot().counters["db.statements"] ?? 0) - before;
  const rows = await rowsOf(parent.id);
  assert.deepEqual(
    rows.map((row) => row.status),
    ["completed", "failed", "canceled"],
  );
  assert.deepEqual(
    rows.map((row) => row.result?.run_status),
    states,
  );
  assert.deepEqual(
    rows.map((row) => row.result?.final_step),
    ["work", null, null],
  );
  assert.equal(rows[0].result?.summary, "finished work");
  assert.equal(statements, 8, "five dispatcher reads and three guarded updates");
});

test("blocking: the step waits, the child runs as an ordinary run, the result is aggregated into the step output", async () => {
  const id = await parent("blocking", [ask()]);
  const [row] = await rowsOf(id);
  assert.equal(row.status, "completed");
  const child = await getRun(Number(row.child_run_id));
  assert.equal(child.owner_id, ownerId, "same owner (same permissions)");
  assert.match(child.title, new RegExp(`^↳ #${id} `));
  assert.equal((child.inputs.delegation as { id: number }).id, Number(row.id));
  assert.ok(Number(child.budget_usd) > 0, "the child has a run budget before it starts");
  const plan = await step(id, "plan");
  assert.equal(plan.status, "COMPLETED");
  const results = (
    plan.output!.child_workflows as { results: Array<{ status: string; summary: string }> }
  ).results;
  assert.equal(results[0].status, "completed");
  assert.match(results[0].summary, /done: verify the refund path/);
  assert.equal(
    (await step(id, "summarize")).status,
    "COMPLETED",
    "downstream steps run after the children",
  );
  assert.equal((await getRun(id)).status, "COMPLETED");
  const detail = (await runDetail(id)) as unknown as { delegation: { children: unknown[] } };
  assert.equal(detail.delegation.children.length, 1);
  const childDetail = (await runDetail(Number(row.child_run_id))) as unknown as {
    delegation: { parent: { run_id: number } };
  };
  assert.equal(childDetail.delegation.parent.run_id, id);
});

test("a blocking child that fails fails the parent step (no silent success)", async () => {
  const id = await parent("blocking-fail", [ask({ request: "FAIL this one" })]);
  const plan = await step(id, "plan");
  assert.equal(plan.status, "FAILED");
  assert.match(String(plan.error), /did not complete: #\d+ deleg-child failed/);
  assert.equal((await getRun(id)).status, "FAILED");
});

test("parallel: the parent continues and its run completes only after the child", async () => {
  plans.set("parallel", [
    ask({ workflow: "deleg-gated", mode: "parallel", request: "parallel gated work" }),
  ]);
  const run = await startRun({ definitionKey: "deleg-parent", title: "parallel", ownerId });
  const id = Number(run.id);
  runs.push(id);
  await settle();
  assert.equal((await step(id, "plan")).status, "COMPLETED");
  assert.equal((await step(id, "summarize")).status, "COMPLETED", "the parent did not wait");
  assert.equal(
    (await getRun(id)).status,
    "WAITING",
    "…but its run is held until the child finishes",
  );
  const [row] = await rowsOf(id);
  const child = await getRun(Number(row.child_run_id));
  assert.equal(
    child.status,
    "WAITING",
    "the child stops at its own approval gate (never auto-approved)",
  );
  await cancelRun(Number(row.child_run_id));
  await settle();
  assert.equal((await rowsOf(id))[0].status, "canceled");
  assert.equal((await getRun(id)).status, "COMPLETED", "joined once the child is finished");
});

test("detached and propose: nobody waits; a proposed child is created but only a human starts it", async () => {
  const id = await parent("detached+propose", [
    ask({ workflow: "deleg-gated", mode: "detached", request: "detached gated work" }),
    ask({ mode: "propose", request: "proposed follow-up" }),
  ]);
  assert.equal((await getRun(id)).status, "COMPLETED");
  const [detached, proposed] = await rowsOf(id);
  assert.equal(detached.status, "started");
  assert.equal((await getRun(Number(detached.child_run_id))).status, "WAITING");
  assert.equal(proposed.status, "proposed");
  assert.equal(
    (await getRun(Number(proposed.child_run_id))).status,
    "PENDING",
    "not started by the platform",
  );
  await startPendingRun(Number(proposed.child_run_id));
  await settle();
  assert.equal((await rowsOf(id))[1].status, "completed");
  runs.push(Number(detached.child_run_id));
});

test("cancel cascade: canceling the parent cancels blocking children, never detached ones", async () => {
  plans.set("cascade", [
    ask({ workflow: "deleg-gated", mode: "blocking", request: "blocking gated work" }),
    ask({ workflow: "deleg-gated", mode: "detached", request: "detached survivor" }),
  ]);
  const run = await startRun({ definitionKey: "deleg-parent", title: "cascade", ownerId });
  const id = Number(run.id);
  await settle();
  assert.equal((await step(id, "plan")).status, "WAITING_INPUT");
  await cancelRun(id);
  await settle();
  const [blocking, detached] = await rowsOf(id);
  assert.equal(blocking.status, "canceled");
  assert.equal((await getRun(Number(blocking.child_run_id))).status, "CANCELED");
  assert.equal(
    (await getRun(Number(detached.child_run_id))).status,
    "WAITING",
    "detached child unaffected",
  );
  runs.push(Number(detached.child_run_id));
});

test("a failed cascade stays eligible for retry and does not block its siblings", async (t) => {
  const id = await parent("cascade-retry", [
    ask({ workflow: "deleg-gated", request: "first gated child" }),
    ask({ workflow: "deleg-gated", request: "second gated child" }),
  ]);
  const [first, second] = await rowsOf(id);
  const childId = Number(first.child_run_id);
  runs.push(childId, Number(second.child_run_id));
  await cancelRun(id);
  await pool.query(`CREATE FUNCTION fail_child_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = ${childId} AND NEW.status = 'CANCELED' THEN
        RAISE EXCEPTION 'injected child cancellation failure';
      END IF;
      RETURN NEW;
    END $$`);
  await pool.query(`CREATE TRIGGER fail_child_cancel BEFORE UPDATE ON workflow_runs
    FOR EACH ROW EXECUTE FUNCTION fail_child_cancel()`);
  const logged = t.mock.method(console, "error", () => {});
  try {
    assert.equal((await dispatchDelegations()).errors, 1);
    assert.deepEqual(
      (await rowsOf(id)).map((row) => row.status),
      ["started", "canceled"],
    );
    assert.equal((await getRun(childId)).status, "WAITING");
    const entry = JSON.parse(String(logged.mock.calls[0]?.arguments[0]));
    assert.equal(entry.child_run_id, childId);
    assert.match(entry.error, /injected child cancellation failure/);
  } finally {
    await pool.query("DROP TRIGGER fail_child_cancel ON workflow_runs");
    await pool.query("DROP FUNCTION fail_child_cancel()");
  }
  assert.equal((await dispatchDelegations()).canceled, 1);
  assert.equal((await getRun(childId)).status, "CANCELED");
  assert.equal((await dispatchDelegations()).canceled, 0);
});

test("cascade cancels a child created before its delegation link was committed", async () => {
  const id = await parent("cascade-unlinked", [ask({ workflow: "deleg-gated" })]);
  const [row] = await rowsOf(id);
  const childId = Number(row.child_run_id);
  runs.push(childId);
  // Recreate the persisted state after a dispatcher crash between starting and linking the child.
  await q(pool, "UPDATE workflow_delegations SET child_run_id=NULL, status='queued' WHERE id=$1", [
    row.id,
  ]);
  await cancelRun(id);
  assert.equal((await dispatchDelegations()).canceled, 1);
  assert.equal((await getRun(childId)).status, "CANCELED");
  const [canceled] = await rowsOf(id);
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.child_run_id, childId);
  assert.equal((await dispatchDelegations()).canceled, 0);
});

test("a transient link failure rolls back the child and preserves the last spawn attempt", async (t) => {
  const run = await startRun({ definitionKey: "deleg-parent", ownerId, start: false });
  runs.push(run.id);
  const delegation = (await one<{ id: number }>(
    pool,
    `INSERT INTO workflow_delegations
      (parent_run_id, parent_step_id, root_run_id, depth, dedupe_key, workflow_key, mode, request, spawn_attempts)
     SELECT $1, id, $1, 1, 'transient-spawn', 'deleg-gated', 'detached', $2, $3
       FROM workflow_steps WHERE run_id=$1 AND key='plan' RETURNING workflow_delegations.id`,
    [
      run.id,
      JSON.stringify(ask({ workflow: "deleg-gated", mode: "detached", repositories: [] })),
      LIMITS.spawnAttempts - 1,
    ],
  ))!;
  await pool.query(`CREATE FUNCTION fail_delegation_spawn() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = ${delegation.id} AND NEW.child_run_id IS NOT NULL THEN
        RAISE EXCEPTION 'injected database unavailable' USING ERRCODE = '57P03';
      END IF;
      RETURN NEW;
    END $$`);
  await pool.query(`CREATE TRIGGER fail_delegation_spawn BEFORE UPDATE ON workflow_delegations
    FOR EACH ROW EXECUTE FUNCTION fail_delegation_spawn()`);
  const logged = t.mock.method(console, "error", () => {});
  try {
    assert.equal((await dispatchDelegations()).errors, 1);
    const [row] = await rowsOf(run.id);
    assert.equal(row.status, "queued");
    assert.equal(row.spawn_attempts, LIMITS.spawnAttempts - 1);
    assert.equal(
      (
        await q(pool, "SELECT id FROM workflow_runs WHERE inputs->'delegation'->>'id' = $1", [
          String(delegation.id),
        ])
      ).length,
      0,
      "failed link must roll back the child run and its queued work",
    );
    const entry = JSON.parse(String(logged.mock.calls[0]?.arguments[0]));
    assert.equal(entry.delegation_id, delegation.id);
    assert.equal(entry.error_code, "57P03");
  } finally {
    await pool.query("DROP TRIGGER fail_delegation_spawn ON workflow_delegations");
    await pool.query("DROP FUNCTION fail_delegation_spawn()");
  }
  assert.equal((await dispatchDelegations()).spawned, 1);
  const [row] = await rowsOf(run.id);
  assert.equal(row.status, "started");
  runs.push(Number(row.child_run_id));
  assert.equal((await dispatchDelegations()).spawned, 0);
});

test("guards: allowlist, justification, scope, per-step bound, read-only parent, unconfigured step — refused with reasons", async () => {
  const id = await parent("guards", [
    ask({ workflow: "deleg-plain", request: "not allowed" }),
    ask({ reason: "because", request: "no real reason" }),
    ask({ repositories: ["not-a-repo"], request: "outside scope" }),
    ask({ mode: "detached", request: "ok 1" }),
    ask({ mode: "detached", request: "ok 2" }),
    ask({ mode: "detached", request: "ok 3" }),
    ask({ mode: "detached", request: "ok 4" }),
    ask({ mode: "detached", request: "ok 5" }),
    ask({ mode: "detached", request: "ok 6 — over the bound" }),
  ]);
  const out = (await step(id, "plan")).output!.child_workflows as {
    accepted: unknown[];
    refused: Array<{ reason: string }>;
  };
  const reasons = out.refused.map((r) => r.reason).join(" | ");
  assert.match(reasons, /not allowed for this step/);
  assert.match(reasons, /reason .* is required/);
  assert.match(reasons, /outside this run's scope/);
  assert.match(reasons, /at most 5 child workflow/);
  assert.equal(out.accepted.length, 5);
  // A read-only workflow cannot start a workflow that may change code (it may only propose it).
  const ro = await parent(
    "read-only",
    [ask(), ask({ mode: "propose", request: "proposed from read-only" })],
    "deleg-ro",
  );
  const roOut = (await step(ro, "plan")).output!.child_workflows as {
    accepted: Array<{ mode: string }>;
    refused: Array<{ reason: string }>;
  };
  assert.match(roOut.refused[0].reason, /read-only workflow can only propose/);
  assert.deepEqual(
    roOut.accepted.map((a) => a.mode),
    ["propose"],
  );
  // A step that is not configured to delegate: the request is ignored, nothing is spawned.
  const plain = await parent("plain", [ask()], "deleg-plain");
  assert.equal((await rowsOf(plain)).length, 0);
  assert.equal((await getRun(plain)).status, "COMPLETED");
});

test("depth and cycles: a child may delegate once more; a workflow already in the chain or a third level is refused", async () => {
  // parent → deleg-mid (depth 1) → deleg-child (depth 2) ok; deleg-mid → deleg-parent / deleg-mid refused (cycle).
  const id = await parent("depth", [ask({ workflow: "deleg-mid", request: "middle work" })]);
  const [mid] = await rowsOf(id);
  const midRun = Number(mid.child_run_id);
  const midTitle = (await getRun(midRun)).title;
  assert.ok(midTitle);
  // The middle run already planned with no requests; replay its plan step with requests.
  plans.set(midTitle, [
    ask({ workflow: "deleg-parent", request: "back to the top" }),
    ask({ workflow: "deleg-mid", request: "myself again" }),
    ask({ workflow: "deleg-child", mode: "detached", request: "leaf work" }),
    ask({ workflow: "deleg-mid2", mode: "detached", request: "second level work" }),
  ]);
  await reexecuteStep(midRun, "plan");
  await settle();
  const out = (await step(midRun, "plan")).output!.child_workflows as {
    accepted: unknown[];
    refused: Array<{ reason: string }>;
  };
  assert.equal(out.refused.filter((r) => /cycle/.test(r.reason)).length, 2);
  const [leaf, mid2] = await rowsOf(midRun);
  assert.equal(leaf.depth, 2);
  assert.equal(mid2.depth, 2);
  // A third level is refused (LIMITS.depth = 2).
  const mid2Run = Number(mid2.child_run_id);
  plans.set((await getRun(mid2Run)).title, [ask({ mode: "detached", request: "third level" })]);
  await reexecuteStep(mid2Run, "plan");
  await settle();
  const deep = (await step(mid2Run, "plan")).output!.child_workflows as {
    accepted: unknown[];
    refused: Array<{ reason: string }>;
  };
  assert.equal(deep.accepted.length, 0);
  assert.match(deep.refused[0].reason, new RegExp(`depth limit ${LIMITS.depth}`));
});

test("idempotent and crash-safe: duplicates are reused, a child created before a crash is adopted, never spawned twice", async () => {
  // The same request twice in one output, then the step re-executed: one row, one child.
  const id = await parent("dupes", [
    ask({ mode: "detached", workflow: "deleg-gated", request: "same work" }),
    ask({ mode: "detached", workflow: "deleg-gated", request: "same   WORK" }),
  ]);
  const out = (await step(id, "plan")).output!.child_workflows as {
    accepted: Array<{ id: number; reused: boolean }>;
  };
  assert.equal(new Set(out.accepted.map((a) => a.id)).size, 1);
  await reexecuteStep(id, "plan");
  await settle();
  assert.equal((await rowsOf(id)).length, 1, "re-execution reuses the delegation");
  const children = await q(
    pool,
    "SELECT id FROM workflow_runs WHERE inputs->'delegation'->>'id' = $1",
    [String((await rowsOf(id))[0].id)],
  );
  assert.equal(children.length, 1);
  runs.push(Number(children[0].id));

  // Crash between creating the child and recording it: the next pass adopts the existing run.
  const row = await one<{ id: number }>(
    pool,
    `INSERT INTO workflow_delegations (parent_run_id,parent_step_id,root_run_id,depth,dedupe_key,workflow_key,mode,request)
     SELECT $1, s.id, $1, 1, 'crash-test', 'deleg-gated', 'detached', $2 FROM workflow_steps s WHERE s.run_id=$1 AND s.key='plan' RETURNING id`,
    [
      id,
      JSON.stringify({
        workflow: "deleg-gated",
        title: "crash",
        request: "crash work",
        reason: "x".repeat(25),
        mode: "detached",
        repositories: [],
      }),
    ],
  );
  const orphan = await startRun({
    definitionKey: "deleg-gated",
    title: "orphan",
    ownerId,
    inputs: { delegation: { id: Number(row!.id) } },
    start: false,
  });
  runs.push(Number(orphan.id));
  const [a, b] = await Promise.all([dispatchDelegations(), dispatchDelegations()]);
  assert.ok(a.spawned + b.spawned <= 1);
  await settle();
  const adopted = await one<{ child_run_id: number; status: string }>(
    pool,
    "SELECT child_run_id, status FROM workflow_delegations WHERE id=$1",
    [row!.id],
  );
  assert.equal(
    Number(adopted!.child_run_id),
    Number(orphan.id),
    "the run created before the crash is reused",
  );
  assert.equal(
    (
      await q(pool, "SELECT 1 FROM workflow_runs WHERE inputs->'delegation'->>'id' = $1", [
        String(row!.id),
      ])
    ).length,
    1,
  );
});

test("bounded concurrency per tree: at most 3 active children, the rest start as slots free", async () => {
  const many = [1, 2, 3, 4, 5].map((n) =>
    ask({ workflow: "deleg-gated", mode: "detached", request: `gated work ${n}` }),
  );
  const id = await parent("concurrency", many);
  let rows = await rowsOf(id);
  assert.equal(rows.filter((r) => r.status === "started").length, LIMITS.activePerTree);
  assert.equal(rows.filter((r) => r.status === "queued").length, 2);
  await cancelRun(Number(rows[0].child_run_id));
  await settle();
  rows = await rowsOf(id);
  assert.equal(
    rows.filter((r) => r.status === "started").length,
    LIMITS.activePerTree,
    "a freed slot is reused",
  );
  assert.equal(rows.filter((r) => r.status === "queued").length, 1);
  for (const r of rows) if (r.child_run_id) runs.push(Number(r.child_run_id));
});

test("overhead benchmark: delegation bookkeeping vs a plain run (no model calls; stubs)", async () => {
  const t0 = performance.now();
  const plain = await parent("bench-plain", []);
  const plainMs = performance.now() - t0;
  const t1 = performance.now();
  const deleg = await parent("bench-deleg", [ask({ request: "bench child" })]);
  const delegMs = performance.now() - t1;
  const childRun = Number((await rowsOf(deleg))[0].child_run_id);
  const tChild = await one<{ ms: number }>(
    pool,
    "SELECT extract(epoch FROM finished_at - created_at)*1000 AS ms FROM workflow_runs WHERE id=$1",
    [childRun],
  );
  const t2 = performance.now();
  const r = await dispatchDelegations();
  const idleMs = performance.now() - t2;
  const statements = await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM workflow_events WHERE run_id=$1 AND content LIKE 'child workflow%'",
    [deleg],
  );
  console.log(
    `BENCH delegation: plain parent ${plainMs.toFixed(0)} ms; parent + 1 blocking child ${delegMs.toFixed(0)} ms (child run itself ${Number(tChild!.ms).toFixed(0)} ms); idle dispatcher pass ${idleMs.toFixed(1)} ms ${JSON.stringify(r)}; extra LLM calls 0; events ${statements!.n}`,
  );
  assert.equal((await getRun(plain)).status, "COMPLETED");
  assert.equal((await getRun(deleg)).status, "COMPLETED");
  assert.ok(idleMs < 1000, "an idle dispatcher pass is cheap");
});
