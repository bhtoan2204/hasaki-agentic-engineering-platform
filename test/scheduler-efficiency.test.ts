import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { measureQueries } from "../src/eval/performance.ts";
import { claimJob, reconcileAutomaticHandoff } from "../src/workflow/scheduler.ts";
import { heartbeat } from "../src/workflow/engine.ts";

before(async () => {
  await migrate();
});

after(async () => {
  await pool.end();
});

test("idle claims do not each scan automatic handoffs", async () => {
  const observed = await measureQueries(pool, async () => {
    for (let i = 0; i < 8; i++) assert.equal(await claimJob(`idle-${i}`, 30), undefined);
  });
  assert.equal(observed.query_calls, 8);
  assert.equal(observed.query_failures, 0);
});

test("concurrent handoff reconciliation shares one scan and the next call scans again", async () => {
  const concurrent = await measureQueries(pool, async () => {
    await Promise.all([reconcileAutomaticHandoff(), reconcileAutomaticHandoff()]);
  });
  assert.equal(concurrent.query_calls, 1);
  const sequential = await measureQueries(pool, async () => {
    await reconcileAutomaticHandoff();
    await reconcileAutomaticHandoff();
  });
  assert.equal(sequential.query_calls, 2);
});

test("heartbeat executes one query to extend the lease and check stopping handoff", async () => {
  const observed = await measureQueries(pool, async () => {
    assert.equal(await heartbeat(999999, 1, 30, 999999), false);
  });
  assert.equal(observed.query_calls, 1);
  assert.equal(observed.query_failures, 0);
});
