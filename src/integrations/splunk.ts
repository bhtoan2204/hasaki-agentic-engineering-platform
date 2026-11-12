import { createHash } from "node:crypto";
import { config } from "../config.ts";
import { pool, q, one, json } from "../db/pool.ts";
import { currentUserId } from "../auth/execution.ts";
import { getSharedSecret, putSharedSecret } from "../auth/secrets.ts";
import { personalSettings as settings, PersonalSession, actorId } from "./personal.ts";
import { redactPii } from "./redact.ts";
import { cookiePairs } from "./curl.ts";
import {
  compactEvent,
  normalizeEvent,
  parsePastedResults,
  type LogEvent,
} from "../investigation/events.ts";
import { formatInZone, parseTimeModifier } from "../investigation/time.ts";

/**
 * Splunk (production SIEM) — read-only searches for bug and incident investigation.
 *
 * Credentials (never sent to a model, never returned to the browser):
 *  - personal Splunk Web session: the developer pastes the Cookie header of a logged-in Splunk Web request (Google SAML,
 *    no API token needed); calls go through Splunk Web's proxy (`/<locale>/splunkd/__raw/services/...`) with the
 *    `splunkweb_csrf_token_<port>` value as `X-Splunk-Form-Key` on POST;
 *  - personal Splunk authentication token (`Authorization: Bearer`), against `splunk.managementUrl` when set, else the
 *    same Splunk Web proxy;
 *  - an administrator-managed shared service-account token (encrypted shared secret), usable by members only when
 *    `splunk.allowSharedToken` is on. A personal credential always wins.
 *
 * Production guard rails: SPL that writes or reaches outside search is refused, indexes must be named (and allowed),
 * time windows and result counts are capped, every search is audited (splunk_searches), and results are sanitized
 * (credentials, customer PII, payment data, signed URL parameters) before storage or any agent sees them.
 *
 * Two search paths share the transport:
 *  - `splunkSearch` — relative window, legacy agent tool `splunk.search` and the production error scan;
 *  - `investigationSearch` — absolute window in the investigation timezone, deduplicated per run, results persisted
 *    as evidence with stable references, paginated through the Splunk job, manual paste mode when not connected.
 */

type Auth =
  | { kind: "session"; cookie: string; formKey: string }
  | { kind: "token" | "shared_token"; token: string };
interface Login {
  auth: Auth;
  user: string;
  roles: string[];
  capabilities: string[];
  checkedAt: number;
  valid: boolean;
}

const SETTING_COOKIE = "splunk_cookie";
const SETTING_TOKEN = "splunk_token";
const SHARED_TOKEN = "splunk_token";
const login = new PersonalSession<Login>();
let shared: (Login & { loadedAt: number }) | null = null;

const webBase = () =>
  `${config.splunk.baseUrl.replace(/\/$/, "")}/${config.splunk.locale}/splunkd/__raw`;
const baseFor = (a: Auth) =>
  a.kind !== "session" && config.splunk.managementUrl
    ? config.splunk.managementUrl.replace(/\/$/, "")
    : webBase();

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
  const session = pairs
    .map((p) => p.match(/^splunkd_(\d+)=/))
    .filter(Boolean) as RegExpMatchArray[];
  if (!session.length)
    throw new Error(
      "không thấy cookie splunkd_<port> — copy cả header Cookie (hoặc Copy as cURL) của một request tới siem.hasaki.work",
    );
  const ports = session.map((m) => m[1]);
  const formKey =
    headers["x-splunk-form-key"] ??
    ports.map((port) => value(`splunkweb_csrf_token_${port}`)).find(Boolean);
  if (!formKey)
    throw new Error(
      `không thấy cookie splunkweb_csrf_token_${ports[0]} — copy cả header Cookie, không chỉ một cookie`,
    );
  return { cookie: pairs.join("; "), formKey };
}

function invalidate(a: Auth) {
  if (login.current && login.current.auth === a) login.current.valid = false;
  if (shared && shared.auth === a) shared.valid = false;
}

async function call(
  method: "GET" | "POST",
  path: string,
  a: Auth,
  form?: Record<string, string>,
  timeoutSeconds = config.splunk.timeoutSeconds,
  raw = false,
) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (a.kind === "session") {
    headers.Cookie = a.cookie;
    headers["X-Requested-With"] = "XMLHttpRequest";
    if (method === "POST") headers["X-Splunk-Form-Key"] = a.formKey;
  } else headers.Authorization = `Bearer ${a.token}`;
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  let res: Response;
  try {
    res = await fetch(`${baseFor(a)}${path}`, {
      method,
      redirect: "manual",
      // a little longer than the search's own max_time, so Splunk finalizes and answers first
      signal: AbortSignal.timeout((timeoutSeconds + 15) * 1000),
      headers,
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
  } catch (e) {
    const err = e as Error;
    throw new Error(
      err.name === "TimeoutError"
        ? `Splunk không trả lời trong ${timeoutSeconds + 15}s`
        : `không kết nối được Splunk: ${err.message}`,
    );
  }
  const text = await res.text();
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
    invalidate(a);
    throw new Error(
      a.kind === "session"
        ? "phiên Splunk hết hạn hoặc không hợp lệ — người dùng cần dán cookie mới ở trang Integrations (hỏi qua ask_user nếu cần log prod)"
        : `Splunk token bị từ chối (${res.status}) — token hết hạn, bị thu hồi hoặc sai; cập nhật token ở trang Integrations`,
    );
  }
  if (raw && res.ok) return text;
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const msg = body?.messages?.map((m: any) => m.text).join("; ") || text.slice(0, 300);
    const err = new Error(
      res.status === 403
        ? `Splunk 403: tài khoản Splunk không có quyền cho thao tác này (${msg})`
        : `Splunk ${res.status}: ${msg}`,
    );
    (err as any).status = res.status;
    throw err;
  }
  return body;
}

