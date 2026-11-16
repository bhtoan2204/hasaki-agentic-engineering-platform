import { pool, withTx, type Db } from "../db/pool.ts";
import { hashPassword } from "./password.ts";
import { forgetUserSessions } from "./sessionCache.ts";
import { authRepository } from "./repository.ts";

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
  repo = authRepository,
) {
  const username = assertUsername(input.username);
  if (input.role !== "admin" && input.role !== "member")
    throw new Error("role must be admin or member");
  const password_hash = await hashPassword(input.password);
  const row = await repo.insertUser(username, password_hash, input.role, db);
  return publicUser(row);
}

export async function listUsers(db: Db = pool, repo = authRepository) {
  const rows = await repo.listAllUsers(db);
  return rows.map(publicUser);
}

export async function setPassword(userId: number, password: string, repo = authRepository) {
  const password_hash = await hashPassword(password);
  await withTx(async (c) => {
    const row = await repo.updateUserPassword(userId, password_hash, c);
    if (!row) throw new Error("user not found");
    await repo.revokeSessionsByUserId(userId, c);
  });
  forgetUserSessions(userId);
}

export async function setActive(userId: number, active: boolean, repo = authRepository) {
  await withTx(async (c) => {
    const row = await repo.updateUserActive(userId, active, c);
    if (!row) throw new Error("user not found");
    if (!active) await repo.revokeSessionsByUserId(userId, c);
  });
  forgetUserSessions(userId);
}

export async function userByUsername(username: string, db: Db = pool, repo = authRepository) {
  return repo.findUserByUsername(assertUsername(username), db);
}

export async function userById(userId: number, db: Db = pool, repo = authRepository) {
  return repo.findUserById(userId, db);
}
