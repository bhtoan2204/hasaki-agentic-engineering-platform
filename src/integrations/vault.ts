import { config } from "../config.ts";
import { settings } from "../db.ts";
import { parseCurl } from "./curl.ts";

/**
 * HashiCorp Vault (QC) — lets an agent check which secrets/keys a service has, never their values.
 *
 * The developer logs in to the Vault UI (OIDC/Keycloak) and pastes the token from the user menu ("Copy token"). The
 * platform only reads (GET, `?list=true` for listings); the single write is renewing that same token (`renew-self`) so
 * it lives as long as Vault allows. Secret values are read server-side and reduced to presence/length before anything
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
let session: { token: string; info: TokenInfo | null; valid: boolean } | null = null;
let renewTimer: NodeJS.Timeout | null = null;

const baseUrl = () => config.vault.baseUrl.replace(/\/$/, "");

/** `hvs.…`, `X-Vault-Token: hvs.…`, or a Copy-as-cURL of a Vault UI request. */
export function parseVaultToken(raw: string): string {
  const curl = parseCurl(raw);
  let t = (curl ? (curl.headers["x-vault-token"] ?? "") : raw).trim().replace(/^x-vault-token:\s*/i, "").replace(/^["']|["']$/g, "");
  if (!t && curl) throw new Error("lệnh cURL không có header X-Vault-Token — dùng 'Copy token' ở menu user của Vault UI");
  if (!/^(hv[sbr]\.|[sbr]\.)[A-Za-z0-9_.-]{20,}$/.test(t)) throw new Error("token Vault không đúng dạng (hvs.… / s.…) — dùng 'Copy token' ở menu user của Vault UI");
  return t;
}

async function call(path: string, token: string, opts: { method?: "GET" | "POST"; params?: Record<string, string> } = {}) {
  const url = new URL(`${baseUrl()}/v1/${path.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, { method: opts.method ?? "GET", headers: { "X-Vault-Token": token, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  const j: any = await res.json().catch(() => ({}));
  if (res.status === 403 && /permission denied/i.test(String(j?.errors ?? "")) && path === "auth/token/lookup-self") {
    if (session && token === session.token) session.valid = false;
    throw new Error("token Vault hết hạn hoặc không hợp lệ — người dùng cần dán token mới ở trang Integrations");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Vault ${res.status} ${path.split("/").slice(0, 2).join("/")}…: ${(j?.errors ?? []).join("; ") || "lỗi"}`);
  return j;
}

async function lookup(token: string): Promise<TokenInfo> {
  const j = await call("auth/token/lookup-self", token);
  const d = j?.data ?? {};
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
  if (!session?.valid || !session.info?.renewable) return;
  try {
    const info = await lookup(session.token);
    session.info = info;
    if (info.ttl > 0 && info.ttl < 8 * 3600) {
      await call("auth/token/renew-self", session.token, { method: "POST" });
      session.info = await lookup(session.token);
    }
  } catch {
    if (session) session.valid = false;
  }
}
function scheduleRenew() {
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = setInterval(() => void maybeRenew(), 15 * 60_000);
  renewTimer.unref();
}

export async function loadVaultToken() {
  const t = await settings.get(SETTING);
  if (!t) return;
  session = { token: t, info: null, valid: true };
  scheduleRenew();
}

export async function vaultStatus(check = false) {
  if (session && (check || !session.info || Date.now() - session.info.checkedAt > 60_000)) {
    try {
      session.info = await lookup(session.token);
      session.valid = true;
    } catch {
      session.valid = false;
    }
  }
  const i = session?.info;
  return {
    baseUrl: baseUrl(),
    connected: !!session?.valid,
    expired: !!session && !session.valid,
    user: i?.user ?? null,
    policies: i?.policies ?? [],
    expiresAt: i?.expireTime ?? null,
    renewable: i?.renewable ?? false,
  };
}

export async function setVaultToken(raw: string) {
  const token = parseVaultToken(raw);
  const info = await lookup(token);
  session = { token, info, valid: true };
  await settings.set(SETTING, token);
  scheduleRenew();
  return vaultStatus();
}

export async function clearVaultToken() {
  session = null;
  if (renewTimer) clearInterval(renewTimer), (renewTimer = null);
  await settings.set(SETTING, "");
  return vaultStatus();
}

export const vaultConnected = () => !!session?.valid;
export const vaultExpired = () => !!session && !session.valid;

function requireToken() {
  if (!session?.valid) throw new Error(session ? "token Vault hết hạn — người dùng cần dán token mới ở trang Integrations" : "chưa kết nối Vault — người dùng dán token ở trang Integrations");
  return session.token;
}

// ---------------------------------------------------------------- read-only operations used by the agent tools

interface Mount { path: string; type: string; version: number }

async function mounts(): Promise<Mount[]> {
  const j = await call("sys/internal/ui/mounts", requireToken());
  const secret = j?.data?.secret ?? {};
  return Object.entries<any>(secret)
    .filter(([, m]) => ["kv", "generic"].includes(m.type))
    .map(([path, m]) => ({ path: path.replace(/\/$/, ""), type: m.type, version: Number(m.options?.version ?? 1) }));
}

function split(all: Mount[], path: string) {
  const p = path.replace(/^\/+|\/+$/g, "");
  const m = all.filter((x) => p === x.path || p.startsWith(x.path + "/")).sort((a, b) => b.path.length - a.path.length)[0];
  if (!m) throw new Error(`"${path}" không thuộc KV mount nào token này thấy: ${all.map((x) => x.path).join(", ") || "(không có)"}`);
  return { mount: m, rest: p.slice(m.path.length).replace(/^\/+/, "") };
}

/** Mounts (no path) or the entries under a KV folder. Folders end with "/". */
export async function vaultList(path?: string) {
  const all = await mounts();
  if (!path?.replace(/\//g, "")) return { mounts: all.map((m) => ({ path: m.path + "/", kv_version: m.version })) };
  const { mount, rest } = split(all, path);
  const folder = rest ? `${rest.replace(/\/+$/, "")}/` : "";
  const api = mount.version === 2 ? `${mount.path}/metadata/${folder}` : `${mount.path}/${folder}`;
  const j = await call(api, requireToken(), { params: { list: "true" } });
  return { path: `${mount.path}/${rest}`.replace(/\/+$/, "") + "/", entries: (j?.data?.keys ?? []) as string[] };
}

const SENSITIVE_NAME = /pass|pwd|secret|token|key|private|cred|salt|pin|otp|cert|signature|dsn|conn|auth|cookie|session/i;
const SAFE_VALUE = /^(true|false|-?\d{1,10}(\.\d{1,6})?)$/i;

/** Describe one value without disclosing it. */
export function describeValue(key: string, v: unknown) {
  if (v === null || v === undefined) return { key, set: false };
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (!s.length) return { key, set: false, note: "empty" };
  if (!SENSITIVE_NAME.test(key) && SAFE_VALUE.test(s.trim())) return { key, set: true, value: s.trim() };
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
  const keys = Object.keys(data).sort().map((k) => describeValue(k, data[k]));
  const out: Record<string, unknown> = { path: `${mount.path}/${rest}`, count: keys.length, keys };
  if (meta) out.version = meta.version, (out.updated_at = meta.created_time);
  if (expect?.length) {
    const names = Object.keys(data);
    out.expected = expect.map((e) => {
      const exact = names.includes(e) ? e : names.find((n) => n.toLowerCase() === e.toLowerCase());
      return exact ? { ...describeValue(exact, data[exact]), key: e, present: true, ...(exact !== e ? { actual_name: exact } : {}) } : { key: e, present: false };
    });
  }
  return out;
}
