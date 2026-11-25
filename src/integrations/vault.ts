import { currentUserId } from "../auth/execution.ts";
import { config } from "../config.ts";
import { personalSettings as settings, PersonalSession } from "./personal.ts";
import { parseCurl } from "./curl.ts";

/**
 * HashiCorp Vault (QC) — lets an agent check which secrets/keys a service has, never their values.
 *
 * The developer logs in to the Vault UI (OIDC/Keycloak) and pastes the token from the user menu ("Copy token"). The
 * platform reads (GET, `?list=true` for listings); its writes are renewing that same token (`renew-self`) so it lives
 * as long as Vault allows, and `vault.set_key` (QC only, allowlisted, user-confirmed, one key at a time). Secret values are read server-side and reduced to presence/length before anything
 * is returned; only short numbers/booleans under non-sensitive key names are shown as-is (e.g. a timeout of 15).
 */

const SETTING = "vault_token";
interface TokenInfo {
  user: string;
  policies: string[];
  expireTime: string | null;
  renewable: boolean;
  ttl: number;
  checkedAt: number;
}
const login = new PersonalSession<{ token: string; info: TokenInfo | null; valid: boolean }>();

const renewTimers = new Map<number, ReturnType<typeof setInterval>>();
function scheduleRenew() {
  const id = currentUserId() ?? 0;
  if (renewTimers.has(id)) return;
  const timer = setInterval(() => void maybeRenew(), 15 * 60_000);
  timer.unref();
  renewTimers.set(id, timer);
}

const baseUrl = () => config.vault.baseUrl.replace(/\/$/, "");

