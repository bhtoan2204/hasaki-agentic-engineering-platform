import { config } from "../config.ts";
import { currentUserId } from "../auth/execution.ts";
import { one, pool } from "../db/pool.ts";
import { PersonalSession, personalSettings } from "./personal.ts";
import { BlockedDestinationError, HttpError, rateLimit, safeRequest, validateBaseUrl } from "./safeHttp.ts";
import { storeExternalSearch, type SearchScope } from "./splunk.ts";

/**
 * SigNoz (logs, traces, metrics) through the documented v5 Query Range API (`POST /api/v5/query_range`).
 * Each user stores their own base URL and credentials (encrypted in user_secrets); a run uses its owner's. Credentials
 * are either an API key (header `SIGNOZ-API-KEY`) or a user session: an access token sent as `Authorization: Bearer`,
 * renewed with the refresh token through `POST /api/v2/sessions/rotate` when SigNoz answers 401. Rotation returns a new
 * pair, which is stored at once. Only documented request/response shapes are used.
 */

const KIND = "signoz";

type SignozAuth = "api_key" | "session";

interface SignozConfig {
  baseUrl: string;
  /** API key (auth "api_key"). */
  token: string;
  /** Absent in configs saved before sessions were supported: those hold an API key. */
  auth?: SignozAuth;
  accessToken?: string;
  refreshToken?: string;
  enabled: boolean;
  lastOkAt?: string;
  lastError?: string;
}

export type SignozErrorKind =
  | "not_configured"
  | "blocked_destination"
  | "auth_failed"
  | "forbidden"
  | "unsupported_api"
  | "invalid_query"
  | "server_error"
  | "connection_failed"
  | "budget_exhausted";

