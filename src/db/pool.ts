import pg from "pg";
import { config } from "../config.ts";

// BIGINT ids/counters fit in a JS number for this platform; returning numbers keeps API payloads simple.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

/** A pool or a client inside a transaction: every repository function accepts either. */
export type Db = pg.Pool | pg.PoolClient;

export async function q<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}

export async function one<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await db.query(sql, params)).rows[0] as T | undefined;
}

/**
 * Run `fn` in a transaction. Callbacks registered with `afterCommit` run only once COMMIT succeeded
 * (notifications, local abort signals): side effects never leak from a rolled-back transaction.
 */
export async function withTx<T>(fn: (c: pg.PoolClient, afterCommit: (cb: () => unknown) => void) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  const after: Array<() => unknown> = [];
  try {
    await c.query("BEGIN");
    const out = await fn(c, (cb) => after.push(cb));
    await c.query("COMMIT");
    for (const cb of after) {
      try {
        await cb();
      } catch (e) {
        console.error("afterCommit hook failed:", (e as Error).message);
      }
    }
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
