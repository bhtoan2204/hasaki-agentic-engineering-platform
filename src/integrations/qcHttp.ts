import { config } from "../config.ts";
import { currentUserId } from "../auth/execution.ts";
import { BlockedDestinationError, rateLimit, safeRequest, validateBaseUrl } from "./safeHttp.ts";
import { redactSecrets } from "./redact.ts";
import { vaultSecretValues } from "./vault.ts";

/**
 * Controlled HTTP to QC services for chat business operations. Every request:
 *  - goes to an explicitly allowlisted QC host (`qcHttp.hosts`), never to a production-looking host or domain;
 *  - runs through safeHttp (DNS-pinned internal/metadata address checks, no redirects, TLS on, bounded body);
 *  - gets credentials injected by the backend from a login profile (`qcHttp.auth`); the model never sees a credential
 *    or a token, may not set auth headers itself, and token-like response fields are masked;
 *  - is never retried when it changes state (a timeout leaves the outcome unknown, not "try again").
 */

const PRODUCTION = /(^|[.-])(prod|production|live|prd)([.-]|\d|$)/i;
const SENSITIVE_FIELD =
  /token|password|passwd|secret|authorization|cookie|api[-_]?key|credential|session/i;
const FORBIDDEN_HEADER =
  /^(authorization|cookie|proxy-authorization|x-api-key|x-auth.*|.*token.*|host|content-length)$/i;
const READ_RETRIES = 2;

export type QcMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const hostMatches = (host: string, pattern: string) => {
  const p = pattern.toLowerCase();
  return p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p;
};