export class SignozError extends Error {
  readonly kind: SignozErrorKind;
  constructor(kind: SignozErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const session = new PersonalSession<SignozConfig>();

/** Refresh the current actor's SigNoz config (called with the other personal integrations). */
export async function loadSignoz() {
  const raw = await personalSettings.get(KIND);
  try {
    session.current = raw ? (JSON.parse(raw) as SignozConfig) : null;
  } catch {
    session.current = null;
  }
}

const authOf = (c: SignozConfig): SignozAuth => c.auth ?? "api_key";
const hasCredentials = (c: SignozConfig | null | undefined) =>
  !!c && (authOf(c) === "session" ? !!c.accessToken && !!c.refreshToken : !!c.token);

/** Usable for the current actor: configured, enabled and holding credentials. */
export function signozEnabled() {
  const c = session.current;
  return !!c && c.enabled && hasCredentials(c);
}

export function signozStatus() {
  const c = session.current;
  return {
    configured: !!c,
    enabled: !!c?.enabled,
    connected: signozEnabled(),
    base_url: c?.baseUrl ?? null,
    auth: c ? authOf(c) : null,
    token_set: hasCredentials(c),
    last_ok_at: c?.lastOkAt ?? null,
    last_error: c?.lastError ?? null,
  };
}

async function persist(next: SignozConfig | null) {
  await personalSettings.set(KIND, next ? JSON.stringify(next) : "");
  session.current = next;
}

function errorMessage(text: string) {
  try {
    const e = JSON.parse(text)?.error;
    const detail = Array.isArray(e?.errors) ? e.errors.map((x: any) => x?.message).filter(Boolean) : [];
    return [e?.message, ...detail].filter(Boolean).join("; ").slice(0, 600) || null;
  } catch {
    return null;
  }
}

function authHeaders(cfg: SignozConfig): Record<string, string> {
  return authOf(cfg) === "session"
    ? { authorization: `Bearer ${cfg.accessToken ?? ""}` }
    : { "SIGNOZ-API-KEY": cfg.token };
}

async function send(
  cfg: SignozConfig,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  signal?: AbortSignal,
) {
  try {
    await rateLimit(`signoz:${currentUserId() ?? 0}`);
    return await safeRequest(
      {
        url: new URL(cfg.baseUrl + path),
        method,
        headers: {
          ...headers,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        approvedInternalHosts: config.signoz.allowedInternalHosts,
        timeoutMs: config.signoz.timeoutMs,
        maxBytes: config.signoz.maxResponseBytes,
        signal,
      },
      config.signoz.maxRetries,
    );
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e instanceof BlockedDestinationError) throw new SignozError("blocked_destination", e.message);
    if (e instanceof HttpError)
      throw new SignozError("connection_failed", `SigNoz answered ${e.status} (redirect refused): check the base URL`);
    throw new SignozError("connection_failed", `cannot reach SigNoz: ${(e as Error).message}`);
  }
}

// One rotation per refresh token at a time: concurrent 401s share it instead of spending the token twice.
const rotations = new Map<string, Promise<void>>();

/** Exchange the refresh token for a new pair, update `cfg` in place and store it when it is the saved config. */
async function rotateSession(cfg: SignozConfig, signal?: AbortSignal) {
  const refreshToken = cfg.refreshToken ?? "";
  let pending = rotations.get(refreshToken);
  if (!pending) {
    pending = (async () => {
      const res = await send(
        cfg,
        "POST",
        "/api/v2/sessions/rotate",
        authHeaders(cfg),
        { refreshToken },
        signal,
      );
      let data: { accessToken?: unknown; refreshToken?: unknown } | undefined;
      try {
        const json = res.text ? JSON.parse(res.text) : {};
        data = json?.data ?? json;
      } catch {
        data = undefined;
      }
      if (res.status < 200 || res.status >= 300 || typeof data?.accessToken !== "string" || !data.accessToken)
        throw new SignozError(
          "auth_failed",
          `the SigNoz session expired and could not be renewed (${res.status}): sign in to SigNoz and save a new access and refresh token`,
        );
      cfg.accessToken = data.accessToken;
      if (typeof data.refreshToken === "string" && data.refreshToken) cfg.refreshToken = data.refreshToken;
      if (session.current === cfg) await persist(cfg);
    })().finally(() => rotations.delete(refreshToken));
    rotations.set(refreshToken, pending);
  }
  await pending;
}

async function call(cfg: SignozConfig, method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal) {
  const sessionAuth = authOf(cfg) === "session";
  let res = await send(cfg, method, path, authHeaders(cfg), body, signal);
  if (res.status === 401 && sessionAuth) {
    await rotateSession(cfg, signal);
    res = await send(cfg, method, path, authHeaders(cfg), body, signal);
  }
  const detail = errorMessage(res.text);
  if (res.status === 401)
    throw new SignozError(
      "auth_failed",
      sessionAuth ? "the SigNoz session was rejected (401) after renewing it" : "the API key was rejected (401)",
    );
  if (res.status === 403 || /authz_forbidden/.test(res.text))
    throw new SignozError(
      "forbidden",
      sessionAuth
        ? `your SigNoz user lacks permission (403)${detail ? `: ${detail}` : ""}; ask for a read role such as viewer`
        : `the API key's service account lacks permission (403)${detail ? `: ${detail}` : ""}; grant a read role such as signoz-viewer`,
    );
  if (res.status === 404 || res.status === 405)
    throw new SignozError("unsupported_api", `${path} is not available on this SigNoz (${res.status}): v5 query_range is required`);
  if (res.status === 400 || res.status === 422)
    throw new SignozError("invalid_query", detail ?? `SigNoz rejected the query (${res.status})`);
  if (res.status >= 500) throw new SignozError("server_error", detail ?? `SigNoz error ${res.status}`);
  if (res.status < 200 || res.status >= 300)
    throw new SignozError("connection_failed", `unexpected SigNoz status ${res.status}`);
  try {
    return res.text ? JSON.parse(res.text) : {};
  } catch {
    throw new SignozError("server_error", "SigNoz returned a non-JSON response");
  }
}

function current(): SignozConfig {
  const c = session.current;
  if (!c || !hasCredentials(c))
    throw new SignozError("not_configured", "SigNoz is not configured: add your domain and credentials in Integrations");
  if (!c.enabled) throw new SignozError("not_configured", "SigNoz is disabled in your Integrations settings");
  return c;
}

/** Key check (`/api/v1/service_accounts/me`, API keys only) then a one-minute v5 query_range probe. */
async function probe(cfg: SignozConfig, signal?: AbortSignal) {
  const began = Date.now();
  if (authOf(cfg) === "api_key")
    try {
      await call(cfg, "GET", "/api/v1/service_accounts/me", undefined, signal);
    } catch (e) {
      // Versions without the service-account endpoint still answer query_range; only auth failures stop here.
      if (!(e instanceof SignozError) || !["unsupported_api", "server_error"].includes(e.kind)) throw e;
    }
  const end = Date.now();
  await call(cfg, "POST", "/api/v5/query_range", logsAggregate({ start: end - 60_000, end }, {}, [], "count()", 1), signal);
  return { latency_ms: Date.now() - began };
}

export async function testSignoz(signal?: AbortSignal) {
  const c = session.current;
  if (!c || !hasCredentials(c))
    return { ok: false, kind: "not_configured" as const, message: "SigNoz is not configured" };
  try {
    const r = await probe(c, signal);
    await persist({ ...c, lastOkAt: new Date().toISOString(), lastError: undefined });
    return { ok: true, ...r, last_ok_at: session.current?.lastOkAt };
  } catch (e) {
    if (!(e instanceof SignozError)) throw e;
    await persist({ ...c, lastError: e.message });
    return { ok: false, kind: e.kind, message: e.message };
  }
}

const secretInput = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function checkSecret(value: string, what: string, max: number) {
  if (/\s/.test(value) || value.length > max) throw new SignozError("auth_failed", `the ${what} format is invalid`);
}

/**
 * Validate, test (when enabled) and store. An empty credential keeps the stored one for the same auth mode.
 * `auth: "session"` takes an access and a refresh token copied from a signed-in SigNoz browser session.
 */
export async function saveSignoz(input: {
  baseUrl?: unknown;
  auth?: unknown;
  token?: unknown;
  accessToken?: unknown;
  refreshToken?: unknown;
  enabled?: unknown;
}) {
  const prior = session.current;
  let url: URL;
  try {
    url = validateBaseUrl(String(input.baseUrl ?? prior?.baseUrl ?? ""), config.signoz.allowedInternalHosts);
  } catch (e) {
    if (e instanceof BlockedDestinationError) throw new SignozError("blocked_destination", e.message);
    throw e;
  }
  const auth: SignozAuth =
    input.auth === "session" || input.auth === "api_key"
      ? input.auth
      : secretInput(input.accessToken) || secretInput(input.refreshToken)
        ? "session"
        : prior
          ? authOf(prior)
          : "api_key";
  const keep = prior && authOf(prior) === auth ? prior : undefined;
  const baseUrl = (url.origin + url.pathname).replace(/\/+$/, "");
  const enabled = input.enabled === undefined ? (prior?.enabled ?? true) : input.enabled === true;
  let next: SignozConfig;
  if (auth === "session") {
    const accessToken = secretInput(input.accessToken) ?? keep?.accessToken;
    const refreshToken = secretInput(input.refreshToken) ?? keep?.refreshToken;
    if (!accessToken || !refreshToken)
      throw new SignozError("not_configured", "an access token and a refresh token are required");
    checkSecret(accessToken, "access token", 8192);
    checkSecret(refreshToken, "refresh token", 8192);
    next = { baseUrl, auth, token: "", accessToken, refreshToken, enabled };
  } else {
    const token = secretInput(input.token) ?? keep?.token;
    if (!token) throw new SignozError("not_configured", "an API key is required");
    checkSecret(token, "API key", 512);
    next = { baseUrl, auth, token, enabled };
  }
  const sameCredentials =
    !!keep &&
    keep.baseUrl === next.baseUrl &&
    keep.token === next.token &&
    keep.accessToken === next.accessToken &&
    keep.refreshToken === next.refreshToken;
  if (next.enabled) {
    await probe(next);
    next.lastOkAt = new Date().toISOString();
  } else if (sameCredentials) next.lastOkAt = keep!.lastOkAt;
  await persist(next);
  return signozStatus();
}

export async function disconnectSignoz() {
  await persist(null);
  return signozStatus();
}

// ---------------------------------------------------------------- query construction (documented v5 builder shape)

export interface Window {
  start: number;
  end: number;
}

export interface Filters {
  service?: string;
  environment?: string;
  severity?: string;
  operation?: string;
  trace_id?: string;
  span_id?: string;
  has_error?: boolean;
  status_code?: string | number;
  expression?: string;
}

const quote = (v: string | number) => `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** A free filter expression: bounded, single statement, balanced quotes. SigNoz parses and validates it further. */
export function checkExpression(expr: string) {
  const e = expr.trim();
  if (e.length > 1000) throw new SignozError("invalid_query", "filter expression is longer than 1000 characters");
  if (/[;`]/.test(e)) throw new SignozError("invalid_query", "filter expression may not contain ; or backticks");
  const quotes = (e.replace(/\\./g, "").match(/'/g) ?? []).length;
  if (quotes % 2) throw new SignozError("invalid_query", "filter expression has unbalanced quotes");
  return e;
}

export function filterExpression(signal: "logs" | "traces" | "metrics", f: Filters) {
  const parts: string[] = [];
  if (f.service) parts.push(`service.name = ${quote(f.service)}`);
  if (f.environment) parts.push(`deployment.environment = ${quote(f.environment)}`);
  if (f.severity && signal === "logs") parts.push(`severity_text = ${quote(f.severity.toUpperCase())}`);
  if (f.operation && signal === "traces") parts.push(`name = ${quote(f.operation)}`);
  if (f.trace_id) parts.push(`trace_id = ${quote(f.trace_id)}`);
  if (f.span_id) parts.push(`span_id = ${quote(f.span_id)}`);
  if (f.has_error !== undefined && signal === "traces") parts.push(`has_error = ${f.has_error}`);
  if (f.status_code !== undefined && signal === "traces") parts.push(`response_status_code = ${quote(f.status_code)}`);
  if (f.expression?.trim()) parts.push(`(${checkExpression(f.expression)})`);
  return parts.join(" AND ");
}

/** Absolute window in ms: explicit ISO bounds, else the last `since_minutes` (default) — capped at maxMinutes. */
export function resolveWindow(
  input: { since_minutes?: number; earliest?: string; latest?: string },
  defaultMinutes = config.signoz.defaultMinutes,
  now = Date.now(),
): Window {
  const parse = (s: string, name: string) => {
    const t = Date.parse(s);
    if (!Number.isFinite(t)) throw new SignozError("invalid_query", `${name} must be an ISO-8601 time with offset`);
    return t;
  };
  const end = input.latest ? parse(input.latest, "latest") : now;
  let start = input.earliest ? parse(input.earliest, "earliest") : end - (input.since_minutes ?? defaultMinutes) * 60_000;
  if (start >= end) throw new SignozError("invalid_query", "earliest must be before latest");
  start = Math.max(start, end - config.signoz.maxMinutes * 60_000);
  return { start, end };
}

export const clampLimit = (n?: number) =>
  Math.max(1, Math.min(config.signoz.maxLimit, Math.floor(n ?? config.signoz.defaultLimit)));

const groupKey = (name: string) => (name === "service.name" ? { name, fieldContext: "resource" } : { name });

function envelope(w: Window, requestType: "raw" | "scalar" | "time_series", spec: Record<string, unknown>) {
  return {
    start: w.start,
    end: w.end,
    requestType,
    compositeQuery: { queries: [{ type: "builder_query", spec: { name: "A", disabled: false, ...spec } as Record<string, unknown> }] },
  };
}

const withFilter = (expression: string) => (expression ? { filter: { expression } } : {});

export function logsSearch(w: Window, f: Filters, limit?: number, offset = 0) {
  return envelope(w, "raw", {
    signal: "logs",
    ...withFilter(filterExpression("logs", f)),
    order: [{ key: { name: "timestamp" }, direction: "desc" }],
    limit: clampLimit(limit),
    offset,
  });
}

const stepFor = (w: Window) => Math.max(60, Math.ceil((w.end - w.start) / 1000 / 120));

export function logsAggregate(
  w: Window,
  f: Filters,
  groupBy: string[] = [],
  aggregation = "count()",
  limit = 20,
  timeSeries = false,
) {
  if (!/^[a-z_0-9]+\([\w.]*\)$/i.test(aggregation))
    throw new SignozError("invalid_query", "aggregation must look like count(), count_distinct(field), avg(field), p95(field)");
  return envelope(w, timeSeries ? "time_series" : "scalar", {
    signal: "logs",
    stepInterval: stepFor(w),
    aggregations: [{ expression: aggregation, alias: "value" }],
    ...withFilter(filterExpression("logs", f)),
    groupBy: groupBy.map(groupKey),
    order: [{ key: { name: "value" }, direction: "desc" }],
    limit: Math.max(1, Math.min(100, limit)),
  });
}

export function tracesSearch(w: Window, f: Filters, limit?: number, offset = 0, ascending = false) {
  return envelope(w, "raw", {
    signal: "traces",
    ...withFilter(filterExpression("traces", f)),
    order: [{ key: { name: "timestamp" }, direction: ascending ? "asc" : "desc" }],
    limit: clampLimit(limit),
    offset,
  });
}

export const traceById = (w: Window, traceId: string) =>
  tracesSearch(w, { trace_id: traceId }, config.signoz.maxLimit, 0, true);

export function metricsQuery(
  w: Window,
  m: { metric: string; time_aggregation?: string; space_aggregation?: string; group_by?: string[]; step_seconds?: number },
  f: Filters,
) {
  if (!/^[\w.:-]{1,200}$/.test(m.metric)) throw new SignozError("invalid_query", "invalid metric name");
  return envelope(w, "time_series", {
    signal: "metrics",
    stepInterval: Math.max(60, m.step_seconds ?? stepFor(w)),
    aggregations: [
      {
        metricName: m.metric,
        timeAggregation: m.time_aggregation ?? "avg",
        spaceAggregation: m.space_aggregation ?? "sum",
      },
    ],
    ...withFilter(filterExpression("metrics", f)),
    groupBy: (m.group_by ?? []).map(groupKey),
  });
}

export function listServicesQuery(w: Window) {
  return envelope(w, "scalar", {
    signal: "traces",
    aggregations: [{ expression: "count()", alias: "spans" }],
    groupBy: [groupKey("service.name")],
    order: [{ key: { name: "spans" }, direction: "desc" }],
    limit: 200,
  });
}

// ---------------------------------------------------------------- response parsing (documented v5 shapes)

const resultsOf = (json: any): any[] => json?.data?.data?.results ?? json?.data?.results ?? [];

const cut = (v: unknown) => (typeof v === "string" && v.length > 2000 ? `${v.slice(0, 2000)}…` : v);

/** Raw rows with nested attribute maps flattened, deduplicated by id (or timestamp+content). */
export function parseRaw(json: any) {
  const seen = new Set<string>();
  const rows: Array<{ timestamp: string; data: Record<string, unknown> }> = [];
  let nextCursor: string | null = null;
  for (const r of resultsOf(json)) {
    nextCursor ??= r?.nextCursor || null;
    for (const row of r?.rows ?? []) {
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row?.data ?? {})) {
        if (v && typeof v === "object" && !Array.isArray(v))
          for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) data[k2] ??= cut(v2);
        else data[k] = cut(v);
      }
      const key = String(data.id ?? `${row?.timestamp}|${JSON.stringify(data)}`);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ timestamp: String(row?.timestamp ?? ""), data });
    }
  }
  return { rows, nextCursor };
}