async function whoami(a: Auth) {
  const j = await call("GET", "/services/authentication/current-context?output_mode=json", a);
  const c = j?.entry?.[0]?.content ?? {};
  if (!c.username) throw new Error("Splunk không trả về user cho phiên này");
  return {
    user: String(c.username),
    roles: (c.roles ?? []) as string[],
    capabilities: (c.capabilities ?? []) as string[],
  };
}

export async function loadSplunkCookie() {
  await loadShared();
  const token = await settings.get(SETTING_TOKEN);
  const saved = token ? null : await settings.get(SETTING_COOKIE);
  if (!token && !saved) {
    if (login.current) login.current = null;
    return;
  }
  try {
    if (token) {
      const t = JSON.parse(token);
      login.current = {
        auth: { kind: "token", token: t.token },
        user: t.user,
        roles: t.roles ?? [],
        capabilities: t.capabilities ?? [],
        checkedAt: 0,
        valid: true,
      };
    } else {
      const { cookie, formKey, user, roles } = JSON.parse(saved!);
      login.current = {
        auth: { kind: "session", cookie, formKey },
        user,
        roles: roles ?? [],
        capabilities: [],
        checkedAt: 0,
        valid: true,
      };
    }
  } catch {}
}

async function loadShared(force = false) {
  if (!force && shared && Date.now() - shared.loadedAt < 60_000) return;
  const v = await getSharedSecret(SHARED_TOKEN).catch(() => null);
  if (!v) {
    shared = null;
    return;
  }
  try {
    const t = JSON.parse(v);
    if (shared?.auth.kind === "shared_token" && shared.auth.token === t.token)
      shared.loadedAt = Date.now();
    else
      shared = {
        auth: { kind: "shared_token", token: t.token },
        user: t.user,
        roles: t.roles ?? [],
        capabilities: t.capabilities ?? [],
        checkedAt: 0,
        valid: true,
        loadedAt: Date.now(),
      };
  } catch {
    shared = null;
  }
}

const sharedUsable = () => config.splunk.allowSharedToken && !!shared?.valid;
/** The credential a search of the current actor uses: personal first, then the shared token when permitted. */
function activeLogin(): Login | null {
  if (login.current?.valid) return login.current;
  return sharedUsable() ? shared : null;
}

/** Capabilities that make a Splunk account more than read-only; reported as a warning on test connection. */
const WRITE_CAPABILITIES = [
  "delete_by_keyword",
  "admin_all_objects",
  "edit_user",
  "edit_roles",
  "edit_indexes",
  "indexes_edit",
  "edit_tokens_all",
  "edit_server",
  "edit_search_server",
  "can_delete",
];

/** Status; re-checks the session with Splunk at most once a minute (sessions expire after inactivity). */
export async function splunkStatus(check = false) {
  if (login.current && (check || Date.now() - login.current.checkedAt > 60_000)) {
    try {
      const who = await whoami(login.current.auth);
      login.current.valid = true;
      login.current.capabilities = who.capabilities;
    } catch {
      login.current.valid = false;
    }
    login.current.checkedAt = Date.now();
  }
  const active = activeLogin();
  return {
    baseUrl: config.splunk.baseUrl,
    managementUrl: config.splunk.managementUrl || null,
    connected: !!active,
    expired: !!login.current && !login.current.valid,
    auth: active ? (active.auth.kind === "session" ? "session" : active.auth.kind) : null,
    source: login.current?.valid ? "personal" : active ? "shared" : "none",
    user: login.current?.user ?? (active ? active.user : null),
    roles: login.current?.roles ?? active?.roles ?? [],
    checkedAt: login.current?.checkedAt ? new Date(login.current.checkedAt).toISOString() : null,
    shared: {
      configured: !!shared,
      valid: !!shared?.valid,
      allowed: config.splunk.allowSharedToken,
      user: shared?.user ?? null,
    },
    environment: config.splunk.environment,
    timezone: config.splunk.timezone,
    limits: {
      maxMinutes: config.splunk.maxMinutes,
      maxResults: config.splunk.maxResults,
      allowedIndexes: config.splunk.allowedIndexes,
      defaultIndexes: config.splunk.defaultIndexes,
      timeoutSeconds: config.splunk.timeoutSeconds,
      concurrency: config.splunk.concurrency,
      queryBudget: config.splunk.queryBudget,
    },
  };
}

export async function setSplunkCookie(raw: string) {
  const parsed = parseSplunkCookie(raw);
  const auth: Auth = { kind: "session", ...parsed };
  const who = await whoami(auth);
  login.current = { auth, ...who, checkedAt: Date.now(), valid: true };
  await settings.set(SETTING_TOKEN, "");
  await settings.set(
    SETTING_COOKIE,
    JSON.stringify({
      cookie: parsed.cookie,
      formKey: parsed.formKey,
      user: who.user,
      roles: who.roles,
    }),
  );
  return splunkStatus();
}

const cleanToken = (raw: string) => {
  const t = String(raw ?? "")
    .trim()
    .replace(/^(Bearer|Splunk)\s+/i, "");
  if (!/^[A-Za-z0-9._~+/=-]{20,}$/.test(t))
    throw new Error(
      "Splunk token không đúng dạng (dán nguyên token xác thực Splunk, không kèm khoảng trắng)",
    );
  return t;
};

/** Personal Splunk authentication token (Settings → Tokens in Splunk). Validated before saving. */
export async function setSplunkToken(raw: string) {
  const token = cleanToken(raw);
  const auth: Auth = { kind: "token", token };
  const who = await whoami(auth);
  login.current = { auth, ...who, checkedAt: Date.now(), valid: true };
  await settings.set(SETTING_COOKIE, "");
  await settings.set(SETTING_TOKEN, JSON.stringify({ token, ...who }));
  return splunkStatus();
}

