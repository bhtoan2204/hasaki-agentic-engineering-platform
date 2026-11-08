import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { pool } from "./pool.ts";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");
const LOCK_ID = 727_001; // pg_advisory_lock key: only one process migrates at a time

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), "utf8");
      return {
        version: Number(f.slice(0, 3)),
        name: f.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

/**
 * Apply pending migrations in order, each in its own transaction. Refuses to start if an applied
 * migration file was edited afterwards (checksum mismatch): schema history must be append-only.
 */
export async function migrate(
  db: pg.Pool = pool,
  migrations = loadMigrations(),
) {
  const c = await db.connect();
  try {
    await c.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const applied = new Map(
      (
        await c.query("SELECT version, checksum FROM schema_migrations")
      ).rows.map((r) => [r.version as number, r.checksum as string]),
    );
    const done: string[] = [];
    for (const m of migrations) {
      const sum = applied.get(m.version);
      if (sum) {
        if (sum !== m.checksum)
          throw new Error(
            `migration ${m.name} was modified after being applied (checksum mismatch)`,
          );
        continue;
      }
      await c.query("BEGIN");
      try {
        await c.query(m.sql);
        await c.query(
          "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [m.version, m.name, m.checksum],
        );
        await c.query("COMMIT");
        done.push(m.name);
      } catch (e) {
        await c.query("ROLLBACK");
        throw new Error(`migration ${m.name} failed: ${(e as Error).message}`);
      }
    }
    return done;
  } finally {
    await c.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    c.release();
  }
}
