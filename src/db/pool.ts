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
pool.on("error", (err) => console.error("postgres idle client error:", err.message));

/** A pool or a client inside a transaction: every repository function accepts either. */
export type Db = pg.Pool | pg.PoolClient;

export async function q<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}

export async function one<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await db.query(sql, params)).rows[0] as T | undefined;
}

/**
 * Run `fn` in a transaction on `db` (the app pool by default).
 * The client is released once, as soon as COMMIT or ROLLBACK finishes, and only then are `afterCommit`
 * callbacks awaited in registration order. They run only after a successful COMMIT. A callback error is logged
 * and does not fail the caller or roll back work that already committed. A failed COMMIT or a throw inside `fn`
 * rolls back (when a transaction is still open) and skips callbacks.
 */
export async function withTx<T>(fn: (c: pg.PoolClient, afterCommit: (cb: () => unknown) => void) => Promise<T>, db: pg.Pool = pool): Promise<T> {
  const c = await db.connect();
  const after: Array<() => unknown> = [];
  let committed = false;
  let out!: T;
  let destroy: Error | undefined;
  try {
    await c.query("BEGIN");
    out = await fn(c, (cb) => after.push(cb));
    await c.query("COMMIT");
    committed = true;
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

export const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