/** Administrator: shared read-only service-account token (encrypted shared secret). */
export async function setSharedSplunkToken(raw: string) {
  const token = cleanToken(raw);
  const auth: Auth = { kind: "shared_token", token };
  const who = await whoami(auth);
  await putSharedSecret(SHARED_TOKEN, JSON.stringify({ token, ...who }));
  shared = { auth, ...who, checkedAt: Date.now(), valid: true, loadedAt: Date.now() };
  return splunkStatus();
}

export async function clearSharedSplunkToken() {
  await q(pool, "DELETE FROM shared_secrets WHERE kind = $1", [SHARED_TOKEN]);
  shared = null;
  return splunkStatus();
}

export async function clearSplunkCookie() {
  login.current = null;
  await settings.set(SETTING_COOKIE, "");
  await settings.set(SETTING_TOKEN, "");
  return splunkStatus();
}

export const splunkConnected = () => !!activeLogin();
export const splunkExpired = () => !!login.current && !login.current.valid && !sharedUsable();

/**
 * Test connection: identity, read-only posture (no write/admin capabilities) and access to the default indexes with a
 * tiny `tstats` count over the last 15 minutes. Never returns credentials.
 */
export async function splunkTestConnection(indexes = config.splunk.defaultIndexes) {
  await loadShared();
  const active = activeLogin();
  if (!active)
    throw new Error(
      login.current
        ? "Splunk credential expired — paste a new cookie or token on the Integrations page"
        : "Splunk is not connected — paste a session cookie or a token on the Integrations page",
    );
  const t0 = Date.now();
  const who = await whoami(active.auth);
  active.valid = true;
  active.checkedAt = Date.now();
  active.capabilities = who.capabilities;
  const write = who.capabilities.filter((c) => WRITE_CAPABILITIES.includes(c));
  const checks: Array<{ index: string; ok: boolean; events_15m?: number; error?: string }> = [];
  for (const index of indexes.slice(0, 5)) {
    if (!/^[\w:-]+$/.test(index)) {
      checks.push({ index, ok: false, error: "invalid index name" });
      continue;
    }
    try {
      const r = await call(
        "POST",
        "/services/search/jobs",
        active.auth,
        {
          search: `| tstats count where index=${index}`,
          earliest_time: "-15m",
          latest_time: "now",
          exec_mode: "oneshot",
          output_mode: "json",
          max_time: "20",
        },
        20,
      );
      checks.push({ index, ok: true, events_15m: Number(r?.results?.[0]?.count ?? 0) });
    } catch (e) {
      checks.push({ index, ok: false, error: (e as Error).message });
    }
  }
  return {
    ok: checks.every((c) => c.ok),
    auth: active.auth.kind,
    user: who.user,
    roles: who.roles,
    read_only: write.length === 0,
    ...(write.length
      ? {
          warning: `account has write/admin capabilities (${write.join(", ")}); use a read-only role for investigations`,
        }
      : {}),
    indexes: checks,
    latency_ms: Date.now() - t0,
    environment: config.splunk.environment,
  };
}

// ---------------------------------------------------------------- SPL guard rails

/** Commands that write data, send things out, run code, or call arbitrary REST endpoints. */
const FORBIDDEN = new Set(
  "delete collect summaryindex sichart sitimechart sistats sitop sirare outputlookup outputcsv outputtext tscollect mcollect meventcollect sendemail sendalert script run runshellscript rest map dbxquery dbxoutput dbxlookup savedsearch loadjob history crawl dispatch ldapsearch ldapfetch ldapgroup ldapfilter".split(
    " ",
  ),
);
const AGGREGATING =
  /\|\s*(stats|tstats|timechart|chart|top|rare|eventstats|streamstats|transaction|dedup|head|tail)\b/i;

