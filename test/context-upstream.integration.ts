import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { ensureTestOwner } from "../src/auth/testOwner.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, getRun } from "../src/workflow/engine.ts";
import { buildStepInput } from "../src/workflow/context.ts";
import { settleBackground } from "../src/workflow/background.ts";

let owner: number;
const key = `upstream-${Date.now().toString(36)}`;
before(async () => {
  await migrate();
  owner = await ensureTestOwner();
  const cmd = (k: string, depends_on: string[] = []) => ({
    key: k,
    type: "command",
    depends_on,
    config: { command: "true" },
  });
  await definitions.create({
    key,
    spec: {
      name: key,
      steps: [
        cmd("a"),
        cmd("b", ["a"]),
        cmd("side"),
        cmd("c", ["b", "side"]),
        cmd("unrelated"),
        cmd("d", ["c"]),
      ],
    } as never,
  });
});
after(async () => {
  await settleBackground();
  await pool.end();
});

test("upstream holds exactly the ancestors' status, attempt and output, as the dedicated query returned them", async () => {
  const created = await startRun({
    definitionKey: key,
    title: "upstream",
    ownerId: owner,
    start: false,
  });
  await q(
    pool,
    "UPDATE workflow_steps SET status='COMPLETED', output=jsonb_build_object('who', key) WHERE run_id=$1 AND key IN ('a','b','unrelated')",
    [created.id],
  );
  const run = await getRun(created.id);
  const step = run.steps.find((s) => s.key === "d")!;
  const { upstream } = await buildStepInput(pool, run as never, step as never);
  const expected = await q(
    pool,
    "SELECT key, status, current_attempt_id, output FROM workflow_steps WHERE run_id=$1 AND key IN ('a','b','side','c') ORDER BY position",
    [created.id],
  );
  assert.deepEqual(
    Object.keys(upstream),
    expected.map((r) => r.key),
  );
  for (const r of expected)
    assert.deepEqual(upstream[r.key], {
      status: r.status,
      attempt_id: r.current_attempt_id,
      output: r.output,
    });
  assert.equal(upstream.a.output?.who, "a");
  assert.equal("unrelated" in upstream, false);
  const first = run.steps.find((s) => s.key === "a")!;
  assert.deepEqual((await buildStepInput(pool, run as never, first as never)).upstream, {});
});
