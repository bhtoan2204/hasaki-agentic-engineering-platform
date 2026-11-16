import type { IncomingMessage, ServerResponse } from "node:http";
import { randomToken, safeEqual, sessionHash } from "./crypto.ts";
import { verifyPassword } from "./password.ts";
import { publicUser, userByUsername, type PublicUser } from "./users.ts";
import {
  cachedSession,
  forgetSession,
  forgetUserSessions,
  rememberSession,
} from "./sessionCache.ts";
import { authRepository } from "./repository.ts";

const COOKIE = "sid";
/** Login session lifetime (cookie Max-Age and the stored expiry). Default 3 days; SESSION_MAX_AGE_HOURS overrides. */
const hours = Number(process.env.SESSION_MAX_AGE_HOURS ?? 72);
export const MAX_AGE_S = Math.round((Number.isFinite(hours) && hours > 0 ? hours : 72) * 60 * 60);
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;

export type SessionUser = PublicUser & { csrf: string };

function clientIp(req: IncomingMessage) {
  const fwd = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")[0]
    ?.trim();
  return (fwd || req.socket.remoteAddress || "").slice(0, 80);
}

export function cookieSecure(req: IncomingMessage) {
  if (process.env.COOKIE_SECURE === "1") return true;
  if (process.env.COOKIE_SECURE === "0" && process.env.NODE_ENV !== "production") return false;
  if (process.env.NODE_ENV === "production" || (req.socket as { encrypted?: boolean }).encrypted)
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

async function tooMany(username: string, ip: string, repo = authRepository) {
  const since = new Date(Date.now() - WINDOW_MS);
  const { byName, byIp } = await repo.countFailedAttempts(username, ip, since);
  return byName >= MAX_FAILS || byIp >= MAX_FAILS * 3;
}

async function record(username: string, ip: string, success: boolean, repo = authRepository) {
  await repo.recordLoginAttempt(username, ip, success);
}

const INVALID = "Invalid username or password";

export async function login(
  username: string,
  password: string,
  req: IncomingMessage,
  repo = authRepository,
): Promise<{ token: string; user: SessionUser }> {
  const ip = clientIp(req);
  const name = String(username ?? "")
    .trim()
    .toLowerCase();
  if (await tooMany(name || "-", ip, repo)) {
    await record(name || "-", ip, false, repo);
    const err = new Error(INVALID) as Error & { status: number };
    err.status = 429;
    throw err;
  }
  const row = name ? await userByUsername(name).catch(() => undefined) : undefined;
  const ok =
    !!row && row.active && (await verifyPassword(row.password_hash, String(password ?? "")));
  if (!row || !ok) {
    if (row && !row.active)
      await verifyPassword(row.password_hash, String(password ?? "")).catch(() => false);
    await record(name || "-", ip, false, repo);
    const err = new Error(INVALID) as Error & { status: number };
    err.status = 401;
    throw err;
  }
  await record(row.username, ip, true, repo);
  const token = randomToken();
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + MAX_AGE_S * 1000);
  await repo.revokeSessionsByUserId(row.id);
  forgetUserSessions(Number(row.id));
  await repo.insertSession(row.id, sessionHash(token), csrf, expires);
  return { token, user: { ...publicUser(row), csrf } };
}

export async function sessionFromRequest(
  req: IncomingMessage,
  repo = authRepository,
): Promise<SessionUser | null> {
  const token = readCookie(req);
  if (!token) return null;
  let hash: string;
  try {
    hash = sessionHash(token);
  } catch {
    return null;
  }
  const hit = cachedSession<SessionUser>(hash);
  if (hit) return hit;
  const row = await repo.findActiveSessionByHash(hash);
  if (!row || row.revoked_at || !row.active) return null;
  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt <= Date.now()) return null;
  const user = { ...publicUser(row), csrf: row.csrf_token };
  rememberSession(hash, Number(row.id), expiresAt, user);
  return user;
}

export async function logout(req: IncomingMessage, repo = authRepository) {
  const token = readCookie(req);
  if (!token) return;
  try {
    const hash = sessionHash(token);
    forgetSession(hash);
    await repo.revokeSessionByHash(hash);
  } catch {
    /* missing AUTH_SECRET: nothing to revoke */
  }
}

export function csrfOk(req: IncomingMessage, csrf: string) {
  const sent = String(req.headers["x-csrf-token"] ?? "");
  return !!sent && safeEqual(sent, csrf);
}