export function checkSpl(raw: string): string {
  let spl = raw.trim().replace(/\s+/g, " ");
  if (!spl) throw new Error("query rỗng");
  // every command after a pipe (top level and inside [subsearches]) must be a read-only one
  for (const m of spl.matchAll(/(?:^|[|\[])\s*([A-Za-z_]\w*)/g))
    if (FORBIDDEN.has(m[1].toLowerCase()))
      throw new Error(`lệnh SPL "${m[1]}" không được phép (chỉ search đọc dữ liệu)`);
  if (!/^(search\b|\|)/i.test(spl)) spl = `search ${spl}`;
  const allowed = config.splunk.allowedIndexes;
  if (allowed.length) {
    const used = [...spl.matchAll(/\bindex\s*=\s*"?([\w*:-]+)"?/gi)].map((m) => m[1].toLowerCase());
    if (!used.length)
      throw new Error(`query phải chỉ rõ index=… (được phép: ${allowed.join(", ")})`);
    const bad = used.filter((i) => !allowed.some((a) => a.toLowerCase() === i));
    if (bad.length)
      throw new Error(
        `index không được phép: ${bad.join(", ")} (được phép: ${allowed.join(", ")})`,
      );
  }
  return spl;
}

/** Split at the first top-level pipe (outside quotes and [subsearches]). */
function splitBase(spl: string): [string, string] {
  let quote = false;
  let depth = 0;
  for (let i = 0; i < spl.length; i++) {
    const c = spl[i];
    if (c === '"' && spl[i - 1] !== "\\") quote = !quote;
    else if (!quote && c === "[") depth++;
    else if (!quote && c === "]") depth--;
    else if (!quote && depth === 0 && c === "|" && i > 0) return [spl.slice(0, i), spl.slice(i)];
  }
  return [spl, ""];
}

export interface ValidatedSpl {
  spl: string;
  indexes: string[];
  earliest?: string;
  latest?: string;
}

/**
 * Strict validation for investigation searches, on top of `checkSpl`:
 *  - an explicit, wildcard-free index (within `allowedIndexes` when configured);
 *  - inline earliest=/latest= in the base search are lifted out (they would silently override the enforced window)
 *    and returned so the caller can validate them; time modifiers anywhere else are refused;
 *  - leading-wildcard terms are refused (full scans);
 *  - a base search with no term beyond index/sourcetype/source/host must aggregate or bound itself.
 */
export function validateInvestigationSpl(raw: string): ValidatedSpl {
  let spl = checkSpl(raw);
  const generating = spl.startsWith("|");
  let [base, rest] = splitBase(spl);
  let earliest: string | undefined;
  let latest: string | undefined;
  if (!generating) {
    base = base.replace(
      /\b(earliest|latest)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi,
      (_all, k: string, v: string) => {
        if (k.toLowerCase() === "earliest") earliest = v.replace(/^["']|["']$/g, "");
        else latest = v.replace(/^["']|["']$/g, "");
        return " ";
      },
    );
  }
  if (
    /\b(earliest|latest|_index_earliest|_index_latest|starttime|endtime|starttimeu|endtimeu)\s*=/i.test(
      base + rest,
    )
  )
    throw new Error(
      "time modifiers are only allowed in the base search (earliest=/latest=) or as the tool's earliest/latest arguments",
    );
  const indexes = [...(base + rest).matchAll(/\bindex\s*(?:=|::)\s*"?([^\s"|\])]+)"?/gi)].map(
    (m) => m[1],
  );
  if (!indexes.length) throw new Error("name the index explicitly (index=<name>)");
  const wild = indexes.filter((i) => i.includes("*"));
  if (wild.length)
    throw new Error(`wildcard indexes are not allowed (${wild.join(", ")}); name the index`);
  if (/(^|[\s=("])\*[\w.-]/.test(base))
    throw new Error(
      "leading-wildcard terms (*abc) scan every event; search an exact identifier instead",
    );
  if (!generating) {
    const terms = base
      .replace(/^search\b/i, "")
      .replace(/\b(index|sourcetype|source|host)\s*(?:=|::)\s*("[^"]*"|\S+)/gi, " ")
      .replace(/\b(AND|OR|NOT)\b|[()]/g, " ")
      .trim();
    if ((!terms || terms === "*") && !AGGREGATING.test(rest))
      throw new Error(
        "unbounded search: add an identifier (order code, shipment id, request id …) or aggregate with stats/timechart/head",
      );
  }
  spl = (base.replace(/\s+/g, " ").trim() + (rest ? " " + rest.trim() : "")).trim();
  return { spl, indexes: [...new Set(indexes.map((i) => i.toLowerCase()))], earliest, latest };
}

// ---------------------------------------------------------------- transport: job / oneshot / export

export interface SearchProgress {
  /** Splunk dispatch state: QUEUED, PARSING, RUNNING, FINALIZING, DONE */
  state: string;
  /** 0–100 */
  pct: number;
  /** events read from the index so far */
  scanned: number;
  /** events matching the search so far */
  matched: number;
}

async function searchJob(
  a: Auth,
  params: Record<string, string>,
  count: number,
  timeout: number,
  onProgress: (p: SearchProgress) => void,
) {
  const job = await call(
    "POST",
    "/services/search/jobs",
    a,
    { ...params, exec_mode: "normal" },
    30,
  );
  const sid = job?.sid;
  if (!sid) throw new Error("Splunk không trả về search id");
  const path = `/services/search/jobs/${encodeURIComponent(sid)}`;
  const deadline = Date.now() + (timeout + Math.min(30, timeout)) * 1000;
  let messages: any[] = [];
  for (;;) {
    const c =
      (await call("GET", `${path}?output_mode=json`, a, undefined, 30))?.entry?.[0]?.content ?? {};
    const state = String(c.dispatchState ?? "QUEUED");
    const done = c.isDone === true || c.isDone === "1" || state === "DONE";
    onProgress({
      state,
      pct: done ? 100 : Math.max(0, Math.min(99, Math.round(Number(c.doneProgress ?? 0) * 100))),
      scanned: Number(c.scanCount ?? 0),
      matched: Number(c.eventCount ?? 0),
    });
    messages = Array.isArray(c.messages) ? c.messages : [];
    if (state === "FAILED")
      throw new Error(
        `Splunk search lỗi: ${messages.map((m: any) => m.text ?? m).join("; ") || "FAILED"}`,
      );
    if (done) break;
    if (Date.now() > deadline) {
      await call("POST", `${path}/control`, a, { action: "cancel" }, 15).catch(() => {});
      throw new Error(`Splunk search quá ${timeout}s, đã huỷ`);
    }
    await new Promise((r) => setTimeout(r, Number(process.env.SPLUNK_POLL_MS ?? 1500)));
  }
  const res = await call(
    "GET",
    `${path}/results?output_mode=json&count=${count}&offset=0`,
    a,
    undefined,
    60,
  );
  return {
    sid: String(sid),
    results: res?.results ?? [],
    messages: [...(res?.messages ?? []), ...messages.filter((m: any) => m?.type && m?.text)],
  };
}

/** Streaming export (results arrive as JSON lines). v2 endpoint first, v1 on 404 (older Splunk). */
async function exportSearch(
  a: Auth,
  params: Record<string, string>,
  count: number,
  timeout: number,
) {
  const form = { ...params, search: `${params.search} | head ${count + 1}`, output_mode: "json" };
  let text: string;
  try {
    text = await call("POST", "/services/search/v2/jobs/export", a, form, timeout, true);
  } catch (e) {
    if ((e as any).status !== 404) throw e;
    text = await call("POST", "/services/search/jobs/export", a, form, timeout, true);
  }
  const results: any[] = [];
  const messages: any[] = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.preview === true) continue;
    if (j.result) results.push(j.result);
    if (Array.isArray(j.messages)) messages.push(...j.messages);
  }
  return { sid: null, results, messages };
}

let active = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= Math.max(1, config.splunk.concurrency))
    await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

// ---------------------------------------------------------------- legacy relative search (splunk.search, error scan)

export interface SplunkQuery {
  query: string;
  since_minutes?: number;
  until_minutes?: number;
  max_results?: number;
  /** platform-internal (scheduled scans); agents use the configured limit */
  timeout_seconds?: number;
}

async function auditOnly(row: {
  query: string;
  earliest: number;
  latest: number;
  mode: string;
  auth: string;
  status: string;
  count?: number;
  ms: number;
  error?: string;
  sid?: string | null;
}) {
  try {
    const uid = await actorId();
    await q(
      pool,
      `INSERT INTO splunk_searches (user_id, query, query_hash, earliest, latest, mode, status, auth, sid, result_count, duration_ms, error, finished_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0), $6, $7, $8, $9, $10, $11, $12, now())`,
      [
        uid,
        row.query,
        hashOf(row.query, row.earliest, row.latest, 0),
        row.earliest,
        row.latest,
        row.mode,
        row.status,
        authLabel(row.auth),
        row.sid ?? null,
        row.count ?? null,
        row.ms,
        row.error ?? null,
      ],
    );
  } catch {} // auditing must never break a search
}

const authLabel = (k: string) =>
  k === "session" || k === "token" || k === "shared_token" || k === "manual" ? k : "session";

/**
 * Without `onProgress`: one blocking "oneshot" request (agent tool). With it: an asynchronous job polled for progress
 * (done %, events scanned), cancelled if it outlives the timeout — used by the long production error scan.
 */
export async function splunkSearch(q: SplunkQuery, onProgress?: (p: SearchProgress) => void) {
  await loadShared();
  const lg = activeLogin();
  if (!lg)
    throw new Error(
      login.current
        ? "phiên Splunk hết hạn — người dùng cần dán cookie mới ở trang Integrations"
        : "chưa kết nối Splunk — người dùng dán cookie ở trang Integrations",
    );
  const spl = checkSpl(q.query);
  const since = Math.min(q.since_minutes ?? 60, config.splunk.maxMinutes);
  const until = Math.max(0, Math.min(q.until_minutes ?? 0, since - 1));
  const count = Math.min(q.max_results ?? 100, config.splunk.maxResults);
  const timeout = q.timeout_seconds ?? config.splunk.timeoutSeconds;
  const params = {
    search: spl,
    earliest_time: `-${Math.round(since)}m`,
    latest_time: until ? `-${Math.round(until)}m` : "now",
    output_mode: "json",
    max_time: String(timeout),
  };
  const t0 = Date.now();
  const window = { earliest: t0 - since * 60_000, latest: t0 - until * 60_000 };
  let j: any;
  try {
    j = await withSlot(() =>
      onProgress
        ? searchJob(lg.auth, params, count, timeout, onProgress)
        : call(
            "POST",
            "/services/search/jobs",
            lg.auth,
            { ...params, exec_mode: "oneshot", count: String(count) },
            timeout,
          ),
    );
  } catch (e) {
    await auditOnly({
      query: spl,
      ...window,
      mode: onProgress ? "job" : "oneshot",
      auth: lg.auth.kind,
      status: "failed",
      ms: Date.now() - t0,
      error: (e as Error).message,
    });
    throw e;
  }
  lg.checkedAt = Date.now();
  const rows: any[] = j?.results ?? [];
  const mask = (v: unknown): unknown =>
    typeof v === "string" ? redactPii(v) : Array.isArray(v) ? v.map(mask) : v;
  const results = rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k.startsWith("_") && !["_time", "_raw"].includes(k)) continue; // _cd, _bkt, _si, _serial…
      out[k] = mask(v);
    }
    return out;
  });
  await auditOnly({
    query: spl,
    ...window,
    mode: onProgress ? "job" : "oneshot",
    auth: lg.auth.kind,
    status: "done",
    count: results.length,
    ms: Date.now() - t0,
    sid: j?.sid ?? null,
  });
  const messages = (j?.messages ?? []).map((m: any) => `${m.type}: ${m.text}`);
  return {
    query: spl,
    window: { earliest: `-${since}m`, latest: until ? `-${until}m` : "now" },
    count: results.length,
    truncated: results.length >= count,
    ...(messages.length ? { messages } : {}),
    results,
  };
}