export function parseTimeSeries(json: any, maxSeries = 50, maxPoints = 120) {
  const series: Array<{
    labels: Record<string, string>;
    points: Array<[number, number]>;
    stats: { min: number; max: number; avg: number; last: number };
  }> = [];
  let total = 0;
  for (const r of resultsOf(json))
    for (const bucket of r?.aggregations ?? [])
      for (const s of bucket?.series ?? []) {
        total++;
        if (series.length >= maxSeries) continue;
        const labels: Record<string, string> = {};
        for (const l of s?.labels ?? []) labels[String(l?.key?.name ?? l?.key ?? "")] = String(l?.value ?? "");
        const values = (s?.values ?? [])
          .map((v: any) => [Number(v?.timestamp), Number(v?.value)] as [number, number])
          .filter(([t, v]: [number, number]) => Number.isFinite(t) && Number.isFinite(v));
        if (!values.length) continue;
        const nums = values.map((v: [number, number]) => v[1]);
        const step = Math.ceil(values.length / maxPoints);
        series.push({
          labels,
          points: values.filter((_: unknown, i: number) => i % step === 0),
          stats: {
            min: Math.min(...nums),
            max: Math.max(...nums),
            avg: nums.reduce((a: number, b: number) => a + b, 0) / nums.length,
            last: nums[nums.length - 1],
          },
        });
      }
  return { series, total_series: total, truncated: total > series.length };
}

