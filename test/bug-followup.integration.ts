import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser } from "../src/auth/users.ts";
import { repositories } from "../src/repos/service.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, cancelRun, getRun } from "../src/workflow/engine.ts";
import { workItems } from "../src/workitems/service.ts";
import { branchFor } from "../src/workflow/branches.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";

const REPO = "followup-frontend";
const PARENT_BRANCH = "u1-HSK-PARENT1";
let ownerId: number;
const runs: number[] = [];

before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  ownerId = (
    await createUser({
      username: "bug-followup-owner",
      password: "bug-followup-pw",
      role: "member",
    })
  ).id;
  await repositories.upsert(REPO, { projects: ["FUP"], default_branch: "main" });
  for (const key of ["bug-from-task", "refactor-from-task"]) {
    const template = TEMPLATES.find((t) => t.key === key);
    assert.ok(template);
    await definitions.create({ key, spec: template.spec as never });
  }
  await definitions.create({
    key: "fup-parent",
    spec: {
      name: "Parent",
      steps: [{ key: "work", type: "agent", config: { instructions: "Work" } }],
    },
  });
});
afterEach(async () => {
  for (const id of runs.splice(0)) await cancelRun(id);
  await settleBackground();
});
after(async () => {
  await settleBackground();
  await pool.end();
});

async function parentTask(code: string, withBranch = true, branch = PARENT_BRANCH) {
  const parent = await workItems.createManual({
    title: "Preview promotion",
    description: "Parent",
    project: "FUP",
    code,
    ownerId,
  });
  const run = await startRun({
    definitionKey: "fup-parent",
    workItemId: parent.id,
    ownerId,
    start: false,
  });
  runs.push(run.id);
  if (withBranch)
    await q(
      pool,
      `INSERT INTO pull_requests (provider, repo, source_branch, target_branch, url, title, work_item_id, run_id)
       VALUES ('bitbucket', $1, $2, 'main', $3, 'Parent PR', $4, $5)`,
      [REPO, branch, `https://example.test/pr/${code}`, parent.id, run.id],
    );
  return { parent, run };
}

test("bug-from-task is the bug investigation flow, on the parent's branch, with the repositories preselected", () => {
  const base = TEMPLATES.find((t) => t.key === "bug-investigation")!.spec as {
    steps: Array<{ key: string; config?: Record<string, unknown> }>;
  };
  const t = TEMPLATES.find((t) => t.key === "bug-from-task")!.spec as typeof base & {
    inputs: Record<string, { required: boolean }>;
  };
  assert.deepEqual(
    t.steps.map((s) => s.key),
    base.steps.map((s) => s.key),
  );
  assert.equal(t.inputs.parent_task.required, true);
  const confirm = t.steps.find((s) => s.key === "confirm_repos")!;
  assert.equal(confirm.config?.auto_approve_preselected, true);
  const analyze = t.steps.find((s) => s.key === "analyze")!;
  assert.match(
    String(analyze.config?.instructions),
    /^This bug was found on QC for an earlier task/,
  );
  assert.ok(
    String(analyze.config?.instructions).endsWith(
      String(base.steps.find((s) => s.key === "analyze")!.config?.instructions),
    ),
  );
  assert.equal(
    base.steps.find((s) => s.key === "confirm_repos")!.config?.auto_approve_preselected,
    undefined,
    "the original flow is unchanged",
  );
});

test("a QC bug creates a linked bug task and a run that continues the parent's branch", async () => {
  const { parent, run: parentRun } = await parentTask("HSK-PARENT1");
  const out = await workItems.followUp({
    kind: "bug",
    parentId: parent.id,
    title: "Gift not cleared when the parent SKU is removed",
    description: "On QC: remove the parent SKU, the gift line stays.\nSecond line.",
    ownerId,
    start: false,
  });
  runs.push(out.run.id);
  assert.equal(out.item.code, "HSK-PARENT1-BUG-1");
  assert.equal(out.item.title, "[Bug] Gift not cleared when the parent SKU is removed");
  assert.equal(out.item.project, "FUP");
  assert.deepEqual(out.item.payload, {
    kind: "bug",
    parent_code: "HSK-PARENT1",
    parent_id: parent.id,
    branches: { [REPO]: PARENT_BRANCH },
  });
  const run = await getRun(out.run.id);
  assert.equal(run.definition_key, "bug-from-task");
  assert.equal(run.work_item_id, out.item.id);
  assert.equal(run.inputs?.parent_task, "HSK-PARENT1");
  assert.deepEqual(run.inputs?.parent_pull_requests, ["https://example.test/pr/HSK-PARENT1"]);
  assert.deepEqual(run.inputs?.repositories, [REPO]);
  assert.deepEqual(branchFor(run, REPO), { branch: PARENT_BRANCH, existing: true });
  const events = (
    await q(pool, "SELECT content FROM workflow_events WHERE run_id = $1", [parentRun.id])
  ).map((e) => String(e.content));
  assert.ok(
    events.some((l) => l.includes("HSK-PARENT1-BUG-1") && l.includes(`run #${out.run.id}`)),
  );
  const second = await workItems.followUp({
    kind: "bug",
    parentId: parent.id,
    description: "Another QC finding",
    ownerId,
    start: false,
  });
  runs.push(second.run.id);
  assert.equal(second.item.code, "HSK-PARENT1-BUG-2");
  assert.equal(second.item.title, "[Bug] Another QC finding");
});