// ---------------------------------------------------------------- investigation search (absolute window, evidence store)

export interface InvestigationSearchArgs {
  query: string;
  /** Absolute (ISO, or Splunk 11/10/2026:08:35:00 in the investigation timezone) or relative (-15m). */
  earliest?: string;
  latest?: string;
  max_results?: number;
  /** job (default; paginates through the Splunk job) or export (streaming, single pass). */
  mode?: "job" | "export";
  page_size?: number;
}

export interface SearchScope {
  runId?: number | null;
  stepKey?: string | null;
}

interface SearchRow {
  id: number;
  user_id: number;
  run_id: number | null;
  step_key: string | null;
  query: string;
  query_hash: string;
  earliest: Date;
  latest: Date;
  mode: string;
  status: string;
  auth: string;
  sid: string | null;
  result_count: number | null;
  truncated: boolean;
  duration_ms: number | null;
  error: string | null;
  events: LogEvent[];
  messages: string[];
  created_at: Date;
  finished_at: Date | null;
}

function hashOf(spl: string, earliest: number, latest: number, count: number) {
  return createHash("sha256")
    .update(
      `${spl}\u0000${Math.floor(earliest / 1000)}\u0000${Math.floor(latest / 1000)}\u0000${count}`,
    )
    .digest("hex")
    .slice(0, 32);
}

/** Resolve and bound the search window. Tool arguments win over inline earliest/latest in the SPL. */
export function resolveWindow(
  v: { earliest?: string; latest?: string },
  args: { earliest?: string; latest?: string },
  now = Date.now(),
) {
  const tz = config.splunk.timezone;
  const e = args.earliest ?? v.earliest;
  const l = args.latest ?? v.latest;
  if (!e)
    throw new Error(
      'a time range is required: pass earliest (and latest), e.g. earliest="2026-11-10T08:35:00+07:00"',
    );
  const earliest = parseTimeModifier(e, tz, now);
  let latest = l ? parseTimeModifier(l, tz, now) : now;
  if (latest > now) latest = now;
  if (!(earliest < latest))
    throw new Error(
      `empty time range: earliest ${formatInZone(earliest * 1000, tz, "s")} is not before latest ${formatInZone(latest * 1000, tz, "s")}`,
    );
  if (latest - earliest > config.splunk.maxMinutes * 60_000)
    throw new Error(
      `time range ${Math.round((latest - earliest) / 60_000)} min exceeds the ${config.splunk.maxMinutes} min limit; narrow it`,
    );
  return { earliest, latest };
}

