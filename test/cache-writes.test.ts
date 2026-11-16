import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { CacheAside } from "../src/cache/index.ts";
import { q, withTx, type Db } from "../src/db/pool.ts";

/**
 * Write → invalidation flow with fake database handles (no connection): committed writes clear bound caches,
 * rolled-back ones do not, a transaction's own writes are reported only after COMMIT, per-user keys never mix,
 * and a committed permission change makes the next read reload.
 */

class FakeClient {
  log: string[] = [];
  failOn: string | null = null;
  onQuery?: (sql: string) => void;
  constructor(onQuery?: (sql: string) => void) {
    this.onQuery = onQuery;
  }
  async query(sql: string) {
    this.log.push(sql);
    this.onQuery?.(sql);
    if (this.failOn === sql) throw new Error(`fail ${sql}`);
    return { rows: [], rowCount: 0 };
  }
  release() {}
}
const fakePool = (c: FakeClient) => ({ connect: async () => c }) as unknown as pg.Pool;
const fakeDb = () => new FakeClient() as unknown as Db;

test("committed write outside a transaction clears only caches bound to that table", async () => {
  const a = new CacheAside<number>("w.a", ["w_a"], 60_000);
  const b = new CacheAside<number>("w.b", ["w_b"], 60_000);
  let n = 0;
  await a.get("k", async () => ++n);
  await b.get("k", async () => ++n);
  await q(fakeDb(), "UPDATE w_a SET x = 1");
  assert.equal(a.size, 0);
  assert.equal(b.size, 1);
});

test("transaction: tables are reported after COMMIT; rollback invalidates nothing", async () => {
  const c = new CacheAside<number>("w.tx", ["w_tx"], 60_000);
  await c.get("k", async () => 1);
  let sizeAtCommit = -1;
  const client = new FakeClient((sql) => {
    if (sql === "COMMIT") sizeAtCommit = c.size;
  });
  await withTx(async (cl) => {
    await q(cl, "INSERT INTO w_tx (a) VALUES (1)");
    assert.equal(c.size, 1, "not cleared while the transaction is open");
  }, fakePool(client));
  assert.equal(sizeAtCommit, 1, "still cached when COMMIT runs");
  assert.equal(c.size, 0, "cleared once committed");

  await c.get("k", async () => 2);
  const rb = new FakeClient();
  await assert.rejects(
    withTx(async (cl) => {
      await q(cl, "UPDATE w_tx SET a = 2");
      throw new Error("boom");
    }, fakePool(rb)),
  );
  assert.ok(rb.log.includes("ROLLBACK"));
  assert.equal(c.size, 1, "rolled-back write leaves the cache intact");

  const failing = new FakeClient();
  failing.failOn = "COMMIT";
  await assert.rejects(
    withTx(async (cl) => void (await q(cl, "DELETE FROM w_tx")), fakePool(failing)),
  );
  assert.equal(c.size, 1, "failed COMMIT invalidates nothing");
});

test("per-user keys are isolated and a committed permission change reloads at once", async () => {
  const grants: Record<string, string[]> = { "1": ["repo-a"], "2": ["repo-b"] };
  const c = new CacheAside<string[]>("w.access", ["user_repository_access"], 60_000);
  let loads = 0;
  const read = (u: string) => c.get(u, async () => (loads++, [...grants[u]]));
  assert.deepEqual(await read("1"), ["repo-a"]);
  assert.deepEqual(await read("2"), ["repo-b"]);
  assert.deepEqual(await read("1"), ["repo-a"], "user 1 never sees user 2's grants");
  assert.equal(loads, 2);
  grants["1"] = [];
  await q(fakeDb(), "DELETE FROM user_repository_access WHERE user_id = $1", [1]);
  assert.deepEqual(await read("1"), [], "revocation visible immediately");
  assert.deepEqual(await read("2"), ["repo-b"]);
});