test("a bug needs a description, a parent that exists and a parent that has a branch to continue", async () => {
  const { parent } = await parentTask("HSK-NOBRANCH", false);
  await assert.rejects(
    workItems.followUp({
      kind: "bug",
      parentId: parent.id,
      description: "  ",
      ownerId,
      start: false,
    }),
    /describe the bug/,
  );
  await assert.rejects(
    workItems.followUp({
      kind: "bug",
      parentId: 999999999,
      description: "x",
      ownerId,
      start: false,
    }),
    /not found/,
  );
  await assert.rejects(
    workItems.followUp({
      kind: "bug",
      parentId: parent.id,
      description: "x",
      ownerId,
      start: false,
    }),
    /has no branch yet/,
  );
  const none = await q(
    pool,
    "SELECT 1 FROM work_items WHERE payload->>'parent_code' = 'HSK-NOBRANCH'",
  );
  assert.equal(none.length, 0, "no bug task is created when nothing can be continued");
});

test("refactor-from-task is the refactoring flow, on the parent's branch, with the goal and parent as inputs", () => {
  const base = TEMPLATES.find((t) => t.key === "refactoring")!.spec as {
    steps: Array<{ key: string; config?: Record<string, unknown> }>;
  };
  const t = TEMPLATES.find((t) => t.key === "refactor-from-task")!.spec as typeof base & {
    inputs: Record<string, { required: boolean }>;
  };
  assert.deepEqual(
    t.steps.map((s) => s.key),
    base.steps.map((s) => s.key),
  );
  assert.equal(t.inputs.parent_task.required, true);
  assert.equal(t.inputs.goal.required, true);
  const analyze = t.steps.find((s) => s.key === "analyze")!;
  assert.match(
    String(analyze.config?.instructions),
    /^This work finishes or improves an earlier task/,
  );
  assert.ok(
    String(analyze.config?.instructions).endsWith(
      String(base.steps.find((s) => s.key === "analyze")!.config?.instructions),
    ),
  );
  assert.ok(
    !t.steps.some((s) => ["root_cause", "proof", "approve_fix"].includes(s.key)),
    "no bug-only gates in a refactor",
  );
});

test("a refactor follow-up creates a linked refactor task and a run that continues the parent's branch with the goal", async () => {
  const { parent, run: parentRun } = await parentTask("HSK-PARENT2", true, "u1-HSK-PARENT2");
  const out = await workItems.followUp({
    kind: "refactor",
    parentId: parent.id,
    title: "Finish the tracing migration in the remaining services",
    description: "Move techcom, vnpay, gateway and auth to the shared tracing library.",
    ownerId,
    start: false,
  });
  runs.push(out.run.id);
  assert.equal(out.item.code, "HSK-PARENT2-REF-1");
  assert.equal(out.item.title, "[Refactor] Finish the tracing migration in the remaining services");
  assert.deepEqual(out.item.payload, {
    kind: "refactor",
    parent_code: "HSK-PARENT2",
    parent_id: parent.id,
    branches: { [REPO]: "u1-HSK-PARENT2" },
  });
  const run = await getRun(out.run.id);
  assert.equal(run.definition_key, "refactor-from-task");
  assert.equal(
    run.inputs?.goal,
    "Move techcom, vnpay, gateway and auth to the shared tracing library.",
  );
  assert.equal(run.inputs?.parent_task, "HSK-PARENT2");
  assert.deepEqual(branchFor(run, REPO), { branch: "u1-HSK-PARENT2", existing: true });
  const events = (
    await q(pool, "SELECT content FROM workflow_events WHERE run_id = $1", [parentRun.id])
  ).map((e) => String(e.content));
  assert.ok(events.some((l) => l.startsWith("Refactor HSK-PARENT2-REF-1")));
  const bug = await workItems.followUp({
    kind: "bug",
    parentId: parent.id,
    description: "A QC finding",
    ownerId,
    start: false,
  });
  runs.push(bug.run.id);
  assert.equal(bug.item.code, "HSK-PARENT2-BUG-1", "bugs and refactors are numbered separately");
});

test("an unknown kind or an empty refactor goal is refused", async () => {
  const { parent } = await parentTask("HSK-PARENT3", true, "u1-HSK-PARENT3");
  await assert.rejects(
    workItems.followUp({
      kind: "feature" as never,
      parentId: parent.id,
      description: "x",
      ownerId,
      start: false,
    }),
    /kind must be bug or refactor/,
  );
  await assert.rejects(
    workItems.followUp({
      kind: "refactor",
      parentId: parent.id,
      description: " ",
      ownerId,
      start: false,
    }),
    /describe what to refactor/,
  );
});
