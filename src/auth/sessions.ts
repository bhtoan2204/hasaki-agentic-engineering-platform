import type { IncomingMessage, ServerResponse } from "node:http";
import { pool, q, one } from "../db/pool.ts";
import { randomToken, safeEqual, sessionHash } from "./crypto.ts";
import { verifyPassword } from "./password.ts";
import { publicUser, userByUsername, type PublicUser } from "./users.ts";

const COOKIE = "sid";
const MAX_AGE_S = 8 * 60 * 60;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;

export type SessionUser = PublicUser & { csrf: string };

function clientIp(req: IncomingMessage) {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  return (fwd || req.socket.remoteAddress || "").slice(0, 80);
}

export function cookieSecure(req: IncomingMessage) {
  if (process.env.COOKIE_SECURE === "1") return true;
  if (process.env.COOKIE_SECURE === "0" && process.env.NODE_ENV !== "production") return false;
  if (process.env.NODE_ENV === "production" || (req.socket as { encrypted?: boolean }).encrypted) return true;
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
  return host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]";
}

export function readCookie(req: IncomingMessage, name = COOKIE): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) {
      try { return decodeURIComponent(rest.join("=")); } catch { return null; }
    }
  }
  return null;
}

export function setSessionCookie(res: ServerResponse, req: IncomingMessage, token: string) {
  const flags = [`${COOKIE}=${encodeURIComponent(token)}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${MAX_AGE_S}`];
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

async function record(username: string, ip: string, success: boolean) {
  await q(pool, "INSERT INTO login_attempts (username, ip, success) VALUES ($1, $2, $3)", [username, ip, success]);
}

const INVALID = "Invalid username or password";

export async function login(username: string, password: string, req: IncomingMessage): Promise<{ token: string; user: SessionUser }> {
  const ip = clientIp(req);
  const name = String(username ?? "").trim().toLowerCase();
  if (await tooMany(name || "-", ip)) {
    await record(name || "-", ip, false);
    const err = new Error(INVALID) as Error & { status: number };
    err.status = 429;
    throw err;
  }
  const row = name ? await userByUsername(name).catch(() => undefined) : undefined;
  const ok = !!row && row.active && (await verifyPassword(row.password_hash, String(password ?? "")));
  if (!row || !ok) {
    if (row && !row.active) await verifyPassword(row.password_hash, String(password ?? "")).catch(() => false);
    await record(name || "-", ip, false);
    const err = new Error(INVALID) as Error & { status: number };
    err.status = 401;
    throw err;
  }
  await record(row.username, ip, true);
  const token = randomToken();
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + MAX_AGE_S * 1000);
  await q(pool, "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [row.id]);
  await q(pool, "INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at) VALUES ($1, $2, $3, $4)", [
    row.id,
    sessionHash(token),
    csrf,
    expires,
  ]);
  return { token, user: { ...publicUser(row), csrf } };
}

export async function sessionFromRequest(req: IncomingMessage): Promise<SessionUser | null> {
  const token = readCookie(req);
  if (!token) return null;
  let hash: string;
  try {
    hash = sessionHash(token);
  } catch {
    return null;
  }
  const row = await one<{ id: number; username: string; role: string; active: boolean; csrf_token: string; expires_at: string; revoked_at: string | null }>(
    pool,
    `SELECT u.id, u.username, u.role, u.active, s.csrf_token, s.expires_at, s.revoked_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [hash],
  );
  if (!row || row.revoked_at || !row.active) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return { ...publicUser(row), csrf: row.csrf_token };
}

export async function logout(req: IncomingMessage) {
  const token = readCookie(req);
  if (!token) return;
  try {
    await q(pool, "UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [sessionHash(token)]);
  } catch {
    /* missing AUTH_SECRET: nothing to revoke */
  }
}

export function csrfOk(req: IncomingMessage, csrf: string) {
  const sent = String(req.headers["x-csrf-token"] ?? "");
  return !!sent && safeEqual(sent, csrf);
}
