/**
 * Short-lived, in-process cache of session lookups. Every authenticated request starts with a session lookup; with a
 * remote database that is a full network round trip before any work. Entries live at most SESSION_CACHE_MS (default
 * 10 s) and never beyond the session's own expiry.
 *
 * Revocation: this process drops entries at once on login (other sessions of the user are revoked), logout, password
 * change and deactivation. Another instance sharing the database may keep honouring a revoked session for up to
 * SESSION_CACHE_MS. Set SESSION_CACHE_MS=0 to disable the cache.
 */
export const SESSION_CACHE_MS = Math.max(0, Number(process.env.SESSION_CACHE_MS ?? 10_000) || 0);
const MAX_ENTRIES = 5000;

interface Entry<U> {
  at: number;
  expiresAt: number;
  userId: number;
  user: U;
}
const cache = new Map<string, Entry<unknown>>();

export function cachedSession<U>(hash: string, now = Date.now()): U | undefined {
  if (!SESSION_CACHE_MS) return undefined;
  const e = cache.get(hash);
  if (!e) return undefined;
  if (now - e.at > SESSION_CACHE_MS || e.expiresAt <= now) {
    cache.delete(hash);
    return undefined;
  }
  return e.user as U;
}

export function rememberSession<U>(hash: string, userId: number, expiresAt: number, user: U, now = Date.now()) {
  if (!SESSION_CACHE_MS) return;
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(hash, { at: now, expiresAt, userId, user });
}

/** Drop one session (logout) or every cached session of a user (login elsewhere, password change, deactivation). */
export function forgetSession(hash: string) {
  cache.delete(hash);
}
export function forgetUserSessions(userId: number) {
  for (const [k, e] of cache) if (e.userId === userId) cache.delete(k);
}
