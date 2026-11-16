import { config } from "./config.ts";
import { deleteUserSecret, getUserSecret, putUserSecret } from "./auth/secrets.ts";
import { existingChromeOwner } from "./existingWorkChrome.ts";
import { HttpError } from "./http/error.ts";
import { cancelChrome, connectionStatus, localChromeEnabled, openChrome } from "./workChrome.ts";

/** Personal tokens are verified before encryption; Chrome sessions are isolated per actor. */
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

export async function setToken(raw: string, userId: number, valid = () => true) {
  const value = raw
    .trim()
    .replace(/^Authorization:\s*/i, "")
    .replace(/^Bearer\s+/i, "");
  if (jwtExp(value) && jwtExp(value) <= Date.now() / 1000 + 30)
    throw new Error("chrome_verification");
  if (value.split(".").length !== 3) throw new Error("token không đúng dạng JWT (xxx.yyy.zzz)");
  const url = new URL(
    config.hasakiWork.apiUrl + "/" + config.hasakiWork.listPath.replace(/^\//, ""),
  );
  for (const [k, v] of Object.entries(config.hasakiWork.listQuery))
    url.searchParams.set(k, String(v));
  url.searchParams.set("to_date", new Date().toISOString().slice(0, 10));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${value}`, Accept: "application/json", "X-Locale": "vi" },
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("json"))
    throw new Error("chrome_verification");
  const body = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    body.success === false ||
    body.error ||
    (typeof body.code === "number" && body.code >= 400)
  )
    throw new Error("chrome_verification");
  if (!valid()) return;
  await putUserSecret(userId, "hasaki_token", value);
  tokens.set(userId, { value, exp: jwtExp(value) });
}

export async function authStatus(userId: number) {
  await getToken(userId).catch(() => {});
  const token = userId ? tokens.get(userId) : undefined;
  const now = Date.now() / 1000;
  const valid = !!token && (token.exp === 0 || token.exp - 30 > now);
  return {
    loggedIn: valid,
    expiresAt: token?.exp ? new Date(token.exp * 1000).toISOString() : null,
    ...connectionStatus(userId),
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
    throw new Error(
      "Hasaki Work token is missing or expired for this account. Paste a token; it is not shared with other users.",
    );
  }
  return token.value;
}

export async function openLoginWindow(userId: number, username?: string) {
  if (!localChromeEnabled()) throw new HttpError(403, "chrome_hosted");
  if (process.env.HASAKI_WORK_CHROME_PROFILE === "existing" && !existingChromeOwner(username))
    throw new HttpError(403, "chrome_existing_owner");
  await openChrome(userId, (raw, valid) => setToken(raw, userId, valid), 300000, username);
  return authStatus(userId);
}
export async function closeLoginWindow(userId: number) {
  await cancelChrome(userId);
}

/** Call the wshr API the way the web app does. */
export async function workApi(
  userId: number,
  method: string,
  path: string,
  params?: Record<string, string | number>,
  body?: unknown,
) {
  const url = new URL(config.hasakiWork.apiUrl + "/" + path.replace(/^\//, ""));
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  // FormData is sent as multipart/form-data (fetch sets the boundary header itself); anything else as JSON.
  const form = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await getToken(userId)}`,
      Accept: "application/json",
      "X-Locale": "vi",
      ...(body && !form ? { "Content-Type": "application/json" } : {}),
    },
    body: form ? (body as FormData) : body ? JSON.stringify(body) : undefined,
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
