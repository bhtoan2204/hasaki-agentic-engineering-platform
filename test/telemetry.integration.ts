import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";

after(() => pool.end());
test("additive view migrates idempotently and returns nullable metrics", async () => {
  await migrate(pool);
  assert.deepEqual(await migrate(pool), []);
  const columns = (
    await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'execution_attempt_telemetry'",
    )
  ).rows.map((r) => r.column_name);
  for (const name of [
    "run_id",
    "step_id",
    "attempt_id",
    "worker_instance",
    "reasoning_tokens",
    "verification_result",
    "normalized_failure_category",
  ])
    assert.ok(columns.includes(name));
});
