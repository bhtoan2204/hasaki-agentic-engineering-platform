import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("the test preload owns PostgreSQL and ignores inherited database endpoints", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, TEST_DATABASE_ADMIN_URL: "postgres://unused@remote.invalid/unused" };
  // The probe is an ordinary subprocess, not another worker in the parent's node:test protocol.
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--import", "./test/setup.ts", "--input-type=module", "-e", `
    import pg from 'pg';
    const url = new URL(process.env.DATABASE_URL);
    if (!url.searchParams.get('host')?.startsWith('/')) throw new Error('test-owned socket required');
    const db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    const result = await db.query('SELECT 42 AS answer');
    if (result.rows[0].answer !== 42) throw new Error('query failed');
    await db.end();
  `], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });
  assert.equal(child.status, 0, child.stderr);
});