export function parseScalar(json: any, maxRows = 200) {
  const r = resultsOf(json)[0] ?? {};
  const columns: string[] = (r.columns ?? []).map((c: any) => String(c?.name ?? ""));
  const data: unknown[][] = r.data ?? [];
  return { columns, rows: data.slice(0, maxRows), total_rows: data.length, truncated: data.length > maxRows };
}

const EMPTY = "no telemetry returned for this query and window — absence of data is not evidence that the service is healthy";

// ---------------------------------------------------------------- budgeted, recorded calls (one row per call)

async function checkBudget(scope: SearchScope) {
  if (!scope.runId) return;
  const used = await one<{ run: number; step: number }>(
    pool,
    `SELECT count(*) FILTER (WHERE mode <> 'manual')::int AS run,
            count(*) FILTER (WHERE mode = 'signoz' AND step_key IS NOT DISTINCT FROM $2)::int AS step
       FROM splunk_searches WHERE run_id = $1`,
    [scope.runId, scope.stepKey ?? null],
  );
  if ((used?.run ?? 0) >= config.splunk.queryBudget)
    throw new SignozError("budget_exhausted", `query budget exhausted: this run already ran ${used!.run} log/telemetry queries (limit ${config.splunk.queryBudget})`);
  if ((used?.step ?? 0) >= config.signoz.maxCallsPerStep)
    throw new SignozError("budget_exhausted", `this step already made ${used!.step} SigNoz calls (limit ${config.signoz.maxCallsPerStep}); narrow with the evidence collected`);
}

