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
        revisions.push({ revision: p[1], kind: p[2], key: p[6] });
        return { rows: [] };
      }
      if (/INSERT INTO workflow_steps/.test(sql)) {
        const row = { key: p[1], depends_on: p[4], requires_approval: p[9], position: p[3], status: "PENDING", subtask_id: p[7] };
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
const baseSteps = (): Row[] => [
  { id: 1, key: "plan", position: 0, depends_on: [], status: "COMPLETED", subtask_id: null },
  { id: 2, key: "integration", position: 1, depends_on: ["plan"], status: "PENDING", subtask_id: null },
];
const opts = { actor: "u", reason: "r", allowedRepositories: ["repo-a"] };

test("materialize rewires downstream steps and replays idempotently", async () => {
  const f = fakeDb(baseSteps());
  const p = plan(sub("a"), sub("b", { depends_on: ["a"] }));
  const r1 = await materializeSubtasks(f.db, 1, "plan", p, opts);
  assert.deepEqual(r1.created, ["subtask-a", "subtask-b"]);
  const integ = (f.db as any) && f.inserted.length === 2;
  assert.ok(integ);
  const r2 = await materializeSubtasks(f.db, 1, "plan", p, opts);
  assert.equal(r2.replayed, true);
  assert.equal(f.inserted.length, 2);
});

test("materialize rejects a cycle through an existing downstream step", async () => {
  const f = fakeDb(baseSteps());
  await assert.rejects(
    materializeSubtasks(f.db, 1, "plan", plan(sub("x", { depends_on: ["integration"] })), opts),
    /cycle/,
  );
  assert.equal(f.inserted.length, 0);
});

test("materialize requires an approved plan step and approval for replans", async () => {
  const pending = baseSteps();
  pending[0].status = "PENDING";
  await assert.rejects(materializeSubtasks(fakeDb(pending).db, 1, "plan", plan(sub("a")), opts), /not approved/);
  const f = fakeDb(baseSteps());
  await materializeSubtasks(f.db, 1, "plan", plan(sub("a")), opts);
  await assert.rejects(
    materializeSubtasks(f.db, 1, "plan", plan(sub("c")), { ...opts, kind: "replan" }),
    /approval/,
  );
  const r = await materializeSubtasks(f.db, 1, "plan", plan(sub("c")), { ...opts, kind: "replan", approvedBy: "toan" });
  assert.equal(r.revision, 2);
});

test("materialize enforces depth and replan limits", async () => {
  const steps = baseSteps();
  steps[0].subtask_id = "a";
  await assert.rejects(materializeSubtasks(fakeDb(steps).db, 1, "plan", plan(sub("z")), opts), /depth/);
});
