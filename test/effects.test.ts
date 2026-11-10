import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, one, withTx } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { cancelRun, startRun } from "../src/workflow/engine.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { dispatchRunEffects, effectKindsFor, enqueueRunEffects } from "../src/workflow/effects.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";

before(async () => {
  await migrate();
  registerExecutor("agent", { async execute() { return { kind: "completed", output: { summary: "ok" } }; } });
  await definitions.create({ key: "effects-probe", spec: { name: "effects", steps: [{ key: "a", type: "agent" }] } });
});
after(async () => {
  await settleBackground();
  await pool.end();
});

test("terminal effects are summary and outcome, plus memory and learning only when completed", () => {
  assert.deepEqual(effectKindsFor("COMPLETED"), ["summary", "outcome", "memory", "learning"]);
  assert.deepEqual(effectKindsFor("FAILED"), ["summary", "outcome"]);
  assert.deepEqual(effectKindsFor("CANCELED"), ["summary", "outcome"]);
  assert.deepEqual(effectKindsFor("WAITING"), []);
  assert.deepEqual(effectKindsFor("RUNNING"), []);
});

test("cancel stores summary and outcome after the committed effect rows are dispatched", async () => {
  const run = await startRun({ definitionKey: "effects-probe" });
  await cancelRun(run.id, "stop");
  await settleBackground();
  const row = await one(pool, "SELECT status, summary, outcome FROM workflow_runs WHERE id = $1", [run.id]);
  assert.equal(row.status, "CANCELED");
  assert.equal(row.summary.run.status, "CANCELED");
  assert.equal(row.outcome.run_status, "CANCELED");
  assert.equal((await one(pool, "SELECT count(*)::int AS n FROM workflow_run_effects WHERE run_id = $1", [run.id])).n, 0);
});

test("effect rows committed without a worker survive until dispatch, then a second dispatch is a no-op", async () => {
  const run = await startRun({ definitionKey: "effects-probe" });
  await pool.query("UPDATE workflow_runs SET status = 'CANCELED', finished_at = now() WHERE id = $1", [run.id]);
  await withTx(async (c) => { await enqueueRunEffects(c, run.id, "CANCELED"); });
  const pending = await one(pool, "SELECT array_agg(kind ORDER BY kind) AS kinds FROM workflow_run_effects WHERE run_id = $1", [run.id]);
  assert.deepEqual(pending.kinds, ["outcome", "summary"]);
  const claimed = await dispatchRunEffects();
  assert.ok(claimed >= 2);
  const row = await one(pool, "SELECT summary, outcome FROM workflow_runs WHERE id = $1", [run.id]);
  assert.equal(row.summary.run.status, "CANCELED");
  assert.equal(row.outcome.run_status, "CANCELED");
  assert.equal((await one(pool, "SELECT count(*)::int AS n FROM workflow_run_effects WHERE run_id = $1", [run.id])).n, 0);
  assert.equal(await dispatchRunEffects(), 0);
});
