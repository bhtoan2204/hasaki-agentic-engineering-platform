import { pool, q, one, withTx, type Db } from "../db/pool.ts";
import { hashPassword } from "./password.ts";
import { forgetUserSessions } from "./sessionCache.ts";

export type Role = "admin" | "member";
export type PublicUser = { id: number; username: string; role: Role; active: boolean };

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function assertUsername(username: string) {
  const name = username.trim().toLowerCase();
  if (!USERNAME.test(name)) throw new Error("username must be 3–32 characters: a-z, 0-9, . _ -");
  return name;
}

export function publicUser(row: {
  id: number;
  username: string;
  role: string;
  active: boolean;
}): PublicUser {
  return {
    id: Number(row.id),
    username: row.username,
    role: row.role === "admin" ? "admin" : "member",
    active: !!row.active,
  };
}

export async function createUser(
  input: { username: string; password: string; role: Role },
  db: Db = pool,
) {
  const username = assertUsername(input.username);
  if (input.role !== "admin" && input.role !== "member")
    throw new Error("role must be admin or member");
  const password_hash = await hashPassword(input.password);
  const row = await one(
    db,
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, active`,
    [username, password_hash, input.role],
  );
  return publicUser(row!);
}

export async function listUsers() {
  const rows = await q<{ id: number; username: string; role: string; active: boolean }>(
    pool,
    "SELECT id, username, role, active FROM users ORDER BY username",
  );
  return rows.map(publicUser);
}

export async function setPassword(userId: number, password: string) {
  const password_hash = await hashPassword(password);
  await withTx(async (c) => {
    const row = await one(
      c,
      "UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1 RETURNING id",
      [userId, password_hash],
    );
    if (!row) throw new Error("user not found");
    await q(c, "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [
      userId,
    ]);
  });
  forgetUserSessions(userId);
}

export async function setActive(userId: number, active: boolean) {
  await withTx(async (c) => {
    const row = await one(
      c,
      "UPDATE users SET active = $2, updated_at = now() WHERE id = $1 RETURNING id",
      [userId, active],
    );
    if (!row) throw new Error("user not found");
    if (!active)
      await q(
        c,
        "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        [userId],
      );
  });
  forgetUserSessions(userId);
}

export async function userByUsername(username: string) {
  return one<{
    id: number;
    username: string;
    role: string;
    active: boolean;
    password_hash: string;
  }>(pool, "SELECT id, username, role, active, password_hash FROM users WHERE username = $1", [
    assertUsername(username),
  ]);
}
