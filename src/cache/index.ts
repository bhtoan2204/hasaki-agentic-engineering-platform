import pg from "pg";
import { config } from "../config.ts";
import { onCommittedWrite } from "../db/pool.ts";

/**
 * In-process caches for data that is read often and written rarely. Every read that hits saves a database round trip
 * (~100 ms to the shared RDS).
 *
 *   CacheAside            get(key, load): fresh entry → returned; miss → load once per key (concurrent callers share
 *                         the same load: singleflight), stored unless an invalidation happened meanwhile (generation
 *                         check). Bound to tables: a committed write to one of them clears the cache.
 *   StaleWhileRevalidate  expensive read-mostly aggregates (metrics): a stale value is served at once and refreshed in
 *                         the background; never invalidated by writes, bounded by maxStaleMs.
 *   singleflight          identical concurrent requests share one execution (no storage).
 *
 * Invalidation
 *   this process     q()/one() report committed writes per table (db/pool.ts onCommittedWrite) → synchronous clear.
 *   other processes  database triggers (migration 024) NOTIFY `cache_invalidate` with the table name on COMMIT; the
 *                    listener started by the server clears the matching caches.
 *   listener down    (VPN drop, restart) caches are BYPASSED and flushed: notifications sent meanwhile are lost, so
 *                    nothing cached may be trusted until the listener is back (it flushes again on reconnect).
 *   backstop         every entry also expires after its TTL.
 * Values are returned as structured clones: a caller mutating a row never corrupts the cache.
 * CACHE=off disables all caches (every get loads).
 */

const DISABLED = process.env.CACHE === "off";
type ListenerState = "none" | "connected" | "down";
/** "none": no listener in this process (tests, CLI) → only local writes exist, local invalidation suffices. */
let listener: ListenerState = "none";
const usable = () => !DISABLED && listener !== "down";

/** Counters per cache. Labels are fixed cache names and fixed eviction reasons only: never raw keys or user ids. */
export type CacheStat = {
  hits: number;
  misses: number;
  invalidations: number;
  evictions: { capacity: number; expired: number; invalidated: number };
  refreshFailures: number;
};
export const cacheStats: Record<string, CacheStat> = {};
const stat = (name: string): CacheStat =>
  (cacheStats[name] ??= {
    hits: 0,
    misses: 0,
    invalidations: 0,
    evictions: { capacity: 0, expired: 0, invalidated: 0 },
    refreshFailures: 0,
  });

const registry = new Set<CacheAside<any>>();
const swrRegistry = new Set<StaleWhileRevalidate<any>>();

export class CacheAside<V> {
  private entries = new Map<string, { at: number; value: V }>();
  private inflight = new Map<string, { gen: number; p: Promise<V> }>();
  private gen = 0;
  readonly name: string;
  readonly tables: string[];
  readonly ttlMs: number;
  readonly max: number;
  get size() {
    return this.entries.size;
  }
  get inflightCount() {
    return this.inflight.size;
  }
  constructor(name: string, tables: string[], ttlMs: number, max = 1000) {
    this.name = name;
    this.tables = tables;
    this.ttlMs = ttlMs;
    this.max = max;
    registry.add(this);
  }

  async get(key: string, load: () => Promise<V>): Promise<V> {
    if (!usable()) return load();
    const e = this.entries.get(key);
    if (e && Date.now() - e.at < this.ttlMs) {
      // LRU: a hit moves the entry to the most-recent end; `at` is unchanged so a hit never extends the TTL.
      this.entries.delete(key);
      this.entries.set(key, e);
      stat(this.name).hits++;
      return structuredClone(e.value);
    }
    if (e) {
      this.entries.delete(key);
      stat(this.name).evictions.expired++;
    }
    stat(this.name).misses++;
    const f = this.inflight.get(key);
    if (f && f.gen === this.gen) return structuredClone(await f.p);
    const gen = this.gen;
    const p = load();
    this.inflight.set(key, { gen, p });
    try {
      const v = await p;
      // An invalidation while loading means `v` may predate the write: return it to this caller, do not keep it.
      if (gen === this.gen && usable()) {
        this.entries.delete(key);
        // Map iterates in insertion order, so the first key is the least recently used: O(1) eviction.
        while (this.entries.size >= this.max) {
          this.entries.delete(this.entries.keys().next().value!);
          stat(this.name).evictions.capacity++;
        }
        this.entries.set(key, { at: Date.now(), value: v });
      }
      return structuredClone(v);
    } finally {
      if (this.inflight.get(key)?.p === p) this.inflight.delete(key);
    }
  }

  clear() {
    this.gen++;
    stat(this.name).evictions.invalidated += this.entries.size;
    this.entries.clear();
    this.inflight.clear();
    stat(this.name).invalidations++;
  }
}

export class StaleWhileRevalidate<V> {
  private entries = new Map<string, { at: number; value: V }>();
  private refreshing = new Map<string, Promise<V>>();
  readonly name: string;
  readonly freshMs: number;
  readonly maxStaleMs: number;
  readonly max: number;
  constructor(name: string, freshMs: number, maxStaleMs: number, max = 500) {
    this.name = name;
    this.freshMs = freshMs;
    this.maxStaleMs = maxStaleMs;
    this.max = max;
    swrRegistry.add(this);
  }
  get size() {
    return this.entries.size;
  }
  get inflightCount() {
    return this.refreshing.size;
  }

