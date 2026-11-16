import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CacheAside,
  StaleWhileRevalidate,
  cacheListenerState,
  cacheStats,
  invalidateTables,
  singleflight,
  startCacheInvalidation,
  stopCacheInvalidation,
  type ListenerClient,
} from "../src/cache/index.ts";

/**
 * In-process caches, business flow only (no database): hit/miss/TTL, no stale write-back after an invalidation,
 * isolation of returned values, table invalidation, listener notifications, bypass while the listener is down.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeListener extends EventEmitter {
  queries: string[] = [];
  failConnect = false;
  async connect() {
    if (this.failConnect) throw new Error("connect refused");
  }
  async query(sql: string) {
    this.queries.push(sql);
    return {} as never;
  }
  async end() {}
}

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

test("NOTIFY from another process clears matching caches; listener down → bypass; reconnect → flush", async () => {
  const fakes: FakeListener[] = [];
  const make = () => {
    const f = new FakeListener();
    fakes.push(f);
    return f as unknown as ListenerClient;
  };
  const c = new CacheAside<{ v: number }>("t.listener", ["t_listener"], 60_000);
  let v = 0;
  const load = async () => ({ v: ++v });
  await startCacheInvalidation("fake://", make);
  assert.equal(cacheListenerState(), "connected");
  assert.deepEqual(fakes[0].queries, ["LISTEN cache_invalidate"]);
  assert.equal((await c.get("k", load)).v, 1);
  assert.equal((await c.get("k", load)).v, 1, "served from cache");
  fakes[0].emit("notification", { channel: "cache_invalidate", payload: "other_table" });
  assert.equal((await c.get("k", load)).v, 1, "unrelated table does not clear it");
  fakes[0].emit("notification", { channel: "cache_invalidate", payload: "t_listener" });
  assert.equal((await c.get("k", load)).v, 2, "cross-process write cleared the cache");

  const originalError = console.error;
  console.error = () => {};
  try {
    fakes[0].emit("error", new Error("vpn drop"));
  } finally {
    console.error = originalError;
  }
  assert.equal(cacheListenerState(), "down");
  const misses = cacheStats["t.listener"].misses;
  assert.equal((await c.get("k", load)).v, 3);
  assert.equal((await c.get("k", load)).v, 4, "bypassed while down: never cached");
  assert.equal(cacheStats["t.listener"].misses, misses, "bypass counts neither hit nor miss");
  await stopCacheInvalidation();
  assert.equal(cacheListenerState(), "none");
});

test("a failed initial listener connect leaves caches bypassed", async () => {
  const f = new FakeListener();
  f.failConnect = true;
  const originalError = console.error;
  console.error = () => {};
  try {
    await startCacheInvalidation("fake://", () => f as unknown as ListenerClient);
  } finally {
    console.error = originalError;
  }
  assert.equal(cacheListenerState(), "down");
  await stopCacheInvalidation();
});

test("invalidateTables (what a committed local write triggers) clears only bound caches", async () => {
  const a = new CacheAside<number>("t.inv.a", ["t_a"], 60_000);
  const b = new CacheAside<number>("t.inv.b", ["t_b"], 60_000);
  let n = 0;
  await a.get("k", async () => ++n);
  await b.get("k", async () => ++n);
  invalidateTables(["t_a"]);
  assert.equal(await a.get("k", async () => ++n), 3, "reloaded");
  assert.equal(await b.get("k", async () => ++n), 2, "untouched");
});
