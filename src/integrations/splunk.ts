import { config } from "../config.ts";
import { settings } from "../db.ts";
import { redactPii } from "./redact.ts";
import { cookiePairs } from "./curl.ts";

/**
 * Splunk (production SIEM) — read-only searches for bug investigation.
 *
 * Splunk Web logs in through Google SAML, so there is no API token to obtain and the management port (8089) is not
 * reachable. The developer pastes the Cookie header of a logged-in Splunk Web request; the platform then calls splunkd
 * through Splunk Web's own proxy (`/<locale>/splunkd/__raw/services/...`) with that session, sending the CSRF value of
 * the `splunkweb_csrf_token_<port>` cookie as `X-Splunk-Form-Key` on POST.
 *
 * Production guard rails: SPL that writes or reaches outside search (delete, collect, outputlookup, sendemail, rest, …)
 * is refused, the time window and result count are capped, and results are PII-masked before the agent sees them.
 */

const SETTING = "splunk_cookie";
let session: { cookie: string; formKey: string; user: string; roles: string[]; checkedAt: number; valid: boolean } | null = null;

const base = () => `${config.splunk.baseUrl.replace(/\/$/, "")}/${config.splunk.locale}/splunkd/__raw`;

/**
 * Cookie header, `Cookie:` line, or Copy-as-cURL (bash or Windows cmd) → cookie string + CSRF form key.
 * The form key is the `splunkweb_csrf_token_<port>` of the same port as the `splunkd_<port>` session cookie (browsers
 * often keep a stale token of another port), or the request's own `x-splunk-form-key` header when a cURL was pasted.
 */
export function parseSplunkCookie(raw: string): { cookie: string; formKey: string } {
  const { pairs, headers } = cookiePairs(raw);
  const value = (name: string) => {
    const p = pairs.find((x) => x.startsWith(`${name}=`));
    return p === undefined ? undefined : decodeURIComponent(p.slice(name.length + 1));
  };
  const session = pairs.map((p) => p.match(/^splunkd_(\d+)=/)).filter(Boolean) as RegExpMatchArray[];
  if (!session.length) throw new Error("không thấy cookie splunkd_<port> — copy cả header Cookie (hoặc Copy as cURL) của một request tới siem.hasaki.work");
  const ports = session.map((m) => m[1]);
  const formKey = headers["x-splunk-form-key"] ?? ports.map((port) => value(`splunkweb_csrf_token_${port}`)).find(Boolean);
  if (!formKey) throw new Error(`không thấy cookie splunkweb_csrf_token_${ports[0]} — copy cả header Cookie, không chỉ một cookie`);
  return { cookie: pairs.join("; "), formKey };
}