/** Direct Splunk Web link that reproduces a search (no network; the viewer needs their own Splunk access). */
export function buildSearchUrl(query: string, earliestMs: number, latestMs: number) {
  const spl = query.startsWith("search ") ? query.slice(7) : query;
  const u = new URL(
    `${config.splunk.baseUrl.replace(/\/$/, "")}/${config.splunk.locale}/app/search/search`,
  );
  u.searchParams.set("q", query.startsWith("|") ? query : `search ${spl}`);
  u.searchParams.set("earliest", String(Math.floor(earliestMs / 1000)));
  u.searchParams.set("latest", String(Math.ceil(latestMs / 1000)));
  return u.toString();
}

function view(row: SearchRow, extra: Record<string, unknown> = {}, pageSize = 50) {
  const tz = config.splunk.timezone;
  const e = row.earliest.getTime();
  const l = row.latest.getTime();
  const events = (row.events ?? []).slice(0, pageSize).map((x) => compactEvent(x));
  return {
    search_id: row.id,
    status: row.status,
    ...extra,
    query: row.query,
    window: {
      earliest: formatInZone(e * 1000, tz, "s"),
      latest: formatInZone(l * 1000, tz, "s"),
      timezone: tz,
    },
    environment: row.mode === "argocd" ? "qc" : config.splunk.environment,
    mode: row.mode,
    result_count: row.result_count,
    truncated: row.truncated,
    duration_ms: row.duration_ms,
    ...(row.error ? { error: row.error } : {}),
    ...(row.messages?.length ? { messages: row.messages } : {}),
    ...(row.mode === "argocd" ? {} : { splunk_url: buildSearchUrl(row.query, e, l) }),
    events,
    ...((row.events?.length ?? 0) > pageSize || row.truncated
      ? {
          next_offset: Math.min(pageSize, row.events.length),
          note: "more results: splunk_get_search_results with offset",
        }
      : {}),
  };
}

const selectRow = "SELECT * FROM splunk_searches";

/** Only the run's own searches, or the actor's own searches outside a run. Unknown and foreign rows look the same. */
async function authorizedRow(searchId: number, scope: SearchScope): Promise<SearchRow> {
  const row = await one<SearchRow>(pool, `${selectRow} WHERE id = $1`, [searchId]);
  const uid = currentUserId() ?? (process.env.PLATFORM_TEST === "1" ? await actorId() : null);
  if (row && scope.runId && row.run_id !== null && Number(row.run_id) !== Number(scope.runId)) {
    // A follow-up run (e.g. the fix of an investigation) may re-read the evidence of the run it was started from,
    // only when both runs have the same owner.
    const linked = await one(
      pool,
      `SELECT 1 FROM workflow_runs f JOIN workflow_runs i ON i.id = $2
        WHERE f.id = $1 AND f.inputs->>'investigation_run_id' = i.id::text AND f.owner_id = i.owner_id`,
      [scope.runId, row.run_id],
    );
    if (linked) return row;
  }
  if (
    !row ||
    !(
      (scope.runId && Number(row.run_id) === Number(scope.runId)) ||
      (!scope.runId && uid && Number(row.user_id) === uid)
    )
  )
    throw new Error(`search ${searchId} not found`);
  return row;
}

function manualView(row: SearchRow) {
  return view(row, {
    manual_required: true,
    instructions:
      "Splunk is not reachable with the developer's credentials. Ask the user (ask_user) to run this SPL in Splunk Web over the given window " +
      `(link in splunk_url) and paste the results (JSON or CSV export with _time and _raw) into the investigation panel for search ${row.id}, then answer. ` +
      "After the answer, call splunk_get_search_results with this search_id. Never invent results.",
  });
}

