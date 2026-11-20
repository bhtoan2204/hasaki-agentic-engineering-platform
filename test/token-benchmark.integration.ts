import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { aggregateTokenEfficiency, loadAttemptTelemetry } from "../src/report/tokenBenchmark.ts";

before(() => migrate());
after(() => pool.end());

it("loads attempt telemetry against the migrated schema", async () => {
  const rows = await loadAttemptTelemetry(14);
  assert.deepEqual(aggregateTokenEfficiency(rows), []);
});