async function call(method: "GET" | "POST", path: string, s: { cookie: string; formKey: string }, form?: Record<string, string>) {
  const res = await fetch(`${base()}${path}`, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(config.splunk.timeoutSeconds * 1000),
    headers: {
      Cookie: s.cookie,
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...(method === "POST" ? { "X-Splunk-Form-Key": s.formKey, "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const text = await res.text();
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
    if (session && s.cookie === session.cookie) session.valid = false;
    throw new Error("phiên Splunk hết hạn hoặc không hợp lệ — người dùng cần dán cookie mới ở trang Integrations (hỏi qua ask_user nếu cần log prod)");
  }
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const msg = json?.messages?.map((m: any) => m.text).join("; ") || text.slice(0, 300);
    throw new Error(`Splunk ${res.status}: ${msg}`);
  }
  return json;
}

async function whoami(s: { cookie: string; formKey: string }) {
  const j = await call("GET", "/services/authentication/current-context?output_mode=json", s);
  const c = j?.entry?.[0]?.content ?? {};
  if (!c.username) throw new Error("Splunk không trả về user cho phiên này");
  return { user: String(c.username), roles: (c.roles ?? []) as string[] };
}

export async function loadSplunkCookie() {
  const saved = await settings.get(SETTING);
  if (!saved) return;
  try {
    const { cookie, formKey, user, roles } = JSON.parse(saved);
    session = { cookie, formKey, user, roles: roles ?? [], checkedAt: 0, valid: true };
  } catch {}
}

/** Status; re-checks the session with Splunk at most once a minute (sessions expire after inactivity). */
export async function splunkStatus(check = false) {
  if (session && (check || Date.now() - session.checkedAt > 60_000)) {
    try {
      await whoami(session);
      session.valid = true;
    } catch {
      session.valid = false;
    }
    session.checkedAt = Date.now();
  }
  return {
    baseUrl: config.splunk.baseUrl,
    connected: !!session?.valid,
    expired: !!session && !session.valid,
    user: session?.user ?? null,
    roles: session?.roles ?? [],
    checkedAt: session?.checkedAt ? new Date(session.checkedAt).toISOString() : null,
    limits: { maxMinutes: config.splunk.maxMinutes, maxResults: config.splunk.maxResults, allowedIndexes: config.splunk.allowedIndexes },
  };
}

export async function setSplunkCookie(raw: string) {
  const parsed = parseSplunkCookie(raw);
  const who = await whoami(parsed);
  session = { ...parsed, ...who, checkedAt: Date.now(), valid: true };
  await settings.set(SETTING, JSON.stringify({ cookie: parsed.cookie, formKey: parsed.formKey, user: who.user, roles: who.roles }));
  return splunkStatus();
}

export async function clearSplunkCookie() {
  session = null;
  await settings.set(SETTING, "");
  return splunkStatus();
}

export const splunkConnected = () => !!session?.valid;
export const splunkExpired = () => !!session && !session.valid;

// ---------------------------------------------------------------- SPL guard rails

/** Commands that write data, send things out, run code, or call arbitrary REST endpoints. */
const FORBIDDEN = new Set(
  "delete collect summaryindex outputlookup outputcsv outputtext tscollect mcollect meventcollect sendemail sendalert script run runshellscript rest map dbxquery dbxoutput dbxlookup savedsearch loadjob history crawl dispatch".split(" "),
);

export function checkSpl(raw: string): string {
  let spl = raw.trim().replace(/\s+/g, " ");
  if (!spl) throw new Error("query rỗng");
  // every command after a pipe (top level and inside [subsearches]) must be a read-only one
  for (const m of spl.matchAll(/(?:^|[|\[])\s*([A-Za-z_]\w*)/g))
    if (FORBIDDEN.has(m[1].toLowerCase())) throw new Error(`lệnh SPL "${m[1]}" không được phép (chỉ search đọc dữ liệu)`);
  if (!/^(search\b|\|)/i.test(spl)) spl = `search ${spl}`;
  const allowed = config.splunk.allowedIndexes;
  if (allowed.length) {
    const used = [...spl.matchAll(/\bindex\s*=\s*"?([\w*:-]+)"?/gi)].map((m) => m[1].toLowerCase());
    if (!used.length) throw new Error(`query phải chỉ rõ index=… (được phép: ${allowed.join(", ")})`);
    const bad = used.filter((i) => !allowed.some((a) => a.toLowerCase() === i));
    if (bad.length) throw new Error(`index không được phép: ${bad.join(", ")} (được phép: ${allowed.join(", ")})`);
  }
  return spl;
}

export interface SplunkQuery {
  query: string;
  since_minutes?: number;
  until_minutes?: number;
  max_results?: number;
}

export async function splunkSearch(q: SplunkQuery) {
  if (!session?.valid) throw new Error(session ? "phiên Splunk hết hạn — người dùng cần dán cookie mới ở trang Integrations" : "chưa kết nối Splunk — người dùng dán cookie ở trang Integrations");
  const spl = checkSpl(q.query);
  const since = Math.min(q.since_minutes ?? 60, config.splunk.maxMinutes);
  const until = Math.max(0, Math.min(q.until_minutes ?? 0, since - 1));
  const count = Math.min(q.max_results ?? 100, config.splunk.maxResults);
  const j = await call("POST", "/services/search/jobs", session, {
    search: spl,
    exec_mode: "oneshot",
    earliest_time: `-${Math.round(since)}m`,
    latest_time: until ? `-${Math.round(until)}m` : "now",
    count: String(count),
    output_mode: "json",
    max_time: String(config.splunk.timeoutSeconds),
  });
  session.checkedAt = Date.now();
  const rows: any[] = j?.results ?? [];
  const mask = (v: unknown): unknown => (typeof v === "string" ? redactPii(v) : Array.isArray(v) ? v.map(mask) : v);
  const results = rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k.startsWith("_") && !["_time", "_raw"].includes(k)) continue; // _cd, _bkt, _si, _serial…
      out[k] = mask(v);
    }
    return out;
  });
  const messages = (j?.messages ?? []).map((m: any) => `${m.type}: ${m.text}`);
  return { query: spl, window: { earliest: `-${since}m`, latest: until ? `-${until}m` : "now" }, count: results.length, truncated: results.length >= count, ...(messages.length ? { messages } : {}), results };
}