  private store(key: string, value: V) {
    const now = Date.now();
    this.entries.delete(key);
    // Bounded sweep: the oldest entries sit first; drop the ones past maxStale (at most a few per call).
    let swept = 0;
    for (const [k, e] of this.entries) {
      if (swept++ >= 8 || now - e.at < this.maxStaleMs) break;
      this.entries.delete(k);
      stat(this.name).evictions.expired++;
    }
    while (this.entries.size >= this.max) {
      this.entries.delete(this.entries.keys().next().value!);
      stat(this.name).evictions.capacity++;
    }
    this.entries.set(key, { at: now, value });
  }

  async get(key: string, load: () => Promise<V>): Promise<V> {
    if (DISABLED) return load();
    let e = this.entries.get(key);
    let age = e ? Date.now() - e.at : Infinity;
    if (e && age >= this.maxStaleMs) {
      this.entries.delete(key);
      stat(this.name).evictions.expired++;
      e = undefined;
      age = Infinity;
    }
    if (e && age < this.freshMs) {
      this.entries.delete(key);
      this.entries.set(key, e); // LRU recency; `at` unchanged
      stat(this.name).hits++;
      return e.value;
    }
    const refresh = () => {
      const running = this.refreshing.get(key);
      if (running) return running;
      const p = load()
        .then((v) => (this.store(key, v), v))
        .catch((err) => {
          stat(this.name).refreshFailures++;
          throw err;
        })
        .finally(() => this.refreshing.delete(key));
      this.refreshing.set(key, p);
      return p;
    };
    if (e) {
      this.entries.delete(key);
      this.entries.set(key, e);
      stat(this.name).hits++;
      refresh().catch((err) => console.error(`${this.name} refresh:`, (err as Error).message));
      return e.value;
    }
    stat(this.name).misses++;
    return refresh();
  }
}

const flights = new Map<string, Promise<unknown>>();
/** Identical concurrent calls share one execution and its result (or error). */
export function singleflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = flights.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = fn().finally(() => flights.delete(key));
  flights.set(key, p);
  return p;
}

export const singleflightInflight = () => flights.size;

export function invalidateTables(tables: Iterable<string>) {
  const set = new Set(tables);
  for (const c of registry) if (c.tables.some((t) => set.has(t))) c.clear();
}
export function flushAllCaches() {
  for (const c of registry) c.clear();
}
onCommittedWrite(invalidateTables);

// ---------------------------------------------------------------- cross-process listener

let client: ListenerClient | null = null;
let stopped = false;
let retryMs = 1000;
let retryTimer: NodeJS.Timeout | null = null;

/** Start listening for other processes' writes. While not connected, caches are bypassed (never trusted stale). */
export type ListenerClient = Pick<pg.Client, "on" | "connect" | "query" | "end">;
const defaultClientFactory = (connectionString: string): ListenerClient =>
  new pg.Client({ connectionString, keepAlive: true, keepAliveInitialDelayMillis: 30000 });

/** `makeClient` is injectable so tests can drive the listener without a database. */
export async function startCacheInvalidation(
  connectionString = config.databaseUrl,
  makeClient: (cs: string) => ListenerClient = defaultClientFactory,
): Promise<void> {
  stopped = false;
  listener = "down";
  flushAllCaches();
  const c = makeClient(connectionString);
  const lost = (why: string) => {
    if (client !== c) return;
    client = null;
    listener = "down";
    flushAllCaches();
    if (stopped) return;
    console.error(`cache invalidation listener lost (${why}); caches bypassed until it reconnects`);
    retryTimer = setTimeout(
      () => void startCacheInvalidation(connectionString, makeClient).catch(() => {}),
      retryMs,
    );
    retryMs = Math.min(30_000, retryMs * 2);
  };
  c.on(
    "notification",
    (n) => n.channel === "cache_invalidate" && n.payload && invalidateTables([n.payload]),
  );
  c.on("error", (e) => lost(e.message));
  c.on("end", () => lost("connection ended"));
  client = c;
  try {
    await c.connect();
    await c.query("LISTEN cache_invalidate");
    // Anything cached before this point may have missed notifications.
    flushAllCaches();
    listener = "connected";
    retryMs = 1000;
  } catch (e) {
    lost((e as Error).message);
    c.end().catch(() => {});
  }
}

export async function stopCacheInvalidation() {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const c = client;
  client = null;
  listener = "none";
  await c?.end().catch(() => {});
}

/** Bounded-cardinality snapshot for metrics: one row per cache (fixed names), no keys. */
export function cacheSnapshot() {
  return [...registry, ...swrRegistry].map((c) => ({
    name: c.name,
    kind: c instanceof StaleWhileRevalidate ? "swr" : "aside",
    entries: c.size,
    max: c.max,
    inflight: c.inflightCount,
    ...stat(c.name),
  }));
}

export const cacheListenerState = () => listener;
