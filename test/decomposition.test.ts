import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIMITS,
  planHash,
  shouldDecompose,
  validateExpansion,
  type DecompositionPlan,
} from "../src/workflow/decomposition.ts";

const sub = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id,
  description: "d",
  objective: "o",
  expected_output: "e",
  acceptance_criteria: ["ac"],
  target_repos: ["repo-a"],
  code_context: [],
  depends_on: [],
  permissions: [],
  risk: "low" as const,
  complexity: "low" as const,
  execution_strategy: "parallel" as const,
  agent_role: "coder",
  testing: [],
  owned_files: [],
  ...over,
});
const plan = (...s: ReturnType<typeof sub>[]): DecompositionPlan => ({ summary: "s", subtasks: s });
const ctx = { existingKeys: ["plan"], allowedRepositories: ["repo-a"], limits: DEFAULT_LIMITS };

test("small task is not decomposed; large one is", () => {
  assert.equal(shouldDecompose({ repositories: 1, acceptance_criteria: 2, estimated_effort_hours: 1 }).decompose, false);
  assert.equal(shouldDecompose({ repositories: 2, acceptance_criteria: 5, estimated_effort_hours: 2 }).decompose, true);
});

test("valid independent plan passes", () => {
  assert.deepEqual(validateExpansion(plan(sub("a"), sub("b")), ctx).errors, []);
});

test("rejects cycles, unknown deps, duplicates, foreign repos, over limit", () => {
  const e = (p: DecompositionPlan, c = ctx) => validateExpansion(p, c).errors.join("|");
  assert.match(e(plan(sub("a", { depends_on: ["b"] }), sub("b", { depends_on: ["a"] }))), /cycle/);
  assert.match(e(plan(sub("a", { depends_on: ["zzz"] }))), /unknown/);
  assert.match(e(plan(sub("a"), sub("a"))), /duplicate/);
  assert.match(e(plan(sub("a", { target_repos: ["other"] }))), /outside the allowed/);
  assert.match(e(plan(sub("a"), sub("b")), { ...ctx, limits: { ...DEFAULT_LIMITS, max_subtasks: 1 } }), /limit/);
});

test("overlapping file ownership is serialized", () => {
  const r = validateExpansion(plan(sub("a", { owned_files: ["x.ts"] }), sub("b", { owned_files: ["x.ts"] })), ctx);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.subtasks[1].depends_on, ["a"]);
  assert.equal(r.subtasks[1].execution_strategy, "sequential");
});

test("planHash is order independent", () => {
  assert.equal(planHash(plan(sub("a"), sub("b"))), planHash(plan(sub("b"), sub("a"))));
  assert.notEqual(planHash(plan(sub("a"))), planHash(plan(sub("b"))));
});

import { materializeSubtasks } from "../src/workflow/decomposition.ts";