export async function investigationSearch(args: InvestigationSearchArgs, scope: SearchScope = {}) {
  await loadShared();
  const v = validateInvestigationSpl(args.query);
  const win = resolveWindow(v, args);
  const count = Math.max(1, Math.min(args.max_results ?? 200, config.splunk.maxResults));
  const mode = args.mode ?? "job";
  const hash = hashOf(v.spl, win.earliest, win.latest, count);
  const runId = scope.runId || null;
  if (runId) {
    const prior = await one<SearchRow>(
      pool,
      `${selectRow} WHERE run_id = $1 AND query_hash = $2 AND status <> 'failed' ORDER BY id DESC LIMIT 1`,
      [runId, hash],
    );
    if (prior?.status === "done") return view(prior, { cached: true }, args.page_size);
    if (prior?.status === "manual_pending") return manualView(prior);
  }
  const uid = await actorId();
  const lg = activeLogin();
  if (!lg) {
    if (!runId)
      throw new Error(
        login.current
          ? "Splunk credential expired — paste a new cookie or token on the Integrations page"
          : "Splunk is not connected — paste a session cookie or token on the Integrations page",
      );
    const row = await one<SearchRow>(
      pool,
      `INSERT INTO splunk_searches (user_id, run_id, step_key, query, query_hash, earliest, latest, mode, status, auth)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0), 'manual', 'manual_pending', 'manual') RETURNING *`,
      [uid, runId, scope.stepKey ?? null, v.spl, hash, win.earliest, win.latest],
    );
    return manualView(row!);
  }
  if (runId) {
    const used = await one<{ n: number }>(
      pool,
      "SELECT count(*)::int AS n FROM splunk_searches WHERE run_id = $1 AND mode <> 'manual' AND status IN ('done', 'failed', 'running')",
      [runId],
    );
    if ((used?.n ?? 0) >= config.splunk.queryBudget)
      throw new Error(
        `query budget exhausted: this investigation already ran ${used!.n} Splunk searches (limit ${config.splunk.queryBudget}); work with the evidence collected or report what is missing`,
      );
  }
  const row = await one<SearchRow>(
    pool,
    `INSERT INTO splunk_searches (user_id, run_id, step_key, query, query_hash, earliest, latest, mode, status, auth)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0), $8, 'running', $9) RETURNING *`,
    [
      uid,
      runId,
      scope.stepKey ?? null,
      v.spl,
      hash,
      win.earliest,
      win.latest,
      mode,
      authLabel(lg.auth.kind),
    ],
  );
  const timeout = config.splunk.timeoutSeconds;
  const params = {
    search: v.spl,
    earliest_time: String(win.earliest / 1000),
    latest_time: String(win.latest / 1000),
    output_mode: "json",
    max_time: String(timeout),
  };
  const t0 = Date.now();
  let r: { sid: string | null; results: any[]; messages: any[] };
  try {
    r = await withSlot<{ sid: string | null; results: any[]; messages: any[] }>(() =>
      mode === "export"
        ? exportSearch(lg.auth, params, count, timeout)
        : searchJob(lg.auth, params, count, timeout, () => {}),
    );
  } catch (e) {
    const msg = (e as Error).message;
    await q(
      pool,
      "UPDATE splunk_searches SET status = 'failed', error = $2, duration_ms = $3, finished_at = now() WHERE id = $1",
      [row!.id, msg.slice(0, 1000), Date.now() - t0],
    );
    throw e;
  }
  lg.checkedAt = Date.now();
  const truncated = r.results.length >= count;
  const events = r.results
    .slice(0, count)
    .map((x, i) => normalizeEvent(x, i, row!.id, config.splunk.timezone));
  const messages = r.messages
    .map((m: any) => redactPii(`${m.type ?? "INFO"}: ${m.text ?? m}`))
    .slice(0, 20);
  const done = await one<SearchRow>(
    pool,
    `UPDATE splunk_searches SET status = 'done', sid = $2, result_count = $3, truncated = $4, duration_ms = $5, events = $6, messages = $7, finished_at = now()
      WHERE id = $1 RETURNING *`,
    [row!.id, r.sid, events.length, truncated, Date.now() - t0, json(events), json(messages)],
  );
  return view(
    done!,
    events.length
      ? {}
      : {
          note: "no events matched — widen the window step by step, try another identifier, or check the index/field names found in code",
        },
    args.page_size,
  );
}

/**
 * Store log lines read from another source (QC: Argo CD pod logs) as a search of the run, normalized like Splunk events,
 * so they get evidence refs and flow through correlation, timeline and report. Same dedup and per-run budget.
 */
export async function storeExternalSearch(
  input: {
    source: "argocd";
    query: string;
    earliest: number;
    latest: number;
    rows: Array<Record<string, unknown>>;
    error?: string;
  },
  scope: SearchScope = {},
  pageSize = 50,
) {
  const runId = scope.runId || null;
  const hash = hashOf(input.query, input.earliest, input.latest, input.rows.length);
  if (runId) {
    const prior = await one<SearchRow>(
      pool,
      `${selectRow} WHERE run_id = $1 AND query = $2 AND mode = $3 AND status = 'done' AND finished_at > now() - interval '2 minutes' ORDER BY id DESC LIMIT 1`,
      [runId, input.query, input.source],
    );
    if (prior) return view(prior, { cached: true }, pageSize);
    const used = await one<{ n: number }>(
      pool,
      "SELECT count(*)::int AS n FROM splunk_searches WHERE run_id = $1 AND mode <> 'manual' AND status IN ('done', 'failed', 'running')",
      [runId],
    );
    if ((used?.n ?? 0) >= config.splunk.queryBudget)
      throw new Error(
        `query budget exhausted: this investigation already ran ${used!.n} log searches (limit ${config.splunk.queryBudget}); work with the evidence collected or report what is missing`,
      );
  }
  const row = await one<SearchRow>(
    pool,
    `INSERT INTO splunk_searches (user_id, run_id, step_key, query, query_hash, earliest, latest, mode, status, auth, result_count, events, messages, error, finished_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0), $8, 'done', $8, $9, '[]', $10, $11, now()) RETURNING *`,
    [
      await actorId(),
      runId,
      scope.stepKey ?? null,
      input.query,
      hash,
      input.earliest,
      input.latest,
      input.source,
      input.rows.length,
      json(input.error ? [redactPii(`ERROR: ${input.error}`)] : []),
      input.error ?? null,
    ],
  );
  const events = input.rows.map((x, i) => normalizeEvent(x, i, row!.id, config.splunk.timezone));
  const done = await one<SearchRow>(
    pool,
    "UPDATE splunk_searches SET events = $2 WHERE id = $1 RETURNING *",
    [row!.id, json(events)],
  );
  return view(
    done!,
    events.length
      ? {}
      : {
          note: "no log lines matched — check the app/workload, widen since_minutes or try another identifier",
        },
    pageSize,
  );
}

