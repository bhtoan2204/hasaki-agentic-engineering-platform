import { config } from "../config.ts";
import { currentUserId } from "../auth/execution.ts";
import { one, pool } from "../db/pool.ts";
import { getUserSecret } from "../auth/secrets.ts";
import { PersonalSession, personalSettings } from "./personal.ts";
import {
  BlockedDestinationError,
  HttpError,
  rateLimit,
  safeRequest,
  validateBaseUrl,
} from "./safeHttp.ts";
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
  | "rate_limited"
  | "budget_exhausted";

export class SignozError extends Error {
  readonly kind: SignozErrorKind;
  /** For `rate_limited`: the provider's Retry-After, when it sent one. */
  readonly retryAfterMs?: number;
  constructor(kind: SignozErrorKind, message: string, retryAfterMs?: number) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
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

export const SIGNOZ_SECRET_KIND = KIND;

/** Whether a decrypted SigNoz JSON config is enabled and carries credentials. */
export function isSignozConfigUsable(raw: string | null): boolean {
  try {
    const c = raw ? (JSON.parse(raw) as SignozConfig) : null;
    return !!c && c.enabled && hasCredentials(c);
  } catch {
    return false;
  }
}

/** Whether `userId` has a usable SigNoz connection saved, read from storage without contacting SigNoz. */
export async function signozConfiguredFor(userId: number) {
  return isSignozConfigUsable(await getUserSecret(userId, KIND));
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
    const detail = Array.isArray(e?.errors)
      ? e.errors.map((x: { message?: string } | null) => x?.message).filter(Boolean)
      : [];
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
    if (e instanceof BlockedDestinationError)
      throw new SignozError("blocked_destination", e.message);
    if (e instanceof HttpError)
      throw new SignozError(
        "connection_failed",
        `SigNoz answered ${e.status} (redirect refused): check the base URL`,
      );
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
      if (
        res.status < 200 ||
        res.status >= 300 ||
        typeof data?.accessToken !== "string" ||
        !data.accessToken
      )
        throw new SignozError(
          "auth_failed",
          `the SigNoz session expired and could not be renewed (${res.status}): sign in to SigNoz and save a new access and refresh token`,
        );
      cfg.accessToken = data.accessToken;
      if (typeof data.refreshToken === "string" && data.refreshToken)
        cfg.refreshToken = data.refreshToken;
      if (session.current === cfg) await persist(cfg);
    })().finally(() => rotations.delete(refreshToken));
    rotations.set(refreshToken, pending);
  }
  await pending;
}

async function call(
  cfg: SignozConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) {
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
      sessionAuth
        ? "the SigNoz session was rejected (401) after renewing it"
        : "the API key was rejected (401)",
    );
  if (res.status === 403 || /authz_forbidden/.test(res.text))
    throw new SignozError(
      "forbidden",
      sessionAuth
        ? `your SigNoz user lacks permission (403)${detail ? `: ${detail}` : ""}; ask for a read role such as viewer`
        : `the API key's service account lacks permission (403)${detail ? `: ${detail}` : ""}; grant a read role such as signoz-viewer`,
    );
  if (res.status === 404 || res.status === 405)
    throw new SignozError(
      "unsupported_api",
      `${path} is not available on this SigNoz (${res.status}): v5 query_range is required`,
    );
  if (res.status === 400 || res.status === 422)
    throw new SignozError("invalid_query", detail ?? `SigNoz rejected the query (${res.status})`);
  if (res.status === 429)
    throw new SignozError(
      "rate_limited",
      "SigNoz is rate limiting requests (429)",
      res.retryAfterMs,
    );
  if (res.status >= 500)
    throw new SignozError("server_error", detail ?? `SigNoz error ${res.status}`);
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
    throw new SignozError(
      "not_configured",
      "SigNoz is not configured: add your domain and credentials in Integrations",
    );
  if (!c.enabled)
    throw new SignozError("not_configured", "SigNoz is disabled in your Integrations settings");
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
      if (!(e instanceof SignozError) || !["unsupported_api", "server_error"].includes(e.kind))
        throw e;
    }
  const end = Date.now();
  await call(
    cfg,
    "POST",
    "/api/v5/query_range",
    logsAggregate({ start: end - 60_000, end }, {}, [], "count()", 1),
    signal,
  );
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
  if (/\s/.test(value) || value.length > max)
    throw new SignozError("auth_failed", `the ${what} format is invalid`);
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
    url = validateBaseUrl(
      String(input.baseUrl ?? prior?.baseUrl ?? ""),
      config.signoz.allowedInternalHosts,
    );
  } catch (e) {
    if (e instanceof BlockedDestinationError)
      throw new SignozError("blocked_destination", e.message);
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
  /** Matched against every span attribute that holds a request id (discovered per SigNoz instance). */
  request_id?: string;
  has_error?: boolean;
  status_code?: string | number;
  expression?: string;
}