type Row = Record<string, any>;
/** In-memory fake of the pg client covering only the statements materializeSubtasks issues. */
function fakeDb(steps: Row[]) {
  const revisions: Row[] = [];
  const inserted: Row[] = [];
  const db: any = {
    async query(sql: string, p: any[] = []) {
      if (/FROM workflow_runs/.test(sql)) return { rows: [{ id: p[0] }] };
      if (/FROM workflow_steps WHERE run_id/.test(sql)) return { rows: steps };
      if (/SELECT revision FROM workflow_graph_revisions/.test(sql))
        return { rows: revisions.filter((r) => r.key === p[0]).map((r) => ({ revision: r.revision })) };
      if (/SELECT kind FROM workflow_graph_revisions/.test(sql)) return { rows: revisions.map((r) => ({ kind: r.kind })) };
      if (/INSERT INTO workflow_graph_revisions/.test(sql)) {
        revisions.push({ revision: p[1], kind: p[2], actor: p[4], key: p[6] });
        return { rows: [] };
      }
      if (/INSERT INTO workflow_steps/.test(sql)) {
        const row = {
          id: 100 + steps.length,
          key: p[1],
          type: sql.includes("'integration'") ? "integration" : "coding_agent",
          config: JSON.parse(p[5]),
          depends_on: p[4],
          requires_approval: p[9],
          position: p[3],
          status: "PENDING",
          subtask_id: p[7] ?? null,
        };
        inserted.push(row);
        steps.push(row);
        return { rows: [] };
      }
      if (/UPDATE workflow_steps SET depends_on/.test(sql)) {
        const st = steps.find((x) => x.id === p[0])!;
        st.depends_on = p[1];
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return { db, revisions, inserted };
}
let gateId = 10;
/** Plan step + one downstream step + a completed approval gate per approved plan (hash-bound, current generation). */
const baseSteps = (...approved: { p: DecompositionPlan; kind?: string; by?: string }[]): Row[] => [
  { id: 1, key: "plan", position: 0, depends_on: [], status: "COMPLETED", subtask_id: null },
  { id: 2, key: "integration", position: 1, depends_on: ["plan"], status: "PENDING", subtask_id: null },
  ...approved.map((a) => ({
    id: gateId++,
    key: `approve-${gateId}`,
    type: "human_approval",
    position: 2,
    depends_on: ["plan"],
    status: "COMPLETED",
    generation: 1,
    subtask_id: null,
    approval: { granted: true, by: a.by ?? "toan", generation: 1, data: { plan_hash: planHash(a.p), kind: a.kind ?? "decomposition" } },
  })),
];
const opts = { actor: "u", reason: "r", allowedRepositories: ["repo-a"] };

test("materialize rewires downstream steps and replays idempotently", async () => {
  const p = plan(sub("a"), sub("b", { depends_on: ["a"] }));
  const f = fakeDb(baseSteps({ p }));
  const r1 = await materializeSubtasks(f.db, 1, "plan", p, opts);
  assert.deepEqual(r1.created, ["subtask-a", "subtask-b"]);
  assert.deepEqual(
    f.inserted.map((s) => s.key),
    ["subtask-a", "subtask-b", "cleanup"],
  );
  const r2 = await materializeSubtasks(f.db, 1, "plan", p, opts);
  assert.equal(r2.replayed, true);
  assert.equal(f.inserted.length, 3);
});

test("materialize makes workspace cleanup wait for the new subtasks too", async () => {
  const p = plan(sub("a"), sub("b", { depends_on: ["a"] }));
  const steps = baseSteps({ p });
  const cleanup = {
    id: 3,
    key: "cleanup",
    type: "integration",
    config: { action: "cleanup_workspaces" },
    position: 3,
    depends_on: [steps[2].key],
    status: "PENDING",
    subtask_id: null,
  };
  const wired = fakeDb([...steps, cleanup]);
  await materializeSubtasks(wired.db, 1, "plan", p, opts);
  assert.deepEqual(cleanup.depends_on, [steps[2].key, "subtask-b"]);
  assert.deepEqual(
    wired.inserted.map((s) => s.key),
    ["subtask-a", "subtask-b"],
    "the pending cleanup is reused",
  );
  const loop = plan(sub("x", { depends_on: ["cleanup"] }));
  const f = fakeDb([...baseSteps({ p: loop }), { ...cleanup, depends_on: [] }]);
  await assert.rejects(materializeSubtasks(f.db, 1, "plan", loop, opts), /cycle/);
});

test("materialize sends a cleanup that is ready but not dispatched back behind the subtasks", async () => {
  const p = plan(sub("a"), sub("b", { depends_on: ["a"] }));
  const steps = baseSteps({ p });
  const ready = {
    id: 3,
    key: "cleanup",
    type: "integration",
    config: { action: "cleanup_workspaces", injected: true },
    position: 3,
    depends_on: [steps[2].key],
    status: "READY",
    generation: 1,
    subtask_id: null,
  };
  const f = fakeDb([...steps, ready]);
  await materializeSubtasks(f.db, 1, "plan", p, opts);
  assert.equal(ready.status, "PENDING");
  assert.equal(ready.generation, 2, "its queued job is fenced out");
  assert.deepEqual(ready.depends_on, [steps[2].key, "subtask-b"]);
  assert.deepEqual(
    f.inserted.map((s) => s.key),
    ["subtask-a", "subtask-b"],
    "no second cleanup",
  );
});

test("materialize adds a cleanup after the subtasks when the run's cleanup already ran", async () => {
  const p = plan(sub("a"), sub("b", { depends_on: ["a"] }));
  const steps = baseSteps({ p });
  const ran = {
    id: 3,
    key: "cleanup",
    type: "integration",
    config: { action: "cleanup_workspaces", injected: true },
    position: 3,
    depends_on: [steps[2].key],
    status: "COMPLETED",
    subtask_id: null,
  };
  const f = fakeDb([...steps, ran]);
  await materializeSubtasks(f.db, 1, "plan", p, opts);
  assert.deepEqual(ran.depends_on, [steps[2].key], "a cleanup that ran is never rewired");
  const added = f.inserted.at(-1)!;
  assert.equal(added.key, "cleanup_2");
  assert.equal(added.type, "integration");
  assert.deepEqual(added.config, { action: "cleanup_workspaces", injected: true });
  assert.deepEqual(
    [...added.depends_on].sort(),
    [steps[2].key, "integration"].sort(),
    "waits for the work after the subtasks, not just the leaves",
  );
  assert.deepEqual(steps[1].depends_on, ["plan", "subtask-b"]);
});

test("materialize rejects a cycle through an existing downstream step", async () => {
  const p = plan(sub("x", { depends_on: ["integration"] }));
  const f = fakeDb(baseSteps({ p }));
  await assert.rejects(materializeSubtasks(f.db, 1, "plan", p, opts), /cycle/);
  assert.equal(f.inserted.length, 0);
});

test("materialize requires a completed plan step", async () => {
  const p = plan(sub("a"));
  const steps = baseSteps({ p });
  steps[0].status = "PENDING";
  await assert.rejects(materializeSubtasks(fakeDb(steps).db, 1, "plan", p, opts), /not approved/);
});

test("approval is bound to the exact plan: a different plan is rejected", async () => {
  const approved = plan(sub("a"));
  const f = fakeDb(baseSteps({ p: approved }));
  await assert.rejects(
    materializeSubtasks(f.db, 1, "plan", plan(sub("a"), sub("evil")), opts),
    /no completed human approval gate approves/,
  );
  assert.equal(f.inserted.length, 0);
});

test("replan needs its own gate approving its own plan; the first gate does not cover it", async () => {
  const first = plan(sub("a"));
  const second = plan(sub("c"));
  const f = fakeDb(baseSteps({ p: first }));
  await materializeSubtasks(f.db, 1, "plan", first, opts);
  await assert.rejects(materializeSubtasks(f.db, 1, "plan", second, { ...opts, kind: "replan" }), /approves this replan plan/);
  // a replan-kind gate that names the replan plan hash authorizes it
  const steps = baseSteps({ p: first }, { p: second, kind: "replan", by: "reviewer" });
  const g = fakeDb(steps);
  await materializeSubtasks(g.db, 1, "plan", first, opts);
  const r = await materializeSubtasks(g.db, 1, "plan", second, { ...opts, kind: "replan" });
  assert.equal(r.revision, 2);
});

test("a stale approval (generation mismatch) is not accepted", async () => {
  const p = plan(sub("a"));
  const steps = baseSteps({ p });
  steps[2].generation = 2;
  await assert.rejects(materializeSubtasks(fakeDb(steps).db, 1, "plan", p, opts), /no completed human approval gate/);
});

test("approver is recorded from the gate, not the caller", async () => {
  const p = plan(sub("a"));
  const f = fakeDb(baseSteps({ p, by: "toan" }));
  await materializeSubtasks(f.db, 1, "plan", p, { ...opts, actor: "someone-else" });
  assert.match(f.revisions[0].actor, /approved by toan/);
});

test("materialize enforces depth limits", async () => {
  const p = plan(sub("z"));
  const steps = baseSteps({ p });
  steps[0].subtask_id = "a";
  await assert.rejects(materializeSubtasks(fakeDb(steps).db, 1, "plan", p, opts), /depth/);
});

test("materialize refuses to rewire downstream steps that already started", async () => {
  const p = plan(sub("a"));
  const steps = baseSteps({ p });
  steps[1].status = "READY";
  await assert.rejects(materializeSubtasks(fakeDb(steps).db, 1, "plan", p, opts), /already active/);
});

test("limits cannot be raised above the hard ceiling", async () => {
  const many = plan(...Array.from({ length: 21 }, (_, i) => sub(`s${i}`)));
  const f = fakeDb(baseSteps({ p: many }));
  await assert.rejects(materializeSubtasks(f.db, 1, "plan", many, { ...opts, limits: { max_subtasks: 1000 } }), /limit is 20/);
});

test("independent subtasks are serialized while the run has a single shared worktree", () => {
  const p = plan(sub("a"), sub("b"), sub("c", { depends_on: ["a"] }));
  const r = validateExpansion(p, { existingKeys: [], allowedRepositories: ["repo-a"], limits: DEFAULT_LIMITS });
  assert.deepEqual(r.errors, []);
  assert.ok(r.subtasks.every((s) => s.execution_strategy === "sequential"));
  const dep = (id: string) => r.subtasks.find((s) => s.id === id)!.depends_on;
  assert.ok(dep("b").includes("a"));
  assert.ok(dep("c").includes("a") && dep("c").includes("b"));
});

test("parallel execution is only kept when isolated workspaces are declared", () => {
  const p = plan(sub("a"), sub("b"));
  const r = validateExpansion(p, { existingKeys: [], allowedRepositories: ["repo-a"], limits: DEFAULT_LIMITS, isolatedWorkspaces: true });
  assert.deepEqual(r.subtasks.map((s) => s.depends_on), [[], []]);
  assert.ok(r.subtasks.every((s) => s.execution_strategy === "parallel"));
});
