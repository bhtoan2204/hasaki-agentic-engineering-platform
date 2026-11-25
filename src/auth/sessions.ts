import type { IncomingMessage, ServerResponse } from "node:http";
import { pool, q, one } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import { clientIp } from "../http/clientIp.ts";
import { randomToken, safeEqual, sessionHash, sessionHashes } from "./crypto.ts";
import { verifyPassword } from "./password.ts";
import { assertUsername, publicUser, userByUsername, type PublicUser } from "./users.ts";
import {
  cachedSession,
  forgetSession,
  forgetUserSessions,
  rememberSession,
} from "./sessionCache.ts";
import { config } from "../config.ts";

const COOKIE = "sid";
/** Login session lifetime (cookie Max-Age and the stored expiry). Default 3 days; SESSION_MAX_AGE_HOURS overrides. */
const hours = Number(config.server.sessionMaxAgeHours ?? 72);
export const MAX_AGE_S = Math.round((Number.isFinite(hours) && hours > 0 ? hours : 72) * 60 * 60);
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;

export type SessionUser = PublicUser & { csrf: string };

export function cookieSecure(req: IncomingMessage) {
  if (config.server.cookieSecure === "1") return true;
  if (config.server.cookieSecure === "0" && config.system.nodeEnv !== "production") return false;
  if (config.system.nodeEnv === "production" || (req.socket as { encrypted?: boolean }).encrypted)
    return true;
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
  return host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]";
}

export function readCookie(req: IncomingMessage, name = COOKIE): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function setSessionCookie(res: ServerResponse, req: IncomingMessage, token: string) {
  const flags = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${MAX_AGE_S}`,
  ];
  if (cookieSecure(req)) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
}

export function clearSessionCookie(res: ServerResponse, req: IncomingMessage) {
  const flags = [`${COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (cookieSecure(req)) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
}

async function tooMany(username: string, ip: string) {
  const since = new Date(Date.now() - WINDOW_MS);
  const byName = await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM login_attempts WHERE username = $1 AND NOT success AND created_at > $2",
    [username, since],
  );
  const byIp = await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM login_attempts WHERE ip = $1 AND NOT success AND created_at > $2",
    [ip, since],
  );
  return (byName?.n ?? 0) >= MAX_FAILS || (byIp?.n ?? 0) >= MAX_FAILS * 3;
}

const LOGIN_ATTEMPT_RETENTION_DAYS = 30;
const PRUNE_BATCH = 5000;

/**
 * Deletes login attempts past retention, one bounded batch per call (the throttle only reads the last 15 minutes;
 * the (username, created_at) and (ip, created_at) indexes from 016_auth.sql serve both throttle lookups).
 */
export async function pruneLoginAttempts(limit = PRUNE_BATCH, now = Date.now()) {
  const cutoff = new Date(now - LOGIN_ATTEMPT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rows = await q(
    pool,
    "DELETE FROM login_attempts WHERE id IN (SELECT id FROM login_attempts WHERE created_at < $1 ORDER BY created_at LIMIT $2) RETURNING id",
    [cutoff, limit],
  );
  return rows.length;
}

async function record(username: string, ip: string, success: boolean) {
  await q(pool, "INSERT INTO login_attempts (username, ip, success) VALUES ($1, $2, $3)", [
    username,
    ip,
    success,
  ]);
}

const INVALID = "Invalid username or password";

export async function login(
  username: string,
  password: string,
  req: IncomingMessage,
): Promise<{ token: string; user: SessionUser }> {
  const ip = clientIp(req);
  const name = String(username ?? "")
    .trim()
    .toLowerCase();
  if (await tooMany(name || "-", ip)) {
    await record(name || "-", ip, false);
    throw new HttpError(429, INVALID);
  }
  let validName: string | undefined;
  try {
    validName = assertUsername(name);
  } catch {
    // Invalid usernames follow the same response and failure accounting as unknown users.
  }
  const row = validName ? await userByUsername(validName) : undefined;
  const ok =
    !!row && row.active && (await verifyPassword(row.password_hash, String(password ?? "")));
  if (!row || !ok) {
    if (row && !row.active)
      await verifyPassword(row.password_hash, String(password ?? "")).catch(() => false);
    await record(name || "-", ip, false);
    throw new HttpError(401, INVALID);
  }
  await record(row.username, ip, true);
  const token = randomToken();
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + MAX_AGE_S * 1000);
  await q(
    pool,
    "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    [row.id],
  );
  forgetUserSessions(Number(row.id));
  await q(
    pool,
    "INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at) VALUES ($1, $2, $3, $4)",
    [row.id, sessionHash(token), csrf, expires],
  );
  return { token, user: { ...publicUser(row), csrf } };
}

export async function sessionFromRequest(req: IncomingMessage): Promise<SessionUser | null> {
  const token = readCookie(req);
  if (!token) return null;
  let hashes: string[];
  try {
    // One hash per configured key: a session created before a key rotation still authenticates (key-rotation.md).
    hashes = sessionHashes(token);
  } catch {
    return null;
  }
  for (const candidate of hashes) {
    const hit = cachedSession<SessionUser>(candidate);
    if (hit) return hit;
  }
  const row = await one<{
    token_hash: string;
    id: number;
    username: string;
    role: string;
    active: boolean;
    csrf_token: string;
    expires_at: string;
    revoked_at: string | null;
  }>(
    pool,
    `SELECT s.token_hash, u.id, u.username, u.role, u.active, s.csrf_token, s.expires_at, s.revoked_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ANY($1)`,
    [hashes],
  );
  if (!row || row.revoked_at || !row.active) return null;
  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt <= Date.now()) return null;
  const user = { ...publicUser(row), csrf: row.csrf_token };
  rememberSession(row.token_hash, Number(row.id), expiresAt, user);
  return user;
}

export async function logout(req: IncomingMessage) {
  const token = readCookie(req);
  if (!token) return;
  try {
    const hashes = sessionHashes(token);
    for (const hash of hashes) forgetSession(hash);
    await q(
      pool,
      "UPDATE sessions SET revoked_at = now() WHERE token_hash = ANY($1) AND revoked_at IS NULL",
      [hashes],
    );
  } catch {
    /* missing AUTH_SECRET: nothing to revoke */
  }
}

export function csrfOk(req: IncomingMessage, csrf: string) {
  const sent = String(req.headers["x-csrf-token"] ?? "");
  return !!sent && safeEqual(sent, csrf);
}
