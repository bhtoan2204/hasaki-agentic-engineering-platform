import { config } from "./config.ts";
import { deleteUserSecret, getUserSecret, putUserSecret } from "./auth/secrets.ts";
import { HttpError } from "./http/error.ts";

/**
 * Hasaki Work login stays in the user's own browser. This shared server does not open a Chromium
 * window or reuse a global profile. Each user pastes their own Bearer token; it is stored encrypted
 * and never used for anyone else.
 */
const tokens = new Map<number, { value: string; exp: number }>();

function jwtExp(t: string) {
  try {
    return Number(JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).exp) || 0;
  } catch {
    return 0;
  }
}

export async function loadToken() {
  /* Tokens stay in user_secrets and are loaded for the user who is calling. Nothing global is warmed. */
}

export async function setToken(raw: string, userId: number) {
  const value = raw.trim().replace(/^Authorization:\s*/i, "").replace(/^Bearer\s+/i, "");
  if (value.split(".").length !== 3) throw new Error("token không đúng dạng JWT (xxx.yyy.zzz)");
  tokens.set(userId, { value, exp: jwtExp(value) });
  await putUserSecret(userId, "hasaki_token", value);
}

export function authStatus(userId?: number) {
  const token = userId ? tokens.get(userId) : undefined;
  const now = Date.now() / 1000;
  const valid = !!token && (token.exp === 0 || token.exp - 30 > now);
  return {
    loggedIn: valid,
    expiresAt: token?.exp ? new Date(token.exp * 1000).toISOString() : null,
    windowOpen: false,
  };
}

export async function getToken(userId: number): Promise<string> {
  let token = tokens.get(userId);
  if (!token) {
    const saved = await getUserSecret(userId, "hasaki_token");
    if (saved) {
      token = { value: saved, exp: jwtExp(saved) };
      tokens.set(userId, token);
    }
  }
  const now = Date.now() / 1000;
  if (!token || (token.exp !== 0 && token.exp - 30 <= now)) {
    throw new Error("Hasaki Work token is missing or expired for this account. Paste a token; it is not shared with other users.");
  }
  return token.value;
}

/** Disabled: a host browser profile cannot be isolated per user on the shared server. */
export async function openLoginWindow(): Promise<void> {
  throw new HttpError(403, "The shared server does not open a Hasaki Work login window. Paste your own token.");
}

export async function closeLoginWindow() {
  return;
}

/** Call the wshr API the way the web app does. */
export async function workApi(userId: number, method: string, path: string, params?: Record<string, string | number>, body?: unknown) {
  const url = new URL(config.hasakiWork.apiUrl + "/" + path.replace(/^\//, ""));
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await getToken(userId)}`,
      Accept: "application/json",
      "X-Locale": "vi",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    tokens.delete(userId);
    await deleteUserSecret(userId, "hasaki_token");
    throw new Error("Hasaki Work token expired for this account. Paste a new one.");
  }
  const json: any = await res.json().catch(() => null);
  if (res.status === 404)
    throw new Error(
      `Hasaki Work ${method} ${url.pathname}: HTTP 404 — endpoint không tồn tại. Mở work.hasaki.vn/tasks, DevTools > Network, ` +
        `tìm request lấy danh sách task tới ${config.hasakiWork.apiUrl} rồi sửa hasakiWork.listPath / detailPath / listQuery trong config.json.`,
    );
  if (!res.ok || !json) throw new Error(`Hasaki Work ${method} ${path}: HTTP ${res.status}`);
  return json;
}
