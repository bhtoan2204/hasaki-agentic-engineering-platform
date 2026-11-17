import { config } from "../config.ts";
import { currentUserId } from "../auth/execution.ts";
import { one, pool } from "../db/pool.ts";
import { PersonalSession, personalSettings } from "./personal.ts";
import { BlockedDestinationError, HttpError, rateLimit, safeRequest, validateBaseUrl } from "./safeHttp.ts";
import { storeExternalSearch, type SearchScope } from "./splunk.ts";

/**
 * SigNoz (logs, traces, metrics) through the documented v5 Query Range API (`POST /api/v5/query_range`,
 * header `SIGNOZ-API-KEY`). Each user stores their own base URL and API key (encrypted in user_secrets); a run uses its
 * owner's. Only documented request/response shapes are used — services and single traces are query_range queries too.
 */

const KIND = "signoz";

interface SignozConfig {
  baseUrl: string;
  token: string;
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

/** Usable for the current actor: configured, enabled and holding a key. */
export function signozEnabled() {
  const c = session.current;
  return !!c && c.enabled && !!c.token;
}

export function signozStatus() {
  const c = session.current;
  return {
    configured: !!c,
    enabled: !!c?.enabled,
    connected: signozEnabled(),
    base_url: c?.baseUrl ?? null,
    token_set: !!c?.token,
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

async function call(cfg: SignozConfig, method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal) {
  let res: { status: number; text: string };
  try {
    await rateLimit(`signoz:${currentUserId() ?? 0}`);
    res = await safeRequest(
      {
        url: new URL(cfg.baseUrl + path),
        method,
        headers: {
          "SIGNOZ-API-KEY": cfg.token,
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
  const detail = errorMessage(res.text);
  if (res.status === 401) throw new SignozError("auth_failed", "the API key was rejected (401)");
  if (res.status === 403 || /authz_forbidden/.test(res.text))
    throw new SignozError(
      "forbidden",
      `the API key's service account lacks permission (403)${detail ? `: ${detail}` : ""}; grant a read role such as signoz-viewer`,
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
  if (!c?.token) throw new SignozError("not_configured", "SigNoz is not configured: add your domain and API key in Integrations");
  if (!c.enabled) throw new SignozError("not_configured", "SigNoz is disabled in your Integrations settings");
  return c;
}

/** Key check (`/api/v1/service_accounts/me`) then a one-minute v5 query_range probe. */
async function probe(cfg: SignozConfig, signal?: AbortSignal) {
  const began = Date.now();
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
  if (!c?.token) return { ok: false, kind: "not_configured" as const, message: "SigNoz is not configured" };
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

/** Validate, test (when enabled) and store. An empty token keeps the stored key. */
export async function saveSignoz(input: { baseUrl?: unknown; token?: unknown; enabled?: unknown }) {
  const prior = session.current;
  let url: URL;
  try {
    url = validateBaseUrl(String(input.baseUrl ?? prior?.baseUrl ?? ""), config.signoz.allowedInternalHosts);
  } catch (e) {
    if (e instanceof BlockedDestinationError) throw new SignozError("blocked_destination", e.message);
    throw e;
  }
  const token = typeof input.token === "string" && input.token.trim() ? input.token.trim() : prior?.token;
  if (!token) throw new SignozError("not_configured", "an API key is required");
  if (/\s/.test(token) || token.length > 512) throw new SignozError("auth_failed", "the API key format is invalid");
  const next: SignozConfig = {
    baseUrl: (url.origin + url.pathname).replace(/\/+$/, ""),
    token,
    enabled: input.enabled === undefined ? (prior?.enabled ?? true) : input.enabled === true,
  };
  if (next.enabled) {
    await probe(next);
    next.lastOkAt = new Date().toISOString();
  } else if (prior?.baseUrl === next.baseUrl && prior.token === next.token) next.lastOkAt = prior.lastOkAt;
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