/** `hvs.…`, `X-Vault-Token: hvs.…`, or a Copy-as-cURL of a Vault UI request. */
export function parseVaultToken(raw: string): string {
  const curl = parseCurl(raw);
  const t = (curl ? (curl.headers["x-vault-token"] ?? "") : raw)
    .trim()
    .replace(/^x-vault-token:\s*/i, "")
    .replace(/^["']|["']$/g, "");
  if (!t && curl)
    throw new Error(
      "lệnh cURL không có header X-Vault-Token — dùng 'Copy token' ở menu user của Vault UI",
    );
  if (!/^(hv[sbr]\.|[sbr]\.)[A-Za-z0-9_.-]{20,}$/.test(t))
    throw new Error(
      "token Vault không đúng dạng (hvs.… / s.…) — dùng 'Copy token' ở menu user của Vault UI",
    );
  return t;
}

type VaultData = {
  display_name?: string;
  meta?: { username?: string; email?: string };
  policies?: string[];
  identity_policies?: string[];
  expire_time?: string | null;
  renewable?: boolean;
  ttl?: number;
  secret?: Record<string, { type: string; options?: { version?: string } }>;
  keys?: string[];
  data?: Record<string, unknown>;
  metadata?: { version?: number; created_time?: string };
  version?: number;
};

async function call(
  path: string,
  token: string,
  opts: { method?: "GET" | "POST" | "PATCH"; params?: Record<string, string>; body?: unknown } = {},
) {
  const url = new URL(`${baseUrl()}/v1/${path.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      "X-Vault-Token": token,
      Accept: "application/json",
      ...(opts.body === undefined ? {} : { "Content-Type": "application/merge-patch+json" }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(15_000),
  });
  const j: { errors?: string[]; data?: VaultData } = await res.json().catch(() => ({}));
  if (
    res.status === 403 &&
    /permission denied/i.test(String(j?.errors ?? "")) &&
    path === "auth/token/lookup-self"
  ) {
    if (login.current && token === login.current.token) login.current.valid = false;
    throw new Error(
      "token Vault hết hạn hoặc không hợp lệ — người dùng cần dán token mới ở trang Integrations",
    );
  }
  if (res.status === 404) return null;
  if (!res.ok)
    throw new Error(
      `Vault ${res.status} ${path.split("/").slice(0, 2).join("/")}…: ${(j?.errors ?? []).join("; ") || "lỗi"}`,
    );
  return j;
}

async function lookup(token: string): Promise<TokenInfo> {
  const j = await call("auth/token/lookup-self", token);
  const d: VaultData = j?.data ?? {};
  return {
    user: String(d.display_name ?? d.meta?.username ?? d.meta?.email ?? "?"),
    policies: [...new Set([...(d.policies ?? []), ...(d.identity_policies ?? [])])] as string[],
    expireTime: d.expire_time ?? null,
    renewable: !!d.renewable,
    ttl: Number(d.ttl ?? 0),
    checkedAt: Date.now(),
  };
}

/** Renew our own token when it has less than a third of a day (or half its TTL) left. Never throws. */
async function maybeRenew() {
  if (!login.current?.valid || !login.current.info?.renewable) return;
  try {
    const info = await lookup(login.current.token);
    login.current.info = info;
    if (info.ttl > 0 && info.ttl < 8 * 3600) {
      await call("auth/token/renew-self", login.current.token, { method: "POST" });
      login.current.info = await lookup(login.current.token);
    }
  } catch {
    if (login.current) login.current.valid = false;
  }
}

export async function loadVaultToken() {
  const t = await settings.get(SETTING);
  if (!t) {
    if (login.current) login.current = null;
    return;
  }
  if (login.current?.token === t) return;
  login.current = { token: t, info: null, valid: true };
  scheduleRenew();
}

export async function vaultStatus(check = false) {
  if (
    login.current &&
    (check || !login.current.info || Date.now() - login.current.info.checkedAt > 60_000)
  ) {
    try {
      login.current.info = await lookup(login.current.token);
      login.current.valid = true;
    } catch {
      login.current.valid = false;
    }
  }
  const i = login.current?.info;
  return {
    baseUrl: baseUrl(),
    connected: !!login.current?.valid,
    expired: !!login.current && !login.current.valid,
    user: i?.user ?? null,
    policies: i?.policies ?? [],
    expiresAt: i?.expireTime ?? null,
    renewable: i?.renewable ?? false,
  };
}

export async function setVaultToken(raw: string) {
  const token = parseVaultToken(raw);
  const info = await lookup(token);
  login.current = { token, info, valid: true };
  await settings.set(SETTING, token);
  scheduleRenew();
  return vaultStatus();
}

export async function clearVaultToken() {
  login.current = null;
  const id = currentUserId() ?? 0;
  clearInterval(renewTimers.get(id));
  renewTimers.delete(id);
  await settings.set(SETTING, "");
  return vaultStatus();
}

export const vaultConnected = () => !!login.current?.valid;
export const vaultExpired = () => !!login.current && !login.current.valid;

function requireToken() {
  if (!login.current?.valid)
    throw new Error(
      login.current
        ? "token Vault hết hạn — người dùng cần dán token mới ở trang Integrations"
        : "chưa kết nối Vault — người dùng dán token ở trang Integrations",
    );
  return login.current.token;
}

// ---------------------------------------------------------------- read-only operations used by the agent tools

interface Mount {
  path: string;
  type: string;
  version: number;
}

async function mounts(): Promise<Mount[]> {
  const j = await call("sys/internal/ui/mounts", requireToken());
  const secret = j?.data?.secret ?? {};
  return Object.entries(secret)
    .filter(([, m]) => ["kv", "generic"].includes(m.type))
    .map(([path, m]) => ({
      path: path.replace(/\/$/, ""),
      type: m.type,
      version: Number(m.options?.version ?? 1),
    }));
}

function split(all: Mount[], path: string) {
  const p = path.replace(/^\/+|\/+$/g, "");
  const m = all
    .filter((x) => p === x.path || p.startsWith(x.path + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!m)
    throw new Error(
      `"${path}" không thuộc KV mount nào token này thấy: ${all.map((x) => x.path).join(", ") || "(không có)"}`,
    );
  return { mount: m, rest: p.slice(m.path.length).replace(/^\/+/, "") };
}

/** Mounts (no path) or the entries under a KV folder. Folders end with "/". */
export async function vaultList(path?: string) {
  const all = await mounts();
  if (!path?.replace(/\//g, ""))
    return { mounts: all.map((m) => ({ path: m.path + "/", kv_version: m.version })) };
  const { mount, rest } = split(all, path);
  const folder = rest ? `${rest.replace(/\/+$/, "")}/` : "";
  const api = mount.version === 2 ? `${mount.path}/metadata/${folder}` : `${mount.path}/${folder}`;
  const j = await call(api, requireToken(), { params: { list: "true" } });
  return {
    path: `${mount.path}/${rest}`.replace(/\/+$/, "") + "/",
    entries: (j?.data?.keys ?? []) as string[],
  };
}

const SENSITIVE_NAME =
  /pass|pwd|secret|token|key|private|cred|salt|pin|otp|cert|signature|dsn|conn|auth|cookie|session/i;
const SAFE_VALUE = /^(true|false|-?\d{1,10}(\.\d{1,6})?)$/i;

/** Describe one value without disclosing it. */
export function describeValue(key: string, v: unknown) {
  if (v === null || v === undefined) return { key, set: false };
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (!s.length) return { key, set: false, note: "empty" };
  if (!SENSITIVE_NAME.test(key) && SAFE_VALUE.test(s.trim()))
    return { key, set: true, value: s.trim() };
  return { key, set: true, length: s.length };
}

/**
 * Key names of a secret with presence/length (values withheld), optionally checking that `expect` keys exist.
 * Matching of `expect` is exact first, then case-insensitive.
 */
export async function vaultKeys(path: string, expect?: string[]) {
  const all = await mounts();
  const { mount, rest } = split(all, path);
  if (!rest) throw new Error("cần path tới một secret, không phải mount");
  const api = mount.version === 2 ? `${mount.path}/data/${rest}` : `${mount.path}/${rest}`;
  const j = await call(api, requireToken());
  if (!j) throw new Error(`không có secret tại ${path} (dùng vault.list để xem các path)`);
  const data: Record<string, unknown> = (mount.version === 2 ? j.data?.data : j.data) ?? {};
  const meta = mount.version === 2 ? j.data?.metadata : undefined;
  const keys = Object.keys(data)
    .sort()
    .map((k) => describeValue(k, data[k]));
  const out: Record<string, unknown> = { path: `${mount.path}/${rest}`, count: keys.length, keys };
  if (meta) {
    out.version = meta.version;
    out.updated_at = meta.created_time;
  }
  if (expect?.length) {
    const names = Object.keys(data);
    out.expected = expect.map((e) => {
      const exact = names.includes(e) ? e : names.find((n) => n.toLowerCase() === e.toLowerCase());
      return exact
        ? {
            ...describeValue(exact, data[exact]),
            key: e,
            present: true,
            ...(exact !== e ? { actual_name: exact } : {}),
          }
        : { key: e, present: false };
    });
  }
  return out;
}

const PRODUCTION = /(^|[^a-z])(prod|production|live|prd)([^a-z]|$)/i;

/** The KV v2 secret and key a write would target, or an error: QC allowlist only, production never. */
export async function vaultWriteTarget(path: string, key: string) {
  const host = new URL(baseUrl()).hostname;
  if (!/(^|[.-])qc([.-]|\d|$)/i.test(host) || PRODUCTION.test(host))
    throw new Error(`writing is refused: Vault ${host} is not a QC environment`);
  const allow = config.vault.writeAllow ?? [];
  if (!allow.length)
    throw new Error("writing is disabled: no QC Vault path is allowlisted (vault.writeAllow)");
  if (!/^[A-Za-z0-9_./-]+$/.test(path))
    throw new Error(
      `path "${path}" has unsupported characters (allowed: letters, digits, _ . - /)`,
    );
  const segments = path.split("/").filter(Boolean);
  if (segments.some((s) => s === ".." || s === "."))
    throw new Error(`path "${path}" must not contain ".." or "."`);
  const clean = segments.join("/");
  if (PRODUCTION.test(clean))
    throw new Error(`writing to production (${clean}) is never allowed from chat`);
  const ok = allow.some(
    (a) =>
      (a.keys.includes("*") || a.keys.includes(key)) &&
      (a.path.endsWith("*") ? clean.startsWith(a.path.slice(0, -1)) : a.path === clean),
  );
  if (!ok) throw new Error(`${clean} ${key} is not in the QC write allowlist`);
  const { mount, rest } = split(await mounts(), clean);
  if (!rest) throw new Error("need a path to a secret, not a mount");
  if (mount.version !== 2)
    throw new Error(`mount ${mount.path} is KV v1: only KV v2 can be written`);
  return { path: `${mount.path}/${rest}`, mount: mount.path, rest };
}

async function readWriteTarget(a: { path: string; key: string }) {
  const t = await vaultWriteTarget(a.path, a.key);
  const token = requireToken();
  const cur = await call(`${t.mount}/data/${t.rest}`, token);
  if (!cur) throw new Error(`secret ${t.path} does not exist; creating secrets is not supported`);
  const cas = Number(cur.data?.metadata?.version);
  if (!Number.isInteger(cas))
    throw new Error(
      `secret ${t.path} has no readable version; refusing to write without check-and-set`,
    );
  return { ...t, token, cas };
}

/** What a write would target and the secret version it was read at (used by the confirmation and the idempotency key). */
export async function vaultSetKeyTarget(a: { path: string; key: string }) {
  const t = await readWriteTarget(a);
  return { path: t.path, key: a.key, version: t.cas };
}

/** Set one key of an existing KV v2 secret (merge-patch with check-and-set). The old value is never read into the result. */
export async function setVaultKey(a: { path: string; key: string; value: string }) {
  const t = await readWriteTarget(a);
  const { token, cas } = t;
  let j;
  try {
    j = await call(`${t.mount}/data/${t.rest}`, token, {
      method: "PATCH",
      body: { options: { cas }, data: { [a.key]: a.value } },
    });
  } catch (e) {
    if (/check-and-set/i.test(String(e)))
      throw new Error(`secret ${t.path} changed since it was read; read it again and retry`);
    throw e;
  }
  if (!j) throw new Error(`secret ${t.path} was not written: Vault answered 404 to the patch`);
  return {
    written: true as const,
    path: t.path,
    key: a.key,
    version: Number(j?.data?.version),
    downstream_verified: false as const,
  };
}

/**
 * Server-side only (never registered as an agent tool): the raw values of `keys` at `path`, for backend-managed
 * credentials such as QC test-account logins. Callers must not return them to a model, a log or an API response.
 */
export async function vaultSecretValues(path: string, keys: string[]) {
  const all = await mounts();
  const { mount, rest } = split(all, path);
  const api = mount.version === 2 ? `${mount.path}/data/${rest}` : `${mount.path}/${rest}`;
  const j = await call(api, requireToken());
  const data: Record<string, unknown> = (mount.version === 2 ? j?.data?.data : j?.data) ?? {};
  return Object.fromEntries(
    keys.map((k) => {
      const v = data[k];
      if (typeof v !== "string" || !v) throw new Error(`Vault ${path} has no value for ${k}`);
      return [k, v];
    }),
  );
}
