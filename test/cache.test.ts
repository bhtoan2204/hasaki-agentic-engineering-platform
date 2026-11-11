import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { pool, q, one, withTx } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import {
  CacheAside,
  StaleWhileRevalidate,
  cacheListenerState,
  cacheStats,
  singleflight,
  startCacheInvalidation,
  stopCacheInvalidation,
} from "../src/cache/index.ts";
import { repositories } from "../src/repos/service.ts";
import { knowledge } from "../src/knowledge/service.ts";

/**
 * In-process caches: hit/miss/TTL, no stale write-back after an invalidation, isolation of returned values, local
 * write invalidation (commit only), cross-process invalidation through NOTIFY, bypass while the listener is down.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(25);
  }
  throw new Error("condition not reached");
}
/** A raw connection: writes through it bypass q()/one(), like another platform process would. */
let other: pg.Client;

before(async () => {
  await migrate();
  other = new pg.Client({ connectionString: config.databaseUrl });
  await other.connect();
});
after(async () => {
  await stopCacheInvalidation();
  await other.end();
  await pool.end();
});

test("CacheAside: one load for concurrent misses, TTL expiry, no stale write-back, clones", async () => {
  let loads = 0;
  const c = new CacheAside<{ n: number }>("t.basic", ["t_basic"], 80);
  const load = async () => (loads++, await sleep(30), { n: loads });
  const [a, b, d] = await Promise.all([c.get("k", load), c.get("k", load), c.get("k", load)]);
  assert.equal(loads, 1, "singleflight per key");
  assert.deepEqual([a.n, b.n, d.n], [1, 1, 1]);
  a.n = 999; // callers get clones: mutating one never corrupts the cache
  assert.equal((await c.get("k", load)).n, 1);
  await sleep(100);
  assert.equal((await c.get("k", load)).n, 2, "expired after TTL");
  // Invalidation while a load is in flight: the result is returned but not kept (it may predate the write).
  const slow = c.get("x", async () => (await sleep(40), { n: 7 }));
  await sleep(5);
  c.clear();
  assert.equal((await slow).n, 7);
  assert.equal(
    (await c.get("x", async () => ({ n: 8 }))).n,
    8,
    "the pre-invalidation value was not stored",
  );
});

test("singleflight and stale-while-revalidate", async () => {
  let n = 0;
  const f = () => singleflight("same", async () => (await sleep(20), ++n));
  assert.deepEqual(await Promise.all([f(), f(), f()]), [1, 1, 1]);
  assert.equal(await f(), 2, "a finished flight is not reused");
  let v = 0;
  const swr = new StaleWhileRevalidate<number>("t.swr", 30, 10_000);
  assert.equal(await swr.get("k", async () => ++v), 1);
  await sleep(40);
  assert.equal(
    await swr.get("k", async () => (await sleep(20), ++v)),
    1,
    "stale value served at once",
  );
  await sleep(40);
  assert.equal(await swr.get("k", async () => ++v), 2, "refreshed in the background");
});

test("this process: a committed write clears the cache at once; a rolled-back one does not", async () => {
  await repositories.upsert("cache-r1", { description: "v1" });
  assert.equal((await repositories.get("cache-r1"))!.description, "v1");
  const misses = cacheStats.repositories?.misses ?? 0;
  await repositories.get("cache-r1");
  assert.equal(cacheStats.repositories.misses, misses, "served from cache");
  await repositories.upsert("cache-r1", { description: "v2" });
  assert.equal((await repositories.get("cache-r1"))!.description, "v2", "read your own write");
  const inval = cacheStats.repositories.invalidations;
  await assert.rejects(
    withTx(async (c) => {
      await q(c, "UPDATE repositories SET description = 'rolled back' WHERE name = 'cache-r1'");
      // Inside the writing transaction the cache is bypassed: it sees its own write.
      assert.equal((await repositories.get("cache-r1", c))!.description, "rolled back");
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(cacheStats.repositories.invalidations, inval, "no invalidation for a rollback");
  assert.equal((await repositories.get("cache-r1"))!.description, "v2");
});

test("other processes: NOTIFY from the database trigger clears the cache; listener down → caches bypassed", async () => {
  await startCacheInvalidation();
  assert.equal(cacheListenerState(), "connected");
  await repositories.upsert("cache-r2", { description: "a" });
  assert.equal((await repositories.get("cache-r2"))!.description, "a");
  // Another process writes (no local hook here): only the trigger + listener can tell this process.
  await other.query(
    "UPDATE repositories SET description = 'from another process' WHERE name = 'cache-r2'",
  );
  await until(
    async () => (await repositories.get("cache-r2"))!.description === "from another process",
  );

  await knowledge.create({
    key: "cache-k1",
    category: "business_rule",
    scope_type: "GLOBAL",
    title: "k",
    content: "one",
  });
  const contentOf = async () =>
    (await knowledge.candidates(pool, null)).find((k) => k.key === "cache-k1")?.content;
  assert.equal(await contentOf(), "one");
  await other.query(
    "UPDATE knowledge_versions SET content = 'two' WHERE item_id = (SELECT id FROM knowledge_items WHERE key = 'cache-k1')",
  );
  await until(async () => (await contentOf()) === "two");

  // Drop the listener's connection (VPN blip): caches are flushed and bypassed until it is back.
  await other.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = 'LISTEN cache_invalidate' AND pid <> pg_backend_pid()",
  );
  await until(() => cacheListenerState() === "down");
  const before = cacheStats.repositories.misses;
  await repositories.get("cache-r2");
  await repositories.get("cache-r2");
  assert.equal(
    cacheStats.repositories.misses,
    before,
    "bypassed: neither a hit nor a cached miss while down",
  );
  await other.query("UPDATE repositories SET description = 'while down' WHERE name = 'cache-r2'");
  assert.equal(
    (await repositories.get("cache-r2"))!.description,
    "while down",
    "never stale while the listener is down",
  );
  await until(() => cacheListenerState() === "connected", 8000);
  assert.equal((await repositories.get("cache-r2"))!.description, "while down");
  await stopCacheInvalidation();
});

test("knowledge candidates from the cache honour effective dates exactly like the database query", async () => {
  await knowledge.create({
    key: "cache-k2",
    category: "business_rule",
    scope_type: "GLOBAL",
    title: "k2",
    content: "old",
  });
  const future = new Date(Date.now() + 86400_000);
  await knowledge.update("cache-k2", { content: "new", effective_from: future.toISOString() });
  const at = async (d: Date) =>
    (await knowledge.candidates(pool, null, d)).find((k) => k.key === "cache-k2")?.content;
  assert.equal(await at(new Date()), "old");
  assert.equal(
    await at(new Date(future.getTime() + 1000)),
    "new",
    "the cached set keeps future-dated versions",
  );
  assert.equal(
    await at(new Date(Date.now() - 86400_000)),
    "old",
    "an instant before the load falls back to the database",
  );
  const row = await one(pool, "SELECT current_version FROM knowledge_items WHERE key = 'cache-k2'");
  assert.equal(row.current_version, 2);
});