const describe = (body: ReturnType<typeof envelope>) =>
  `signoz ${body.requestType} ${JSON.stringify(body.compositeQuery.queries[0].spec)}`.slice(0, 4000);

async function run(body: ReturnType<typeof envelope>, scope: SearchScope, signal?: AbortSignal) {
  const cfg = current();
  await checkBudget(scope);
  return call(cfg, "POST", "/api/v5/query_range", body, signal);
}

const record = (body: ReturnType<typeof envelope>, rows: Array<Record<string, unknown>>, scope: SearchScope, note?: string) =>
  storeExternalSearch(
    { source: "signoz", query: describe(body), earliest: body.start, latest: body.end, rows, note },
    scope,
  );

function toEvent(row: { timestamp: string; data: Record<string, unknown> }, signal: "logs" | "traces") {
  const d = row.data;
  const durationMs = d.duration_nano != null ? Math.round(Number(d.duration_nano) / 1e6) : null;
  const message =
    signal === "logs"
      ? d.body
      : `${d.name ?? "span"}${durationMs != null ? ` ${durationMs}ms` : ""}${d.response_status_code ? ` status=${d.response_status_code}` : ""}${d.has_error === true || d.has_error === "true" ? " ERROR" : ""}`;
  return {
    ...d,
    _time: row.timestamp,
    _raw: JSON.stringify(d),
    message,
    service: d["service.name"],
    severity: d.severity_text,
    duration_ms: durationMs,
  };
}

