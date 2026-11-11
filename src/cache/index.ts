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

export const cacheStats: Record<string, { hits: number; misses: number; invalidations: number }> =
  {};
const stat = (name: string) => (cacheStats[name] ??= { hits: 0, misses: 0, invalidations: 0 });

const registry = new Set<CacheAside<any>>();

export class CacheAside<V> {
  private entries = new Map<string, { at: number; value: V }>();
  private inflight = new Map<string, { gen: number; p: Promise<V> }>();
  private gen = 0;
  readonly name: string;
  readonly tables: string[];
  readonly ttlMs: number;
  readonly max: number;
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
      stat(this.name).hits++;
      return structuredClone(e.value);
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
        if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key, { at: Date.now(), value: v });
      }
      return structuredClone(v);
    } finally {
      if (this.inflight.get(key)?.p === p) this.inflight.delete(key);
    }
  }

  clear() {
    this.gen++;
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
  constructor(name: string, freshMs: number, maxStaleMs: number) {
    this.name = name;
    this.freshMs = freshMs;
    this.maxStaleMs = maxStaleMs;
  }

  async get(key: string, load: () => Promise<V>): Promise<V> {
    if (DISABLED) return load();
    const e = this.entries.get(key);
    const age = e ? Date.now() - e.at : Infinity;
    if (e && age < this.freshMs) {
      stat(this.name).hits++;
      return e.value;
    }
    const refresh = () => {
      const running = this.refreshing.get(key);
      if (running) return running;
      const p = load()
        .then((v) => (this.entries.set(key, { at: Date.now(), value: v }), v))
        .finally(() => this.refreshing.delete(key));
      this.refreshing.set(key, p);
      return p;
    };
    if (e && age < this.maxStaleMs) {
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

export function invalidateTables(tables: Iterable<string>) {
  const set = new Set(tables);
  for (const c of registry) if (c.tables.some((t) => set.has(t))) c.clear();
}
export function flushAllCaches() {
  for (const c of registry) c.clear();
}
onCommittedWrite(invalidateTables);

// ---------------------------------------------------------------- cross-process listener

let client: pg.Client | null = null;
let stopped = false;
let retryMs = 1000;

/** Start listening for other processes' writes. While not connected, caches are bypassed (never trusted stale). */
export async function startCacheInvalidation(connectionString = config.databaseUrl): Promise<void> {
  stopped = false;
  listener = "down";
  flushAllCaches();
  const c = new pg.Client({
    connectionString,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30000,
  });
  const lost = (why: string) => {
    if (client !== c) return;
    client = null;
    listener = "down";
    flushAllCaches();
    if (stopped) return;
    console.error(`cache invalidation listener lost (${why}); caches bypassed until it reconnects`);
    setTimeout(() => void startCacheInvalidation(connectionString).catch(() => {}), retryMs);
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
  const c = client;
  client = null;
  listener = "none";
  await c?.end().catch(() => {});
}

export const cacheListenerState = () => listener;