/** Page through a search's results: stored first, then the Splunk job (when it still exists) for the rest. */
export async function searchResults(
  searchId: number,
  offset = 0,
  count = 50,
  scope: SearchScope = {},
) {
  let row = await authorizedRow(searchId, scope);
  count = Math.max(1, Math.min(count, 200));
  if (row.status === "manual_pending") return manualView(row);
  const need = offset + count;
  if (need > row.events.length && row.truncated && row.sid) {
    const lg = activeLogin();
    if (lg) {
      const fetchCount = Math.min(need - row.events.length, config.splunk.maxResults);
      try {
        const res = await call(
          "GET",
          `/services/search/jobs/${encodeURIComponent(row.sid)}/results?output_mode=json&offset=${row.events.length}&count=${fetchCount}`,
          lg.auth,
          undefined,
          60,
        );
        const more: any[] = res?.results ?? [];
        const events = [
          ...row.events,
          ...more.map((x, i) =>
            normalizeEvent(x, row.events.length + i, row.id, config.splunk.timezone),
          ),
        ];
        row = (await one<SearchRow>(
          pool,
          "UPDATE splunk_searches SET events = $2, result_count = $3, truncated = $4 WHERE id = $1 RETURNING *",
          [row.id, json(events), events.length, more.length >= fetchCount],
        ))!;
      } catch (e) {
        if ((e as any).status === 404)
          row = (await one<SearchRow>(
            pool,
            "UPDATE splunk_searches SET truncated = false, messages = messages || $2::jsonb WHERE id = $1 RETURNING *",
            [
              row.id,
              json([
                "WARN: Splunk job expired; re-run the search with a narrower window for more results",
              ]),
            ],
          ))!;
        else throw e;
      }
    }
  }
  const slice = row.events.slice(offset, offset + count);
  return {
    search_id: row.id,
    status: row.status,
    offset,
    returned: slice.length,
    total_stored: row.events.length,
    has_more: row.events.length > offset + count || row.truncated,
    events: slice.map((x) => compactEvent(x)),
  };
}

export async function searchStatus(searchId: number, scope: SearchScope = {}) {
  const row = await authorizedRow(searchId, scope);
  const base = {
    search_id: row.id,
    status: row.status,
    mode: row.mode,
    result_count: row.result_count,
    truncated: row.truncated,
    duration_ms: row.duration_ms,
    error: row.error,
  };
  if (!row.sid) return base;
  const lg = activeLogin();
  if (!lg) return { ...base, job: "unknown (not connected)" };
  try {
    const c =
      (
        await call(
          "GET",
          `/services/search/jobs/${encodeURIComponent(row.sid)}?output_mode=json`,
          lg.auth,
          undefined,
          20,
        )
      )?.entry?.[0]?.content ?? {};
    return {
      ...base,
      job: {
        state: c.dispatchState ?? null,
        done_progress: Number(c.doneProgress ?? 0),
        event_count: Number(c.eventCount ?? 0),
        result_count: Number(c.resultCount ?? 0),
        scan_count: Number(c.scanCount ?? 0),
        is_done: c.isDone === true || c.isDone === "1",
        ttl: Number(c.ttl ?? 0),
      },
    };
  } catch (e) {
    return {
      ...base,
      job: (e as any).status === 404 ? "expired" : `unavailable: ${(e as Error).message}`,
    };
  }
}

/** One sanitized event in full, by evidence reference (S<search>:<seq>), with its provenance. */
export async function getEvent(ref: string, scope: SearchScope = {}) {
  const m = String(ref).match(/^S(\d+):(\d+)$/);
  if (!m) throw new Error(`invalid event reference "${ref}" (expected S<search id>:<n>)`);
  const row = await authorizedRow(Number(m[1]), scope);
  const e = row.events.find((x) => x.seq === Number(m[2]));
  if (!e) throw new Error(`event ${ref} not found`);
  return {
    event_ref: e.ref,
    timestamp: e.time?.iso ?? null,
    time: e.time,
    index: e.index,
    source: e.source,
    sourcetype: e.sourcetype,
    host: e.host,
    service: e.service,
    ids: e.ids,
    message: e.message,
    raw: e.raw,
    fields: e.fields,
    provenance: {
      search_id: row.id,
      query: row.query,
      earliest: row.earliest,
      latest: row.latest,
      mode: row.mode,
      splunk_url: buildSearchUrl(row.query, row.earliest.getTime(), row.latest.getTime()),
    },
  };
}

/** Every search of a run, with sanitized events, for the evidence panel and the correlation step. */
export async function runSearches(runId: number): Promise<SearchRow[]> {
  return q<SearchRow>(pool, `${selectRow} WHERE run_id = $1 ORDER BY id`, [runId]);
}

/**
 * Manual mode: results the user exported from Splunk Web and pasted. Parsed, capped and sanitized exactly like API
 * results; the raw paste is not stored. Either fills a pending search of the run or records a new user-run SPL.
 */
export async function submitManualResults(
  runId: number,
  input: { search_id?: number; query?: string; earliest?: string; latest?: string; text: string },
) {
  let row: SearchRow | undefined;
  if (input.search_id) {
    row = await authorizedRow(Number(input.search_id), { runId });
    if (row.mode !== "manual")
      throw new Error(
        `search ${row.id} ran against Splunk; manual results only fill manual searches`,
      );
  } else {
    const v = validateInvestigationSpl(String(input.query ?? ""));
    const win = resolveWindow(v, { earliest: input.earliest, latest: input.latest });
    row = (await one<SearchRow>(
      pool,
      `INSERT INTO splunk_searches (user_id, run_id, step_key, query, query_hash, earliest, latest, mode, status, auth)
       VALUES ($1, $2, 'manual', $3, $4, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0), 'manual', 'manual_pending', 'manual') RETURNING *`,
      [
        await actorId(),
        runId,
        v.spl,
        hashOf(v.spl, win.earliest, win.latest, 200),
        win.earliest,
        win.latest,
      ],
    ))!;
  }
  const rows = parsePastedResults(String(input.text ?? ""));
  const cap = config.splunk.maxResults;
  const events = rows
    .slice(0, cap)
    .map((x, i) =>
      normalizeEvent(x as Record<string, unknown>, i, row!.id, config.splunk.timezone),
    );
  const updated = await one<SearchRow>(
    pool,
    `UPDATE splunk_searches SET status = 'done', result_count = $2, truncated = $3, events = $4, messages = $5, finished_at = now() WHERE id = $1 RETURNING *`,
    [
      row.id,
      events.length,
      rows.length > cap,
      json(events),
      json([
        `INFO: ${events.length} result(s) pasted manually${rows.length > cap ? ` (first ${cap} kept)` : ""}`,
      ]),
    ],
  );
  return view(updated!);
}