async function rawQuery(body: ReturnType<typeof envelope>, signal: "logs" | "traces", scope: SearchScope, abort?: AbortSignal) {
  const json = await run(body, scope, abort);
  const { rows, nextCursor } = parseRaw(json);
  const spec = body.compositeQuery.queries[0].spec as { limit: number; offset: number };
  const stored = await record(body, rows.map((r) => toEvent(r, signal)), scope, rows.length ? undefined : EMPTY);
  return {
    provider: "signoz",
    signal,
    ...stored,
    ...(rows.length >= spec.limit || nextCursor ? { next_offset: spec.offset + rows.length } : {}),
  };
}

export const searchLogs = (
  a: Filters & { since_minutes?: number; earliest?: string; latest?: string; limit?: number; offset?: number },
  scope: SearchScope,
) => rawQuery(logsSearch(resolveWindow(a), a, a.limit, a.offset ?? 0), "logs", scope);

export const searchTraces = (
  a: Filters & { since_minutes?: number; earliest?: string; latest?: string; limit?: number; offset?: number },
  scope: SearchScope,
) => rawQuery(tracesSearch(resolveWindow(a), a, a.limit, a.offset ?? 0), "traces", scope);

export const getTrace = (a: { trace_id: string; since_minutes?: number; earliest?: string; latest?: string }, scope: SearchScope) =>
  rawQuery(traceById(resolveWindow(a, 24 * 60), a.trace_id), "traces", scope);