const quote = (v: string | number) => `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** A free filter expression: bounded, single statement, balanced quotes. SigNoz parses and validates it further. */
export function checkExpression(expr: string) {
  const e = expr.trim();
  if (e.length > 1000)
    throw new SignozError("invalid_query", "filter expression is longer than 1000 characters");
  if (/[;`]/.test(e))
    throw new SignozError("invalid_query", "filter expression may not contain ; or backticks");
  const quotes = (e.replace(/\\./g, "").match(/'/g) ?? []).length;
  if (quotes % 2) throw new SignozError("invalid_query", "filter expression has unbalanced quotes");
  return e;
}

export function filterExpression(
  signal: "logs" | "traces" | "metrics",
  f: Filters,
  requestIdKeys: string[] = [],
) {
  const parts: string[] = [];
  if (f.service) parts.push(`service.name = ${quote(f.service)}`);
  if (f.environment) parts.push(`deployment.environment = ${quote(f.environment)}`);
  if (f.severity && signal === "logs")
    parts.push(`severity_text = ${quote(f.severity.toUpperCase())}`);
  if (f.operation && signal === "traces") parts.push(`name = ${quote(f.operation)}`);
  if (f.trace_id) parts.push(`trace_id = ${quote(f.trace_id)}`);
  if (f.span_id) parts.push(`span_id = ${quote(f.span_id)}`);
  if (f.request_id) {
    if (!requestIdKeys.length)
      throw new SignozError(
        "invalid_query",
        "no request id attribute is recorded on spans in this SigNoz",
      );
    parts.push(`(${requestIdKeys.map((k) => `${k} = ${quote(f.request_id!)}`).join(" OR ")})`);
  }
  if (f.has_error !== undefined && signal === "traces") parts.push(`has_error = ${f.has_error}`);
  if (f.status_code !== undefined && signal === "traces")
    parts.push(`response_status_code = ${quote(f.status_code)}`);
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
    if (!Number.isFinite(t))
      throw new SignozError("invalid_query", `${name} must be an ISO-8601 time with offset`);
    return t;
  };
  const end = input.latest ? parse(input.latest, "latest") : now;
  let start = input.earliest
    ? parse(input.earliest, "earliest")
    : end - (input.since_minutes ?? defaultMinutes) * 60_000;
  if (start >= end) throw new SignozError("invalid_query", "earliest must be before latest");
  start = Math.max(start, end - config.signoz.maxMinutes * 60_000);
  return { start, end };
}

export const clampLimit = (n?: number) =>
  Math.max(1, Math.min(config.signoz.maxLimit, Math.floor(n ?? config.signoz.defaultLimit)));

const groupKey = (name: string) =>
  name === "service.name" ? { name, fieldContext: "resource" } : { name };

function envelope(
  w: Window,
  requestType: "raw" | "scalar" | "time_series",
  spec: Record<string, unknown>,
) {
  return {
    start: w.start,
    end: w.end,
    requestType,
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: { name: "A", disabled: false, ...spec } as Record<string, unknown>,
        },
      ],
    },
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
    throw new SignozError(
      "invalid_query",
      "aggregation must look like count(), count_distinct(field), avg(field), p95(field)",
    );
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

/** Span fields an investigation needs: the defaults lack parent_span_id, has_error and status_message. */
export const TRACE_FIELDS = [
  "span_id",
  "parent_span_id",
  "name",
  "duration_nano",
  "service.name",
  "response_status_code",
  "has_error",
  "status_message",
];

