import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import { cancelRun, getRun, startRun } from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { repositories } from "../src/repos/service.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";

const holdRuns = new Set<number>();
const started: number[] = [];

before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  await seedTemplates();
  await repositories.upsert("oms-api", { projects: ["OMS"] });
  await repositories.upsert("oms-background", { projects: ["OMS"] });
  registerExecutor("coding_agent", {
    execute: async (ctx) => {
      started.push(ctx.run.id);
      // A held run stays active (WAITING) and keeps its branch lease.
      if (holdRuns.has(ctx.run.id)) {
        await ctx.ask([{ question: "hold?", options: ["ok"] }]);
        return { kind: "waiting_input", checkpoint: { session_id: "s" } };
      }
      return { kind: "completed", output: { done: true } };
    },
  });
});
after(async () => {
  await settleBackground();
  await pool.end();
});

let seq = 0;
async function codingRun(repos: string[], branch: string) {
  const key = `branch-lease-wf-${++seq}`;
  await definitions.create({
    key,
    spec: {
      name: key,
      steps: [{ key: "implement", type: "coding_agent", config: { verify: false } }],
    },
  });
  return startRun({
    definitionKey: key,
    inputs: { project: "OMS", branches: { "*": branch } },
    repositories: repos,
  });
}
const status = async (runId: number) =>
  (await getRun(runId)).steps.find((s) => s.key === "implement")!.status;
const holder = async (repo: string, branch: string) =>
  (
    await q<{ run_id: string }>(
      pool,
      "SELECT run_id FROM workflow_branch_leases WHERE repo = $1 AND branch = $2",
      [repo, branch],
    )
  )[0]?.run_id;
const wakeQueued = () =>
  pool.query("UPDATE workflow_jobs SET available_at = now() WHERE status = 'queued'");

test("a second run on the same repo and branch waits until the holder finishes, then continues", async () => {
  const a = await codingRun(["oms-api"], "shared-1");
  holdRuns.add(a.id);
  await drain();
  assert.equal((await getRun(a.id)).status, "WAITING");
  assert.equal(Number(await holder("oms-api", "shared-1")), a.id);

  const b = await codingRun(["oms-api"], "shared-1");
  await drain();
  assert.ok(!started.includes(b.id), "the waiting run must not start its coding step");
  assert.equal(await status(b.id), "READY");
  const events = await q<{ content: string }>(
    pool,
    "SELECT content FROM workflow_events WHERE run_id = $1",
    [b.id],
  );
  assert.ok(
    events.some((e) => e.content.includes(`run #${a.id}`) && e.content.includes("shared-1")),
  );

  await cancelRun(a.id);
  await wakeQueued();
  await drain();
  assert.equal(await status(b.id), "COMPLETED");
  assert.equal(Number(await holder("oms-api", "shared-1")), b.id);
});

test("different branches, or the same branch in another repo, do not wait", async () => {
  const a = await codingRun(["oms-api"], "shared-2");
  holdRuns.add(a.id);
  await drain();
  const otherBranch = await codingRun(["oms-api"], "shared-2b");
  const otherRepo = await codingRun(["oms-background"], "shared-2");
  await drain();
  assert.equal(await status(otherBranch.id), "COMPLETED");
  assert.equal(await status(otherRepo.id), "COMPLETED");
  await cancelRun(a.id);
});

test("leases are all-or-nothing across repositories, so two runs never deadlock on each other's repos", async () => {
  const a = await codingRun(["oms-api"], "shared-3");
  holdRuns.add(a.id);
  await drain();
  const b = await codingRun(["oms-background", "oms-api"], "shared-3");
  await drain();
  assert.equal(await status(b.id), "READY");
  assert.equal(
    await holder("oms-background", "shared-3"),
    undefined,
    "a waiting run holds no partial lease",
  );
  await cancelRun(a.id);
  await wakeQueued();
  await drain();
  assert.equal(await status(b.id), "COMPLETED");
});

test("the holder's own retries and later steps keep the lease", async () => {
  const a = await codingRun(["oms-api"], "shared-4");
  await drain();
  assert.equal(await status(a.id), "COMPLETED");
  assert.equal(Number(await holder("oms-api", "shared-4")), a.id);
  const b = await codingRun(["oms-api"], "shared-4");
  await drain();
  assert.equal(await status(b.id), "COMPLETED", "a finished holder hands the branch over");
  assert.equal(Number(await holder("oms-api", "shared-4")), b.id);
});
