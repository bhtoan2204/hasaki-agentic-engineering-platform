import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CacheAside,
  StaleWhileRevalidate,
  cacheSnapshot,
  cacheStats,
  singleflight,
  singleflightInflight,
} from "../src/cache/index.ts";

/** Memory bounds and eviction policy of the in-process caches. In-memory only: no database or network. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("CacheAside evicts least recently used, not first inserted", async () => {
  const c = new CacheAside<number>("b.lru", ["b_lru"], 60_000, 3);
  const load = (n: number) => async () => n;
  for (const k of ["a", "b", "c"]) await c.get(k, load(1));
  await c.get("a", load(99)); // hit: "a" becomes most recent, "b" is now the oldest
  await c.get("d", load(1)); // over capacity: evicts "b"
  assert.equal(c.size, 3);
  assert.equal(await c.get("a", load(99)), 1, "a survived (recently used)");
  assert.equal(await c.get("b", load(42)), 42, "b was evicted");
  assert.ok(cacheStats["b.lru"].evictions.capacity >= 1);
});

test("CacheAside size stays bounded under high key cardinality; a hit does not extend the TTL", async () => {
  const c = new CacheAside<number>("b.card", ["b_card"], 40, 50);
  for (let i = 0; i < 1000; i++) await c.get(`k${i}`, async () => i);
  assert.equal(c.size, 50);
  let loads = 0;
  await c.get("ttl", async () => ++loads);
  await sleep(25);
  await c.get("ttl", async () => ++loads); // hit
  await sleep(25);
  await c.get("ttl", async () => ++loads);
  assert.equal(loads, 2, "expired at the original TTL despite the intermediate hit");
});

test("CacheAside: clear() drops entries and in-flight loads and blocks stale write-back", async () => {
  const c = new CacheAside<number>("b.clear", ["b_clear"], 60_000, 10);
  const slow = c.get("k", async () => (await sleep(30), 1));
  await sleep(5);
  assert.equal(c.inflightCount, 1);
  c.clear();
  assert.equal(c.inflightCount, 0);
  assert.equal(await slow, 1);
  assert.equal(c.size, 0, "pre-invalidation value not stored");
});

test("CacheAside: a failed load does not poison the next call and leaves no in-flight state", async () => {
  const c = new CacheAside<number>("b.fail", ["b_fail"], 60_000, 10);
  await assert.rejects(c.get("k", async () => Promise.reject(new Error("x"))), /x/);
  assert.equal(c.inflightCount, 0);
  assert.equal(await c.get("k", async () => 5), 5);
});

test("StaleWhileRevalidate is bounded by max entries (LRU) and drops entries past maxStale", async () => {
  const s = new StaleWhileRevalidate<number>("b.swr", 10, 60, 5);
  for (let i = 0; i < 100; i++) await s.get(`k${i}`, async () => i);
  assert.equal(s.size, 5);
  await sleep(80);
  let loads = 0;
  assert.equal(await s.get("k99", async () => (loads++, 7)), 7, "past maxStale: reloaded, not served");
  assert.equal(loads, 1);
  assert.ok(cacheStats["b.swr"].evictions.capacity >= 95);
});

test("StaleWhileRevalidate: one refresh per key, a failed background refresh keeps the old value without unhandled rejection", async () => {
  const s = new StaleWhileRevalidate<number>("b.swr2", 10, 10_000, 5);
  assert.equal(await s.get("k", async () => 1), 1);
  await sleep(20);
  let calls = 0;
  const failing = async () => (calls++, await sleep(10), Promise.reject(new Error("down")));
  const originalError = console.error;
  console.error = () => {};
  let unhandled = 0;
  const onUnhandled = () => unhandled++;
  process.on("unhandledRejection", onUnhandled);
  try {
    const got = await Promise.all([s.get("k", failing), s.get("k", failing), s.get("k", failing)]);
    assert.deepEqual(got, [1, 1, 1], "stale value served");
    await sleep(40);
    assert.equal(calls, 1, "single refresh for concurrent callers");
    assert.equal(s.inflightCount, 0);
    assert.equal(unhandled, 0);
    assert.equal(cacheStats["b.swr2"].refreshFailures, 1);
    assert.equal(await s.get("k", async () => 2), 1, "old value still served after failure");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    console.error = originalError;
  }
});

test("singleflight shares concurrent work and retains nothing after resolve or reject", async () => {
  let runs = 0;
  const f = () => singleflight("sf", async () => (await sleep(10), ++runs));
  assert.deepEqual(await Promise.all([f(), f(), f()]), [1, 1, 1]);
  assert.equal(singleflightInflight(), 0);
  await assert.rejects(singleflight("sf-fail", async () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(singleflightInflight(), 0);
  assert.equal(await singleflight("sf-fail", async () => "ok"), "ok", "failure did not poison the key");
});

test("cacheSnapshot exposes fixed names and counters only (no keys)", async () => {
  const c = new CacheAside<number>("b.snap", ["b_snap"], 60_000, 2);
  await c.get("secret-user-key", async () => 1);
  const row = cacheSnapshot().find((r) => r.name === "b.snap")!;
  assert.equal(row.entries, 1);
  assert.equal(row.max, 2);
  assert.ok(!JSON.stringify(cacheSnapshot()).includes("secret-user-key"));
});