async function inline(body: ReturnType<typeof envelope>, scope: SearchScope, parse: (json: any) => { empty: boolean } & Record<string, unknown>) {
  const json = await run(body, scope);
  const parsed = parse(json);
  const stored = await record(body, [], scope, parsed.empty ? EMPTY : "aggregate result returned inline");
  return {
    provider: "signoz",
    search_id: stored.search_id,
    query: body.compositeQuery.queries[0].spec,
    window: stored.window,
    ...parsed,
    ...(parsed.empty ? { note: EMPTY } : {}),
  };
}

export const aggregateLogs = (
  a: Filters & { since_minutes?: number; earliest?: string; latest?: string; group_by?: string[]; aggregation?: string; limit?: number; time_series?: boolean },
  scope: SearchScope,
) =>
  inline(logsAggregate(resolveWindow(a), a, a.group_by, a.aggregation, a.limit, a.time_series), scope, (json) => {
    if (a.time_series) {
      const t = parseTimeSeries(json);
      return { ...t, empty: !t.series.length };
    }
    const s = parseScalar(json);
    return { ...s, empty: !s.rows.length };
  });

export const queryMetrics = (
  a: Filters & { metric: string; time_aggregation?: string; space_aggregation?: string; group_by?: string[]; step_seconds?: number; since_minutes?: number; earliest?: string; latest?: string },
  scope: SearchScope,
) =>
  inline(metricsQuery(resolveWindow(a), a, a), scope, (json) => {
    const t = parseTimeSeries(json);
    return { ...t, empty: !t.series.length };
  });

export const listServices = (a: { since_minutes?: number; earliest?: string; latest?: string }, scope: SearchScope) =>
  inline(listServicesQuery(resolveWindow(a, 60)), scope, (json) => {
    const s = parseScalar(json);
    return {
      services: s.rows.map((r) => ({ service: String(r[0] ?? ""), spans: Number(r[1] ?? 0) })),
      truncated: s.truncated,
      empty: !s.rows.length,
    };
  });

