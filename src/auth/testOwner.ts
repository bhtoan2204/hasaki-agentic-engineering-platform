import { pool, one } from "../db/pool.ts";
import { hashPassword } from "./password.ts";

let cached: number | null = null;

/**
 * One owner for the existing engine suite. Production never calls this:
 * startRun, imports and workers require a real owner.
 */
export async function ensureTestOwner(): Promise<number> {
  if (process.env.PLATFORM_TEST !== "1")
    throw new Error("test owner is only available under PLATFORM_TEST");
  if (cached) return cached;
  const existing = await one<{ id: number }>(
    pool,
    "SELECT id FROM users WHERE username = 'test-owner'",
  );
  if (existing) return (cached = Number(existing.id));
  const password_hash = await hashPassword("test-owner-password");
  try {
    const row = await one<{ id: number }>(
      pool,
      "INSERT INTO users (username, password_hash, role) VALUES ('test-owner', $1, 'admin') RETURNING id",
      [password_hash],
    );
    return (cached = Number(row!.id));
  } catch (e) {
    if ((e as { code?: string }).code !== "23505") throw e;
    const again = await one<{ id: number }>(
      pool,
      "SELECT id FROM users WHERE username = 'test-owner'",
    );
    if (!again) throw e;
    return (cached = Number(again.id));
  }
}