/** Parse and authorize a destination: allowlisted QC host, never production, SSRF-checked. */
export function qcDestination(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedDestinationError(`invalid URL ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  const prodDomain = config.qcHttp.productionDomains.some(
    (d) => host === d || host.endsWith(`.${d}`),
  );
  if (PRODUCTION.test(host) || prodDomain)
    throw new BlockedDestinationError(`${host} is a production host: chat never calls production`);
  if (!config.qcHttp.hosts.some((p) => hostMatches(host, p)))
    throw new BlockedDestinationError(`${host} is not an allowlisted QC host (qcHttp.hosts)`);
  if (url.username || url.password)
    throw new BlockedDestinationError("credentials in the URL are not allowed");
  validateBaseUrl(url.origin, config.qcHttp.internalHosts);
  return url;
}

/** A mutating request that runs without a per-call confirmation (configured low-risk QC operations). */
export function qcPreauthorized(method: string, raw: string) {
  if (method === "GET" || method === "DELETE") return method === "GET";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return config.qcHttp.preauthorized.some(
    (r) =>
      r.method.toUpperCase() === method &&
      hostMatches(url.hostname.toLowerCase(), r.host) &&
      url.pathname.startsWith(r.path),
  );
}

/** Mask credential-like fields anywhere in a response before it can reach a model. */
export function maskSecrets(v: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth]";
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => maskSecrets(x, depth + 1));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        SENSITIVE_FIELD.test(k) && x != null && x !== "" ? "[masked]" : maskSecrets(x, depth + 1),
      ]),
    );
  return typeof v === "string" ? redactSecrets(v) : v;
}

const at = (v: unknown, path: string) =>
  path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      v,
    );

// ---------------------------------------------------------------- backend-managed authentication

const tokens = new Map<string, { token: string; expiresAt: number }>();
let credentialSource: (path: string, keys: string[]) => Promise<Record<string, string>> =
  vaultSecretValues;
/** Tests replace the Vault credential source. */
export function setQcCredentialSource(fn: typeof credentialSource | null) {
  credentialSource = fn ?? vaultSecretValues;
}

export function authProfileFor(name: string, host: string) {
  const p = config.qcHttp.auth[name];
  if (!p) throw new Error(`unknown auth profile ${name}: see qc_http.services`);
  if (!p.hosts.some((h) => hostMatches(host, h)))
    throw new Error(`auth profile ${name} is not for ${host}`);
  return p;
}

const fill = (v: unknown, creds: Record<string, string>): unknown =>
  typeof v === "string"
    ? v.replace(/\{\{(username|password)\}\}/g, (_, k: string) => creds[k])
    : Array.isArray(v)
      ? v.map((x) => fill(x, creds))
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, creds)]))
        : v;

/** Session-isolated token: cached per (user, profile), refreshed on expiry or when the service answers 401. */
async function accessToken(profileName: string, host: string, refresh = false) {
  const userId = currentUserId();
  if (!userId) throw new Error("QC authentication needs an authenticated owner");
  const key = `${userId}|${profileName}`;
  const cached = tokens.get(key);
  if (!refresh && cached && cached.expiresAt > Date.now() + 10_000) return cached.token;
  const p = authProfileFor(profileName, host);
  const v = p.credentials.vault;
  const raw = await credentialSource(v.path, [v.usernameKey, v.passwordKey]);
  const creds = { username: raw[v.usernameKey], password: raw[v.passwordKey] };
  const loginUrl = qcDestination(p.login.url);
  const res = await safeRequest(
    {
      url: loginUrl,
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(fill(p.login.body, creds)),
      approvedInternalHosts: config.qcHttp.internalHosts,
      timeoutMs: config.qcHttp.timeoutMs,
      maxBytes: config.qcHttp.maxBytes,
    },
    0,
  );
  if (res.status < 200 || res.status >= 300)
    throw new Error(`QC login for profile ${profileName} failed with HTTP ${res.status}`);
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    throw new Error(`QC login for profile ${profileName} returned no JSON`);
  }
  const token = at(body, p.login.tokenPath);
  if (typeof token !== "string" || !token)
    throw new Error(`QC login for profile ${profileName}: no token at ${p.login.tokenPath}`);
  const ttl = Number(p.login.expiresInPath ? at(body, p.login.expiresInPath) : NaN);
  tokens.set(key, {
    token,
    expiresAt: Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 15 * 60_000),
  });
  return token;
}

export const clearQcTokens = () => tokens.clear();

// ---------------------------------------------------------------- request

export interface QcRequest {
  method: QcMethod;
  url: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
  auth?: string;
  /** Sent as Idempotency-Key on state-changing requests (the platform operation key). */
  idempotencyKey?: string;
}

export async function qcRequest(r: QcRequest, signal?: AbortSignal) {
  const url = qcDestination(r.url);
  for (const [k, v] of Object.entries(r.query ?? {})) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [k, v] of Object.entries(r.headers ?? {})) {
    if (FORBIDDEN_HEADER.test(k))
      throw new BlockedDestinationError(`header ${k} is set by the platform, not the caller`);
    headers[k.toLowerCase()] = v;
  }
  const body =
    r.body == null ? undefined : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  if (body && !headers["content-type"]) headers["content-type"] = "application/json";
  const mutating = r.method !== "GET";
  if (mutating && r.idempotencyKey) headers["idempotency-key"] = r.idempotencyKey;
  await rateLimit(`qc:${currentUserId() ?? 0}`, 5, 10);
  const send = async (refresh: boolean) => {
    const auth = r.auth ? await accessToken(r.auth, url.hostname.toLowerCase(), refresh) : null;
    const p = r.auth ? config.qcHttp.auth[r.auth] : null;
    return safeRequest(
      {
        url,
        method: r.method,
        headers: auth
          ? {
              ...headers,
              [(p!.header ?? "authorization").toLowerCase()]:
                `${p!.scheme ?? "Bearer"} ${auth}`.trim(),
            }
          : headers,
        body,
        approvedInternalHosts: config.qcHttp.internalHosts,
        timeoutMs: config.qcHttp.timeoutMs,
        maxBytes: config.qcHttp.maxBytes,
        signal,
      },
      // A state-changing request is sent once: a lost response must not become a second order.
      mutating ? 0 : READ_RETRIES,
    );
  };
  let res = await send(false);
  // 401 = the service rejected the credentials and did nothing: refreshing and resending once is safe.
  if (res.status === 401 && r.auth) res = await send(true);
  let parsed: unknown = res.text;
  try {
    parsed = res.text ? JSON.parse(res.text) : null;
  } catch {
    parsed = res.text.slice(0, 20_000);
  }
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    method: r.method,
    url: `${url.origin}${url.pathname}`,
    body: maskSecrets(parsed),
    ...(mutating
      ? {
          business_verified: false,
          note: "The service answered; that is not proof the business outcome exists. Read it back (qc_http.get, database.query, kafka.read_messages) and call operations.verify.",
        }
      : {}),
  };
}

// ---------------------------------------------------------------- discovery

const SPEC_PATHS = [
  "/openapi.json",
  "/swagger.json",
  "/v3/api-docs",
  "/swagger/doc.json",
  "/api-docs",
  "/docs/openapi.json",
];
const METHODS = ["get", "post", "put", "patch", "delete"];

/** Operations of an OpenAPI/Swagger document, summarized (bounded). Pure. */
export function summarizeOpenApi(doc: Record<string, unknown>, limit = 150) {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  const refName = (s: unknown) => {
    const ref = (s as { $ref?: string } | undefined)?.$ref;
    return ref
      ? ref.split("/").pop()
      : s && typeof s === "object"
        ? Object.keys((s as { properties?: object }).properties ?? {}).slice(0, 20)
        : undefined;
  };
  const ops: Array<Record<string, unknown>> = [];
  for (const [path, item] of Object.entries(paths))
    for (const m of METHODS) {
      const op = item?.[m];
      if (!op) continue;
      const content = (
        op.requestBody as { content?: Record<string, { schema?: unknown }> } | undefined
      )?.content;
      const body = content
        ? Object.values(content)[0]?.schema
        : (op.parameters as Array<{ in?: string; schema?: unknown }> | undefined)?.find(
            (p) => p.in === "body",
          )?.schema;
      ops.push({
        method: m.toUpperCase(),
        path,
        summary: String(op.summary ?? op.description ?? "").slice(0, 160),
        operation_id: op.operationId,
        request: refName(body),
      });
    }
  const info = (doc.info ?? {}) as { title?: string; version?: string };
  return {
    title: info.title,
    version: info.version,
    total: ops.length,
    operations: ops.slice(0, limit),
  };
}

/** Find and summarize the service's OpenAPI document on an allowlisted QC host. */
export async function discoverOpenApi(baseUrl: string, path?: string, auth?: string) {
  const base = qcDestination(baseUrl);
  const tried: string[] = [];
  for (const p of path ? [path] : SPEC_PATHS) {
    const url = `${base.origin}${base.pathname.replace(/\/+$/, "")}${p}`;
    tried.push(p);
    try {
      const r = await qcRequest({ method: "GET", url, auth });
      if (r.ok && r.body && typeof r.body === "object" && "paths" in (r.body as object))
        return { found: url, ...summarizeOpenApi(r.body as Record<string, unknown>) };
    } catch (e) {
      if (e instanceof BlockedDestinationError) throw e;
    }
  }
  return {
    found: null,
    tried,
    hint: "No OpenAPI document: use knowledge.search and code.search on the service repository.",
  };
}

/** What chat may call: allowlisted hosts, preauthorized operations, auth profiles (names and hosts only). */
export function qcServices() {
  return {
    hosts: config.qcHttp.hosts,
    preauthorized: config.qcHttp.preauthorized,
    auth_profiles: Object.entries(config.qcHttp.auth).map(([name, p]) => ({
      name,
      hosts: p.hosts,
    })),
    max_operations_per_turn: config.qcHttp.maxOperationsPerTurn,
  };
}
