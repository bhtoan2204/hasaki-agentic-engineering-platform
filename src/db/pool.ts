import pg from "pg";
import { config } from "../config.ts";

// BIGINT ids/counters fit in a JS number for this platform; returning numbers keeps API payloads simple.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.database.poolMax,
  min: config.database.poolMin,
  connectionTimeoutMillis: config.database.connectionTimeoutMillis,
  idleTimeoutMillis: config.database.idleTimeoutMillis,
  // TCP keepalive so a VPN/NAT hop does not silently drop a long-idle client (the next query would then hang).
  keepAlive: true,
  keepAliveInitialDelayMillis: 30000,
});
// Idle clients can error after a restart or network blip. Log the message only — never the connection string.
pool.on("error", (err) =>
  console.error("postgres idle client error:", err.message),
);

/** A pool or a client inside a transaction: every repository function accepts either. */
export type Db = pg.Pool | pg.PoolClient;

/**
 * Connection-level failures (not SQL errors): the network dropped the socket — e.g. Wi-Fi re-keying or the VPN
 * (Cloudflare WARP) rebuilding its tunnel resets every open connection to the remote database at once.
 */
export function isTransientDbError(e: unknown) {
  const err = e as { code?: string; message?: string } | undefined;
  if (!err) return false;
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EPIPE",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "EAI_AGAIN",
      "57P01",
      "57P02",
      "57P03",
      "08000",
      "08003",
      "08006",
    ].includes(err.code ?? "")
  )
    return true;
  return /Connection terminated|connection timeout|timeout exceeded when trying to connect|Client has encountered a connection error|socket hang up/i.test(
    err.message ?? "",
  );
}

/**
 * Run `fn` again (with a short backoff) when it failed on a dropped connection; the pool hands out a fresh one.
 * Only for operations that are safe to repeat: inserts of log rows, idempotent updates, or transactions that
 * re-check their own state first (finishAttempt / releaseAttempt return early when already applied).
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  label: string,
  delaysMs = [500, 1500, 4000, 8000],
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransientDbError(e) || i >= delaysMs.length) throw e;
      console.warn(
        `${label}: database connection dropped (${(e as Error).message}); retrying in ${delaysMs[i]}ms`,
      );
      await new Promise((r) => setTimeout(r, delaysMs[i]));
    }
  }
}

// ---------------------------------------------------------------- committed-write notifications (cache invalidation)

/**
 * In-process caches (src/cache) must drop entries as soon as THIS process commits a write to their tables (read your
 * own writes; other processes are covered by the database triggers of migration 024). Every write to those tables goes
 * through q()/one(), which spot `INSERT INTO | UPDATE | DELETE FROM <table>`: inside withTx the tables are reported
 * after COMMIT (a rollback reports nothing), outside a transaction right after the statement.
 */
const WRITE_RE =
  /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/i;
const writeListeners: Array<(tables: Set<string>) => void> = [];
const txWrites = new WeakMap<object, Set<string>>();
export function onCommittedWrite(fn: (tables: Set<string>) => void) {
  writeListeners.push(fn);
}
function emitWrites(tables: Set<string>) {
  if (!tables.size) return;
  for (const fn of writeListeners) {
    try {
      fn(tables);
    } catch (e) {
      console.error("write listener failed:", (e as Error).message);
    }
  }
}
/** Did this transaction (still open) write `table`? Caches bypass themselves then: the tx must see its own writes. */
export const txWrote = (db: Db, table: string) =>
  txWrites.get(db)?.has(table) ?? false;
export const inTx = (db: Db) => txWrites.has(db);

async function run(db: Db, sql: string, params: unknown[]) {
  const m = WRITE_RE.exec(sql);
  const r = await db.query(sql, params);
  if (m) {
    const t = m[1].toLowerCase();
    const set = txWrites.get(db);
    if (set) set.add(t);
    else emitWrites(new Set([t]));
  }
  return r;
}

export async function q<T = any>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await run(db, sql, params)).rows as T[];
}

export async function one<T = any>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await run(db, sql, params)).rows[0] as T | undefined;
}

/**
 * Rows a transaction writes but never reads back (event log lines) are buffered on its client and written with ONE
 * multi-row INSERT just before COMMIT: with a remote database every statement is a network round trip, and a single
 * state transition writes several events. Same transaction, same order, same triggers (FOR EACH ROW still fires per
 * row); outside withTx the insert happens immediately.
 */
const buffered = new WeakMap<
  object,
  Map<string, { table: string; columns: string[]; rows: unknown[][] }>
>();

export async function insertDeferred(
  db: Db,
  table: string,
  columns: string[],
  values: unknown[],
) {
  const buf = buffered.get(db);
  if (!buf) {
    await db.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      values,
    );
    return;
  }
  const k = `${table}(${columns.join(",")})`;
  (buf.get(k) ?? buf.set(k, { table, columns, rows: [] }).get(k)!).rows.push(
    values,
  );
}

async function flushDeferred(c: pg.PoolClient) {
  const buf = buffered.get(c);
  if (!buf) return;
  for (const { table, columns, rows } of buf.values()) {
    // Chunks keep the statement under PostgreSQL's 65535 bind-parameter limit.
    const per = Math.max(1, Math.floor(60000 / columns.length));
    for (let i = 0; i < rows.length; i += per) {
      const chunk = rows.slice(i, i + per);
      const params: unknown[] = [];
      const tuples = chunk.map(
        (r) =>
          `(${r.map((v) => (params.push(v), `$${params.length}`)).join(", ")})`,
      );
      await c.query(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`,
        params,
      );
    }
  }
  buf.clear();
}

/**
 * Run `fn` in a transaction on `db` (the app pool by default).
 * The client is released once, as soon as COMMIT or ROLLBACK finishes, and only then are `afterCommit`
 * callbacks awaited in registration order. They run only after a successful COMMIT. A callback error is logged
 * and does not fail the caller or roll back work that already committed. A failed COMMIT or a throw inside `fn`
 * rolls back (when a transaction is still open) and skips callbacks.
 */
export async function withTx<T>(
  fn: (
    c: pg.PoolClient,
    afterCommit: (cb: () => unknown) => void,
  ) => Promise<T>,
  db: pg.Pool = pool,
): Promise<T> {
  const c = await db.connect();
  const after: Array<() => unknown> = [];
  let committed = false;
  let out!: T;
  let destroy: Error | undefined;
  try {
    await c.query("BEGIN");
    buffered.set(c, new Map());
    txWrites.set(c, new Set());
    out = await fn(c, (cb) => after.push(cb));
    await flushDeferred(c);
    await c.query("COMMIT");
    committed = true;
    emitWrites(txWrites.get(c) ?? new Set());
  } catch (e) {
    if (!committed) {
      try {
        await c.query("ROLLBACK");
      } catch (rollbackErr) {
        // The client is unusable (COMMIT failed and ROLLBACK failed too). Drop it instead of returning it to the pool.
        destroy = rollbackErr as Error;
      }
    }
    throw e;
  } finally {
    buffered.delete(c);
    txWrites.delete(c);
    c.release(destroy);
  }
  for (const cb of after) {
    try {
      await cb();
    } catch (e) {
      console.error("afterCommit hook failed:", (e as Error).message);
    }
  }
  return out;
}

export const json = (v: unknown) =>
  v === undefined ? null : JSON.stringify(v);
