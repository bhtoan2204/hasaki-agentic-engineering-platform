import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { positiveInt } from "../src/config.ts";
import { pool, withTx } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { finishAttempt } from "../src/workflow/engine.ts";

before(() => migrate());
after(() => pool.end());

test("pool settings reject NaN, fractions, and non-positive values", () => {
  assert.equal(positiveInt("database.poolMax", 10), 10);
  assert.equal(positiveInt("database.poolMax", " 4 "), 4);
  for (const raw of [0, -1, 1.5, NaN, Infinity, "nope", "", "  ", true, null])
    assert.throws(() => positiveInt("database.poolMax", raw), /positive integer/);
});

test("withTx releases the client before afterCommit, in order, and keeps committed rows", async () => {
  await pool.query("DROP TABLE IF EXISTS pool_probe");
  await pool.query("CREATE TABLE pool_probe (id int PRIMARY KEY)");
  const order: string[] = [];
  let checkedOut = -1;
  const out = await withTx(async (c, afterCommit) => {
    await c.query("INSERT INTO pool_probe (id) VALUES (1)");
    afterCommit(async () => {
      checkedOut = pool.totalCount - pool.idleCount;
      order.push("a");
      order.push(String((await pool.query("SELECT count(*)::int AS n FROM pool_probe")).rows[0].n));
    });
    afterCommit(() => {
      order.push("b");
    });
    return "ok";
  });
  assert.equal(out, "ok");
  assert.equal(checkedOut, 0);
  assert.deepEqual(order, ["a", "1", "b"]);
});

test("rollback skips afterCommit and returns a usable client", async () => {
  let ran = false;
  await assert.rejects(
    () =>
      withTx(async (c, afterCommit) => {
        afterCommit(() => {
          ran = true;
        });
        await c.query("CREATE TABLE rollback_probe (id int PRIMARY KEY)");
        await c.query("INSERT INTO rollback_probe (id) VALUES (1)");
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(ran, false);
  await assert.rejects(pool.query("SELECT 1 FROM rollback_probe"), /rollback_probe/);
  assert.equal((await pool.query("SELECT 1 AS n")).rows[0].n, 1);
});

test("a failed COMMIT skips afterCommit and does not leave the client aborted", async () => {
  let ran = false;
  await assert.rejects(
    () =>
      withTx(async (c, afterCommit) => {
        afterCommit(() => {
          ran = true;
        });
        await c.query("CREATE TABLE commit_fail_parent (id int PRIMARY KEY)");
        await c.query("CREATE TABLE commit_fail_child (id int PRIMARY KEY, parent_id int, CONSTRAINT commit_fail_fk FOREIGN KEY (parent_id) REFERENCES commit_fail_parent(id) DEFERRABLE INITIALLY DEFERRED)");
        await c.query("INSERT INTO commit_fail_child (id, parent_id) VALUES (1, 99)");
      }),
    /commit_fail_fk/,
  );
  assert.equal(ran, false);
  await assert.rejects(pool.query("SELECT 1 FROM commit_fail_child"), /commit_fail_child/);
  assert.equal((await pool.query("SELECT 1 AS n")).rows[0].n, 1);
});

test("an afterCommit error leaves the committed row in place", async () => {
  const out = await withTx(async (c, afterCommit) => {
    await c.query("INSERT INTO pool_probe (id) VALUES (2)");
    afterCommit(() => {
      throw new Error("hook boom");
    });
    return 7;
  });
  assert.equal(out, 7);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pool_probe WHERE id = 2")).rows[0].n, 1);
});

test("pool max=1: afterCommit can query without waiting for the transaction client", async () => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 1000 });
  try {
    let seen = 0;
    await withTx(async (c, afterCommit) => {
      await c.query("SELECT 1");
      afterCommit(async () => {
        seen = (await db.query("SELECT 2 AS n")).rows[0].n;
      });
    }, db);
    assert.equal(seen, 2);
  } finally {
    await db.end();
  }
});

test("with one free pool client, finishAttempt does not borrow a second connection", async () => {
  const max = pool.options.max;
  assert.equal(max, 10);
  const held: pg.PoolClient[] = [];
  for (let i = 0; i < max - 1; i++) held.push(await pool.connect());
  try {
    const started = Date.now();
    const result = await finishAttempt(1, 1, 999_999_999, { kind: "failed", error: "not a real attempt", retryable: false });
    assert.deepEqual(result, { applied: false, reason: "attempt not found" });
    assert.ok(Date.now() - started < 1000, `finishAttempt waited ${Date.now() - started}ms for a second connection`);
  } finally {
    for (const c of held) c.release();
  }
});

test("lookup indexes from migration 012 exist", async () => {
  const names = (await pool.query("SELECT indexname FROM pg_indexes WHERE indexname IN ('workflow_checkpoints_attempt', 'workflow_step_attempts_job') ORDER BY 1")).rows.map(
    (r) => r.indexname,
  );
  assert.deepEqual(names, ["workflow_checkpoints_attempt", "workflow_step_attempts_job"]);
});