// ---------------------------------------------------------------- production error scan (platform-run, no agent budget)

/** Kubernetes attribute names of the usual log pipelines: OpenTelemetry collector first, then fluentd / fluent-bit. */
export const K8S_LOG_KEYS = {
  namespace: [
    "k8s.namespace.name",
    "kubernetes.namespace_name",
    "kubernetes_namespace_name",
    "k8s_namespace_name",
    "deployment.environment",
    "namespace",
  ],
  container: ["k8s.container.name", "kubernetes.container_name", "kubernetes_container_name", "container_name"],
  pod: ["k8s.pod.name", "kubernetes.pod_name", "kubernetes_pod_name", "pod_name"],
  image: ["container.image.name", "k8s.container.image", "kubernetes.container_image", "kubernetes_container_image"],
};

const keyMissing = (e: unknown) =>
  e instanceof SignozError && e.kind === "invalid_query" && /key `[^`]*` not found/i.test(e.message);
const namespaceKeys = new Map<string, string>();
const anyOf = (key: string, values: string[]) => `(${values.map((v) => `${key} = ${quote(v)}`).join(" OR ")})`;

/**
 * The attribute holding the Kubernetes namespace in this SigNoz: configured, remembered per instance, else the first
 * candidate that has logs of these namespaces in the window (a key can exist and hold other values, such as
 * deployment.environment = "prod"). Unknown keys are answered "key not found" and skipped.
 */
async function namespaceKey(cfg: SignozConfig, w: Window, namespaces: string[], signal?: AbortSignal) {
  if (config.signoz.namespaceKey) return config.signoz.namespaceKey;
  const known = namespaceKeys.get(cfg.baseUrl);
  if (known) return known;
  let accepted: string | null = null;
  for (const key of K8S_LOG_KEYS.namespace) {
    const probe = envelope(w, "scalar", {
      signal: "logs",
      aggregations: [{ expression: "count()", alias: "value" }],
      filter: { expression: anyOf(key, namespaces) },
      limit: 1,
    });
    let count = 0;
    try {
      const row = parseScalar(await call(cfg, "POST", "/api/v5/query_range", probe, signal)).rows[0];
      count = Number(row?.at(-1) ?? 0) || 0;
    } catch (e) {
      if (keyMissing(e)) continue;
      throw e;
    }
    accepted ??= key;
    if (count > 0) {
      namespaceKeys.set(cfg.baseUrl, key);
      return key;
    }
  }
  if (accepted) return accepted;
  throw new SignozError(
    "invalid_query",
    `SigNoz logs have none of the namespace attributes ${K8S_LOG_KEYS.namespace.join(", ")}; set signoz.namespaceKey in config`,
  );
}

/** Error-level logs of the given Kubernetes namespaces in one window (ms), newest first, at most `maxRows`. */
export async function signozErrorLogs(
  w: Window,
  namespaces: string[],
  levels: string[],
  maxRows = 2000,
  signal?: AbortSignal,
) {
  const cfg = current();
  const nsKey = namespaces.length ? await namespaceKey(cfg, w, namespaces, signal) : null;
  const expression = [anyOf("severity_text", levels), ...(nsKey ? [anyOf(nsKey, namespaces)] : [])].join(" AND ");
  const page = Math.min(200, config.signoz.maxLimit);
  const rows: Array<{ timestamp: string; data: Record<string, unknown> }> = [];
  for (let offset = 0; offset < maxRows; offset += page) {
    const body = envelope(w, "raw", {
      signal: "logs",
      filter: { expression },
      order: [{ key: { name: "timestamp" }, direction: "desc" }],
      limit: Math.min(page, maxRows - offset),
      offset,
    });
    const batch = parseRaw(await call(cfg, "POST", "/api/v5/query_range", body, signal)).rows;
    rows.push(...batch);
    if (batch.length < Math.min(page, maxRows - offset)) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}