export function tracesSearch(
  w: Window,
  f: Filters,
  limit?: number,
  offset = 0,
  ascending = false,
  requestIdKeys: string[] = [],
) {
  return envelope(w, "raw", {
    signal: "traces",
    selectFields: [...TRACE_FIELDS, ...requestIdKeys].map((name) => ({ name })),
    ...withFilter(filterExpression("traces", f, requestIdKeys)),
    order: [{ key: { name: "timestamp" }, direction: ascending ? "asc" : "desc" }],
    limit: clampLimit(limit),
    offset,
  });
}

export const traceById = (w: Window, traceId: string, requestIdKeys: string[] = []) =>
  tracesSearch(w, { trace_id: traceId }, config.signoz.maxLimit, 0, true, requestIdKeys);

export function metricsQuery(
  w: Window,
  m: {
    metric: string;
    time_aggregation?: string;
    space_aggregation?: string;
    group_by?: string[];
    step_seconds?: number;
  },
  f: Filters,
) {
  if (!/^[\w.:-]{1,200}$/.test(m.metric))
    throw new SignozError("invalid_query", "invalid metric name");
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

type SignozResult = {
  nextCursor?: string;
  rows?: Array<{ timestamp?: string; data?: Record<string, unknown> }>;
  aggregations?: Array<{
    series?: Array<{
      labels?: Array<{ key?: string | { name?: string }; value?: unknown }>;
      values?: Array<{ timestamp?: unknown; value?: unknown }>;
    }>;
  }>;
  columns?: Array<{ name?: string }>;
  data?: unknown[][];
};
type SignozResponse =
  { data?: { data?: { results?: SignozResult[] }; results?: SignozResult[] } } | null | undefined;

const resultsOf = (json: unknown): SignozResult[] => {
  const d = (json as SignozResponse)?.data;
  return d?.data?.results ?? d?.results ?? [];
};

const cut = (v: unknown) => (typeof v === "string" && v.length > 2000 ? `${v.slice(0, 2000)}…` : v);

/** Raw rows with nested attribute maps flattened, deduplicated by id (or timestamp+content). */
export function parseRaw(json: unknown) {
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

export function parseTimeSeries(json: unknown, maxSeries = 50, maxPoints = 120) {
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
        for (const l of s?.labels ?? [])
          labels[String((typeof l?.key === "object" ? l.key?.name : undefined) ?? l?.key ?? "")] =
            String(l?.value ?? "");
        const values = (s?.values ?? [])
          .map((v) => [Number(v?.timestamp), Number(v?.value)] as [number, number])
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

export function parseScalar(json: unknown, maxRows = 200) {
  const r: SignozResult = resultsOf(json)[0] ?? {};
  const columns: string[] = (r.columns ?? []).map((c) => String(c?.name ?? ""));
  const data: unknown[][] = r.data ?? [];
  return {
    columns,
    rows: data.slice(0, maxRows),
    total_rows: data.length,
    truncated: data.length > maxRows,
  };
}

const EMPTY =
  "no telemetry returned for this query and window — absence of data is not evidence that the service is healthy";

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
    throw new SignozError(
      "budget_exhausted",
      `query budget exhausted: this run already ran ${used!.run} log/telemetry queries (limit ${config.splunk.queryBudget})`,
    );
  if ((used?.step ?? 0) >= config.signoz.maxCallsPerStep)
    throw new SignozError(
      "budget_exhausted",
      `this step already made ${used!.step} SigNoz calls (limit ${config.signoz.maxCallsPerStep}); narrow with the evidence collected`,
    );
}

const describe = (body: ReturnType<typeof envelope>) =>
  `signoz ${body.requestType} ${JSON.stringify(body.compositeQuery.queries[0].spec)}`.slice(
    0,
    4000,
  );

async function run(body: ReturnType<typeof envelope>, scope: SearchScope, signal?: AbortSignal) {
  const cfg = current();
  await checkBudget(scope);
  return call(cfg, "POST", "/api/v5/query_range", body, signal);
}

const record = (
  body: ReturnType<typeof envelope>,
  rows: Array<Record<string, unknown>>,
  scope: SearchScope,
  note?: string,
) =>
  storeExternalSearch(
    { source: "signoz", query: describe(body), earliest: body.start, latest: body.end, rows, note },
    scope,
  );

function toEvent(
  row: { timestamp: string; data: Record<string, unknown> },
  signal: "logs" | "traces",
) {
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

const requestIdKeyCache = new Map<string, { keys: string[]; at: number }>();

/** Span attributes holding a request id on this SigNoz (e.g. request.id, request_id); cached for an hour. */
async function requestIdKeys(): Promise<string[]> {
  const cfg = current();
  const hit = requestIdKeyCache.get(cfg.baseUrl);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.keys;
  let keys: string[] = [];
  try {
    const json = (await call(
      cfg,
      "GET",
      "/api/v1/fields/keys?signal=traces&searchText=request&limit=50",
    )) as {
      data?: { keys?: Record<string, unknown> };
    };
    keys = Object.keys(json.data?.keys ?? {})
      .filter((k) => /(^|[._])request[._]?id$/i.test(k))
      .sort();
  } catch {
    // Without discovery spans still load; only the request id fields and filter are missing.
  }
  requestIdKeyCache.set(cfg.baseUrl, { keys, at: Date.now() });
  return keys;
}

type Span = { ref: string; id: string; parent: string; start: number; end: number };

/** Nanosecond-precision RFC 3339 timestamp → epoch milliseconds with a fractional part. */
const epochMs = (iso: string) => {
  const frac = /\.(\d+)/.exec(iso)?.[1] ?? "0";
  return Date.parse(iso.replace(/\.\d+/, "")) + Number(`0.${frac}`) * 1000;
};

/**
 * Time inside a span during which none of its child spans ran: uninstrumented work (an untraced call, a lock or
 * sleep, CPU). Only gaps of at least max(minMs, minShare of the parent) count; largest first.
 */
export function traceGaps(
  rows: Array<{ timestamp: string; data: Record<string, unknown> }>,
  refs: string[],
  minMs = 50,
  minShare = 0.1,
) {
  const spans: Span[] = rows.map((r, i) => {
    const start = epochMs(r.timestamp);
    return {
      ref: refs[i],
      id: String(r.data.span_id ?? ""),
      parent: String(r.data.parent_span_id ?? ""),
      start,
      end: start + Number(r.data.duration_nano ?? 0) / 1e6,
    };
  });
  const t0 = Math.min(...spans.map((x) => x.start));
  const children = new Map<string, Span[]>();
  for (const x of spans)
    if (x.parent) children.set(x.parent, [...(children.get(x.parent) ?? []), x]);
  const gaps: Array<{
    in: string;
    after: string | null;
    before: string | null;
    gap_ms: number;
    at_ms: number;
    share: number;
  }> = [];
  for (const p of spans) {
    const kids = (children.get(p.id) ?? []).sort((a, b) => a.start - b.start);
    if (!kids.length) continue;
    const threshold = Math.max(minMs, (p.end - p.start) * minShare);
    let cursor = p.start;
    let prev: Span | null = null;
    const add = (from: number, to: number, before: Span | null) => {
      if (to - from >= threshold)
        gaps.push({
          in: p.ref,
          after: prev?.ref ?? null,
          before: before?.ref ?? null,
          gap_ms: Math.round((to - from) * 10) / 10,
          at_ms: Math.round((from - t0) * 10) / 10,
          share: Math.round(((to - from) / (p.end - p.start)) * 100) / 100,
        });
    };
    for (const k of kids) {
      add(cursor, k.start, k);
      if (k.end > cursor) {
        cursor = k.end;
        prev = k;
      }
    }
    add(cursor, p.end, null);
  }
  return gaps.sort((a, b) => b.gap_ms - a.gap_ms).slice(0, 10);
}

async function rawQuery(
  body: ReturnType<typeof envelope>,
  signal: "logs" | "traces",
  scope: SearchScope,
  abort?: AbortSignal,
  analyze?: (
    rows: Array<{ timestamp: string; data: Record<string, unknown> }>,
    refs: string[],
  ) => Record<string, unknown>,
) {
  const json = await run(body, scope, abort);
  const { rows, nextCursor } = parseRaw(json);
  const spec = body.compositeQuery.queries[0].spec as { limit: number; offset: number };
  const stored = await record(
    body,
    rows.map((r) => toEvent(r, signal)),
    scope,
    rows.length ? undefined : EMPTY,
  );
  const refs = ((stored as { events?: Array<{ event_ref: string }> }).events ?? []).map(
    (e) => e.event_ref,
  );
  return {
    provider: "signoz",
    signal,
    ...stored,
    ...(analyze && rows.length ? analyze(rows, refs) : {}),
    ...(rows.length >= spec.limit || nextCursor ? { next_offset: spec.offset + rows.length } : {}),
  };
}

export const searchLogs = (
  a: Filters & {
    since_minutes?: number;
    earliest?: string;
    latest?: string;
    limit?: number;
    offset?: number;
  },
  scope: SearchScope,
) => rawQuery(logsSearch(resolveWindow(a), a, a.limit, a.offset ?? 0), "logs", scope);

export const searchTraces = async (
  a: Filters & {
    since_minutes?: number;
    earliest?: string;
    latest?: string;
    limit?: number;
    offset?: number;
  },
  scope: SearchScope,
) =>
  rawQuery(
    tracesSearch(resolveWindow(a), a, a.limit, a.offset ?? 0, false, await requestIdKeys()),
    "traces",
    scope,
  );

/** Every span of one trace (by trace_id, or the trace a request_id belongs to) with its untraced gaps. */
export async function getTrace(
  a: {
    trace_id?: string;
    request_id?: string;
    since_minutes?: number;
    earliest?: string;
    latest?: string;
  },
  scope: SearchScope,
) {
  const w = resolveWindow(a, 24 * 60);
  const keys = await requestIdKeys();
  let traceId = a.trace_id;
  let others: string[] = [];
  if (!traceId) {
    if (!a.request_id) throw new SignozError("invalid_query", "pass trace_id or request_id");
    const found = parseRaw(
      await run(tracesSearch(w, { request_id: a.request_id }, 20, 0, false, keys), scope),
    ).rows;
    const ids = [...new Set(found.map((r) => String(r.data.trace_id ?? "")).filter(Boolean))];
    if (!ids.length)
      throw new SignozError(
        "invalid_query",
        `no span carries request id ${a.request_id} in this window`,
      );
    [traceId, ...others] = ids;
  }
  const result = await rawQuery(
    traceById(w, traceId, keys),
    "traces",
    scope,
    undefined,
    (rows, refs) => ({
      gaps: traceGaps(rows, refs),
    }),
  );
  return { ...result, trace_id: traceId, ...(others.length ? { other_trace_ids: others } : {}) };
}

async function inline(
  body: ReturnType<typeof envelope>,
  scope: SearchScope,
  parse: (json: unknown) => { empty: boolean } & Record<string, unknown>,
) {
  const json = await run(body, scope);
  const parsed = parse(json);
  const stored = await record(
    body,
    [],
    scope,
    parsed.empty ? EMPTY : "aggregate result returned inline",
  );
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
  a: Filters & {
    since_minutes?: number;
    earliest?: string;
    latest?: string;
    group_by?: string[];
    aggregation?: string;
    limit?: number;
    time_series?: boolean;
  },
  scope: SearchScope,
) =>
  inline(
    logsAggregate(resolveWindow(a), a, a.group_by, a.aggregation, a.limit, a.time_series),
    scope,
    (json) => {
      if (a.time_series) {
        const t = parseTimeSeries(json);
        return { ...t, empty: !t.series.length };
      }
      const s = parseScalar(json);
      return { ...s, empty: !s.rows.length };
    },
  );

export const queryMetrics = (
  a: Filters & {
    metric: string;
    time_aggregation?: string;
    space_aggregation?: string;
    group_by?: string[];
    step_seconds?: number;
    since_minutes?: number;
    earliest?: string;
    latest?: string;
  },
  scope: SearchScope,
) =>
  inline(metricsQuery(resolveWindow(a), a, a), scope, (json) => {
    const t = parseTimeSeries(json);
    return { ...t, empty: !t.series.length };
  });

export const listServices = (
  a: { since_minutes?: number; earliest?: string; latest?: string },
  scope: SearchScope,
) =>
  inline(listServicesQuery(resolveWindow(a, 60)), scope, (json) => {
    const s = parseScalar(json);
    return {
      services: s.rows.map((r) => ({ service: String(r[0] ?? ""), spans: Number(r[1] ?? 0) })),
      truncated: s.truncated,
      empty: !s.rows.length,
    };
  });

// ---------------------------------------------------------------- production error scan (platform-run, no agent budget)

const anyOf = (key: string, values: string[]) =>
  `(${values.map((v) => `${key} = ${quote(v)}`).join(" OR ")})`;

/** Span fields an error group is keyed by; the namespace field is `config.signoz.namespaceKey` (default below). */
export const SPAN_GROUP_KEYS = [
  "service.name",
  "name",
  "status_message",
  "response_status_code",
] as const;
const SPAN_GROUP_LIMIT = 300;

export interface SpanErrorGroup {
  ns: string;
  service: string;
  name: string;
  status: string;
  code: string;
  count: number;
  /** [bucket start in seconds, error spans] for non-empty hours (window only). */
  hourly: Array<[number, number]>;
}

const spanFilter = (namespaces: string[]) => {
  const nsKey = config.signoz.namespaceKey || "deployment.environment";
  return {
    nsKey,
    expression: ["has_error = true", ...(namespaces.length ? [anyOf(nsKey, namespaces)] : [])].join(
      " AND ",
    ),
  };
};

/**
 * Error spans (`has_error = true`) of the given namespaces, counted by SigNoz per namespace, service, span name,
 * status message and status code over the scan window and the baseline window (scalar: exact, empty labels included).
 * Hourly points come from a time series and are best effort: SigNoz omits series with an empty label there. The
 * baseline counts only when the baseline window holds any span of these namespaces; otherwise there is nothing to
 * compare with (tracing started later, or a shorter retention). Also returns the newest error spans as trace samples.
 */
export async function signozErrorSpanGroups(
  w: Window,
  baseline: Window,
  namespaces: string[],
  signal?: AbortSignal,
) {
  const cfg = current();
  const { nsKey, expression } = spanFilter(namespaces);
  const scope = namespaces.length ? anyOf(nsKey, namespaces) : "";
  const spec = {
    signal: "traces",
    aggregations: [{ expression: "count()", alias: "value" }],
    filter: { expression },
    groupBy: [nsKey, ...SPAN_GROUP_KEYS].map((name) => ({ name })),
    order: [{ key: { name: "value" }, direction: "desc" }],
    limit: SPAN_GROUP_LIMIT,
  };
  const query = (body: unknown) => call(cfg, "POST", "/api/v5/query_range", body, signal);
  const [counts, series, base, spans, recent] = await Promise.all([
    query(envelope(w, "scalar", spec)),
    query(envelope(w, "time_series", { ...spec, stepInterval: 3600 })),
    query(envelope(baseline, "scalar", spec)),
    query(
      envelope(baseline, "scalar", {
        signal: "traces",
        aggregations: [{ expression: "count()", alias: "value" }],
        ...(scope ? { filter: { expression: scope } } : {}),
        limit: 1,
      }),
    ),
    query(
      envelope(w, "raw", {
        signal: "traces",
        filter: { expression },
        order: [{ key: { name: "timestamp" }, direction: "desc" }],
        limit: Math.min(200, config.signoz.maxLimit),
      }),
    ),
  ]);
  const label = (get: (k: string) => unknown) => ({
    ns: String(get(nsKey) ?? ""),
    service: String(get("service.name") ?? ""),
    name: String(get("name") ?? ""),
    status: String(get("status_message") ?? ""),
    code: String(get("response_status_code") ?? ""),
  });
  const id = (g: ReturnType<typeof label>) =>
    [g.ns, g.service, g.name, g.status, g.code].join("\u0000");
  const hourly = new Map<string, Array<[number, number]>>();
  for (const s of parseTimeSeries(series, SPAN_GROUP_LIMIT, 10_000).series)
    hourly.set(
      id(label((k) => s.labels[k])),
      s.points
        .filter(([, n]) => n > 0)
        .map(([t, n]): [number, number] => [Math.floor(t / 1000 / 3600) * 3600, n]),
    );
  const groups = (json: unknown, withHourly: boolean): SpanErrorGroup[] => {
    const sc = parseScalar(json, SPAN_GROUP_LIMIT);
    return sc.rows.map((r) => {
      const g = label((k) => r[sc.columns.indexOf(k)]);
      return {
        ...g,
        count: Number(r.at(-1)) || 0,
        hourly: withHourly ? (hourly.get(id(g)) ?? []) : [],
      };
    });
  };
  const today = groups(counts, true);
  return {
    today,
    yesterday: groups(base, false),
    hasBaseline: (Number(parseScalar(spans).rows[0]?.at(-1)) || 0) > 0,
    samples: parseRaw(recent).rows,
    truncated: today.length >= SPAN_GROUP_LIMIT,
  };
}

export interface SlowRequestGroup {
  ns: string;
  service: string;
  name: string;
  /** Requests slower than the threshold. */
  slow: number;
  total: number;
  p50_ms: number;
  p95_ms: number;
}

/**
 * Requests (root spans: one per request, so a slow gateway call is not also counted at every service below it) slower
 * than `thresholdMs`, per namespace, service and entry span, over the scan and baseline windows, plus the slowest
 * root spans of the window (trace and request ids) as samples.
 */
export async function signozSlowRequestGroups(
  w: Window,
  baseline: Window,
  namespaces: string[],
  thresholdMs: number,
  signal?: AbortSignal,
) {
  const cfg = current();
  const nsKey = config.signoz.namespaceKey || "deployment.environment";
  const roots = [
    "parent_span_id = ''",
    ...(namespaces.length ? [anyOf(nsKey, namespaces)] : []),
  ].join(" AND ");
  const nanos = Math.round(thresholdMs * 1e6);
  const spec = {
    signal: "traces",
    aggregations: [
      `countIf(duration_nano > ${nanos})`,
      "count()",
      "p50(duration_nano)",
      "p95(duration_nano)",
    ].map((expression, i) => ({ expression, alias: `a${i}` })),
    filter: { expression: roots },
    groupBy: [nsKey, "service.name", "name"].map(groupKey),
    order: [{ key: { name: "a0" }, direction: "desc" }],
    limit: SPAN_GROUP_LIMIT,
  };
  const keys = await requestIdKeys();
  const query = (body: unknown) => call(cfg, "POST", "/api/v5/query_range", body, signal);
  const [now, base, recent] = await Promise.all([
    query(envelope(w, "scalar", spec)),
    query(envelope(baseline, "scalar", spec)),
    query(
      envelope(w, "raw", {
        signal: "traces",
        selectFields: [...TRACE_FIELDS, ...keys].map((name) => ({ name })),
        filter: { expression: `${roots} AND duration_nano > ${nanos}` },
        order: [{ key: { name: "duration_nano" }, direction: "desc" }],
        limit: Math.min(200, config.signoz.maxLimit),
      }),
    ),
  ]);
  const groups = (json: unknown): SlowRequestGroup[] => {
    const sc = parseScalar(json, SPAN_GROUP_LIMIT);
    const at = (r: unknown[], k: string) => r[sc.columns.indexOf(k)];
    // Aggregation columns follow the group-by columns in request order (SigNoz names them __result_<i>).
    const agg = (r: unknown[], i: number) => Number(r[r.length - 4 + i]) || 0;
    return sc.rows.map((r) => ({
      ns: String(at(r, nsKey) ?? ""),
      service: String(at(r, "service.name") ?? ""),
      name: String(at(r, "name") ?? ""),
      slow: agg(r, 0),
      total: agg(r, 1),
      p50_ms: Math.round(agg(r, 2) / 1e6),
      p95_ms: Math.round(agg(r, 3) / 1e6),
    }));
  };
  const today = groups(now).filter((g) => g.slow > 0);
  return {
    today,
    yesterday: groups(base),
    samples: parseRaw(recent).rows,
    truncated: today.length >= SPAN_GROUP_LIMIT,
  };
}

/** Untraced gaps of one trace, labelled "service span" (platform scan: no agent budget, nothing stored). */
export async function signozTraceGaps(w: Window, traceId: string, signal?: AbortSignal) {
  const cfg = current();
  const rows = parseRaw(
    await call(cfg, "POST", "/api/v5/query_range", traceById(w, traceId), signal),
  ).rows;
  const labels = rows.map((r) =>
    `${String(r.data["service.name"] ?? "")} ${String(r.data.name ?? "")}`.trim(),
  );
  return traceGaps(rows, labels);
}
