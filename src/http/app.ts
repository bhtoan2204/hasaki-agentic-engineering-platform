import { acceptWebhook } from "../telegram/transport.ts";
import { SharedAbort } from "./sharedAbort.ts";
import { handleInternal } from "../prodErrors/gateway.ts";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { isTransientDbError, pool } from "../db/pool.ts";
import { execution } from "../auth/execution.ts";
import { loadPersonalIntegrations } from "../integrations/loadPersonal.ts";
import { routesFor } from "../api/routes.ts";
import { EngineError } from "../workflow/mutations.ts";
import { positiveId } from "./params.ts";
import { claimIdempotency, needsIdempotency } from "./idempotency.ts";
import { singleflight } from "../cache/index.ts";
import { HttpError } from "./error.ts";
import { messages as uiMessages } from "../../shared/i18n/messages.ts";
import { handleEventsSince, handleStream } from "../api/stream.ts";
import { handleChatStream } from "../chat/events.ts";
import {
  clearSessionCookie,
  csrfOk,
  login,
  logout,
  sessionFromRequest,
  setSessionCookie,
} from "../auth/sessions.ts";
import { setPassword } from "../auth/users.ts";
import { wantsSupport } from "../authz/access.ts";
import { artifactResponseHeaders } from "./artifactResponse.ts";
import { compress, compressedStatic, COMPRESS_MIN_BYTES, pickEncoding } from "./compression.ts";
import { count, observe } from "../runtimeMetrics.ts";
import { config } from "../config.ts";
import { logError, runWithLogContext } from "../logging.ts";
import {
  bodyLimitFor,
  DEFAULT_BODY_LIMIT,
  TELEGRAM_WEBHOOK_BODY_LIMIT,
  UPLOAD_BODY_LIMIT,
} from "./bodyLimits.ts";
import { applySecurityHeaders } from "./securityHeaders.ts";
import { parseBody } from "./validate.ts";
import { AttachmentBody, LoginBody, PasswordBody } from "./schemas.ts";
import { ignoreError } from "../ignoreError.ts";

const webDist = resolve(import.meta.dirname, "..", "..", "web", "dist");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json"]);

/** Static files kept in memory by mtime, so a request does not re-read the bundle; bounded in total bytes. */
const STATIC_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const STATIC_FILE_MAX_BYTES = 8 * 1024 * 1024;
const fileCache = new Map<string, { mtimeMs: number; body: Buffer }>();
let fileCacheBytes = 0;

async function readStatic(file: string, mtimeMs: number, size: number): Promise<Buffer> {
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.body;
  const body = await readFile(file);
  if (hit) fileCacheBytes -= hit.body.length;
  fileCache.delete(file);
  if (size <= STATIC_FILE_MAX_BYTES) {
    // Map keeps insertion order: evict the oldest entries until the new one fits.
    for (const [key, old] of fileCache) {
      if (fileCacheBytes + body.length <= STATIC_CACHE_MAX_BYTES) break;
      fileCache.delete(key);
      fileCacheBytes -= old.body.length;
    }
    fileCache.set(file, { mtimeMs, body });
    fileCacheBytes += body.length;
  }
  return body;
}

async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  cache = "no-cache",
) {
  const info = statSync(file);
  const body = await readStatic(file, info.mtimeMs, info.size);
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const encoding =
    COMPRESSIBLE.has(extname(file)) && body.length >= 1024
      ? pickEncoding(req.headers["accept-encoding"])
      : null;
  if (!encoding) {
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
    return void res.end(body);
  }
  const out = await compressedStatic(file, info.mtimeMs, body, encoding);
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": cache,
    "Content-Encoding": encoding,
    "Content-Length": out.length,
    Vary: "Accept-Encoding",
  });
  res.end(out);
}

async function serveStatic(url: URL, req: IncomingMessage, res: ServerResponse) {
  if (url.pathname.startsWith("/api/")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, "Malformed URL");
  }
  if (decoded.includes("\0") || decoded.includes("\\")) throw new HttpError(400, "Malformed URL");
  const rel = normalize(decoded).replace(/^\/+/, "");
  const file = resolve(webDist, rel);
  if (file !== webDist && !file.startsWith(webDist + sep))
    throw new HttpError(400, "Malformed URL");
  if (rel && isFile(file))
    return (
      await serveFile(
        req,
        res,
        file,
        rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      ),
      true
    );
  // A hashed build file that is gone (a tab still on the previous build after a rebuild) is a 404: serving the HTML
  // shell instead makes the browser reject it as a module and the page goes blank. The client reloads on that error.
  if (rel.startsWith("assets/")) {
    res
      .writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
      .end("Not found: this file belongs to another build of the UI; reload the page.");
    return true;
  }
  const index = join(webDist, "index.html");
  if (isFile(index)) return (await serveFile(req, res, index), true);
  res
    .writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
    .end("UI not built yet: run `npm run build` (npm start does it automatically).");
  return true;
}

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Thrown for an oversized body; handle() answers it with Connection: close and drops the unread rest of the body. */
class BodyTooLarge extends HttpError {
  constructor() {
    super(413, "Body too large");
  }
}

async function readJson(req: IncomingMessage, maxBytes = DEFAULT_BODY_LIMIT): Promise<unknown> {
  // A declared length over the limit is refused before a single body byte is read.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

async function readObject(
  req: IncomingMessage,
  maxBytes = DEFAULT_BODY_LIMIT,
  nullAsEmpty = false,
) {
  const body = await readJson(req, maxBytes);
  if (body === null && nullAsEmpty) return {};
  if (body === null || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(400, "JSON body must be an object");
  return body as Record<string, unknown>;
}

function errorResponse(cause: unknown) {
  if (!(cause instanceof HttpError || cause instanceof EngineError) && isTransientDbError(cause))
    return {
      status: 503,
      body: { error: "Database temporarily unavailable" },
      outcomeUncertain: true,
    };

  const status =
    cause instanceof HttpError || cause instanceof EngineError
      ? cause.status
      : cause && typeof cause === "object" && "code" in cause && cause.code === "23505"
        ? 409
        : 400;
  const details =
    cause instanceof Error && "errors" in cause && Array.isArray(cause.errors)
      ? cause.errors.filter((detail): detail is string => typeof detail === "string")
      : [];
  return {
    status,
    body: {
      error: cause instanceof Error ? cause.message : "Request failed",
      ...(details.length ? { details } : {}),
    },
  };
}

function send(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extra });
  res.end(JSON.stringify(body));
}

/** A GET route's result, compressed when it is large and the client accepts it (see compression.ts). */
async function sendResult(req: IncomingMessage, res: ServerResponse, body: unknown) {
  const text = JSON.stringify(body);
  const raw = Buffer.byteLength(text);
  count("http.responses");
  count("http.bytes_raw", raw);
  observe("http.response_bytes", raw);
  const encoding =
    req.method === "GET" && raw >= COMPRESS_MIN_BYTES
      ? pickEncoding(req.headers["accept-encoding"])
      : null;
  if (!encoding) {
    count("http.bytes_sent", raw);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return void res.end(text);
  }
  const out = await compress(Buffer.from(text), encoding);
  count("http.responses_compressed");
  count("http.bytes_sent", out.length);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Encoding": encoding,
    "Content-Length": out.length,
    Vary: "Accept-Encoding",
  });
  res.end(out);
}

/** Identical concurrent GETs share one execution, and its cancellation (src/http/sharedAbort.ts). */
const getFlights = new SharedAbort();

function correlationHeader(value: string | string[] | undefined) {
  return typeof value === "string" && /^[\w.:-]{1,128}$/.test(value) ? value : undefined;
}

/** Every log line written while a request runs (also across awaits) carries its x-request-id / x-correlation-id. */
export function handle(req: IncomingMessage, res: ServerResponse) {
  return runWithLogContext(
    {
      request_id: correlationHeader(req.headers["x-request-id"]),
      correlation_id: correlationHeader(req.headers["x-correlation-id"]),
    },
    () => handleRequest(req, res),
  );
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const method = req.method ?? "GET";
  const key = `${method} ${url.pathname}`;
  applySecurityHeaders(req, res);
  try {
    // platform-go's internal gateway (bearer token, loopback only); never reached through a browser session.
    if (url.pathname.startsWith("/internal/") && (await handleInternal(req, res, url))) return;
    if (key === "POST /api/telegram/webhook") {
      // Verify BEFORE reading a body or bypassing session/CSRF for this single authenticated transport route.
      const { validWebhookSecret } = await import("../telegram/client.ts");
      if (!validWebhookSecret(req.headers["x-telegram-bot-api-secret-token"]))
        throw new HttpError(403, "Invalid Telegram webhook authentication");
      return send(
        res,
        200,
        await acceptWebhook(
          req.headers["x-telegram-bot-api-secret-token"],
          await readJson(req, TELEGRAM_WEBHOOK_BODY_LIMIT),
        ),
      );
    }
    if (key === "GET /api/health") return send(res, 200, { ok: true });
    if (key === "GET /api/ui-messages") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      return res.end(JSON.stringify(uiMessages));
    }
    if (key === "GET /api/auth/status") {
      const result = await pool.query(
        "SELECT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND active) AS ready",
      );
      return send(
        res,
        200,
        { bootstrapRequired: !result.rows[0].ready },
        { "Cache-Control": "no-store" },
      );
    }
    if (key === "POST /api/auth/login") {
      const body = parseBody(LoginBody, await readObject(req, bodyLimitFor(url.pathname)));
      const result = await login(body.username, body.password, req);
      setSessionCookie(res, req, result.token);
      return send(res, 200, {
        user: { id: result.user.id, username: result.user.username, role: result.user.role },
        csrf: result.user.csrf,
      });
    }
    if (method === "GET" && !url.pathname.startsWith("/api/")) {
      // Telegram links use 127.0.0.1 (localhost isn't clickable there); bounce to publicUrl so the session cookie matches.
      const pub = new URL(config.publicUrl);
      if (pub.hostname === "localhost" && req.headers.host === `127.0.0.1:${pub.port || 80}`) {
        res.writeHead(302, { Location: `${pub.origin}${url.pathname}${url.search}` });
        return res.end();
      }
      if (await serveStatic(url, req, res)) return;
    }

    const actor = await sessionFromRequest(req);
    if (!actor) return send(res, 401, { error: "authentication required" });
    if (method !== "GET" && method !== "HEAD" && !csrfOk(req, actor.csrf))
      return send(res, 403, { error: "CSRF check failed" });

    if (key === "GET /api/auth/me")
      return send(res, 200, {
        user: { id: actor.id, username: actor.username, role: actor.role },
        csrf: actor.csrf,
      });
    if (key === "POST /api/auth/logout") {
      await logout(req);
      clearSessionCookie(res, req);
      return send(res, 200, { ok: true });
    }
    if (key === "POST /api/auth/password") {
      const body = parseBody(PasswordBody, await readObject(req, bodyLimitFor(url.pathname)));
      await setPassword(actor.id, body.password);
      await logout(req);
      clearSessionCookie(res, req);
      return send(res, 200, { ok: true });
    }

    if (method === "GET" && url.pathname === "/api/stream") {
      return await handleStream(
        req,
        res,
        url,
        actor,
        wantsSupport(actor, url.searchParams.get("scope")),
      );
    }
    const chatStream =
      method === "GET" && url.pathname.match(/^\/api\/chat\/conversations\/(\d+)\/stream$/);
    if (chatStream) {
      return await handleChatStream(req, res, url, actor, positiveId(chatStream[1]));
    }
    if (key === "GET /api/events") {
      const slice = await handleEventsSince(
        url,
        actor,
        wantsSupport(actor, url.searchParams.get("scope")),
      );
      return slice
        ? send(res, 200, slice, { "Cache-Control": "no-store" })
        : send(res, 404, { error: "not found" });
    }
    // Chat images: the upload body is bounded here (5 MB image as base64 + JSON), the bytes are served only to the
    // owner of the conversation, as an image of the sniffed type, never as a path or a public URL.
    const upload =
      method === "POST" && url.pathname.match(/^\/api\/chat\/conversations\/(\d+)\/attachments$/);
    if (upload) {
      const { uploadAttachment } = await import("../chat/attachments.ts");
      return send(
        res,
        200,
        // 10 MB document as base64 plus the JSON envelope.
        await uploadAttachment(
          actor.id,
          positiveId(upload[1]),
          parseBody(AttachmentBody, await readObject(req, UPLOAD_BODY_LIMIT)),
        ),
      );
    }
    const image = method === "GET" && url.pathname.match(/^\/api\/chat\/attachments\/(\d+)$/);
    if (image) {
      const { readAttachment } = await import("../chat/attachments.ts");
      const a = await readAttachment(actor.id, positiveId(image[1]));
      if (!a) return send(res, 404, { error: "not found" });
      // Documents are downloaded, never rendered in the platform's origin.
      const name = (a.filename || `attachment-${image[1]}`).replace(/[^\w.\- ]/g, "_");
      res.writeHead(200, {
        "Content-Type": a.media_type,
        "Content-Length": a.content.length,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        ...(a.kind === "document"
          ? { "Content-Disposition": `attachment; filename="${name}"` }
          : {}),
      });
      return res.end(a.content);
    }
    const raw = method === "GET" && url.pathname.match(/^\/api\/artifacts\/(\d+)\/raw$/);
    if (raw) {
      const { requireArtifact } = await import("../authz/access.ts");
      const artifactId = positiveId(raw[1]);
      await requireArtifact(actor, artifactId, wantsSupport(actor, url.searchParams.get("scope")));
      const a = (
        await pool.query("SELECT name, content, data FROM workflow_artifacts WHERE id = $1", [
          artifactId,
        ])
      ).rows[0];
      if (!a) return send(res, 404, { error: "not found" });
      const bin = a.data?.encoding === "base64";
      const bytes = bin ? Buffer.from(a.content, "base64") : null;
      res.writeHead(200, artifactResponseHeaders(a.name, a.data?.mime, bytes));
      return res.end(bytes ?? a.content);
    }

    for (const [, pattern, handler] of routesFor(method, url.pathname)) {
      const m = url.pathname.match(pattern);
      if (!m) continue;
      // Budget endpoints also accept JSON null to clear an existing budget.
      const legacyNullBudget = /^\/api\/(?:runs|work-items)\/\d+\/budget$/.test(url.pathname);
      const body =
        method === "POST"
          ? await readObject(req, bodyLimitFor(url.pathname), legacyNullBudget)
          : {};
      // Create-type POSTs with an Idempotency-Key: a repeat replays the first response instead of creating twice.
      const idemKey = req.headers["idempotency-key"];
      const claim =
        typeof idemKey === "string" && needsIdempotency(method, url.pathname)
          ? await claimIdempotency(actor.id, idemKey, url.pathname, body)
          : null;
      if (claim && claim.kind !== "run")
        return send(
          res,
          claim.status,
          claim.body,
          claim.kind === "replay" ? { "Idempotent-Replayed": "true" } : undefined,
        );
      // Aborts when this client disconnects before the response is written.
      const disconnected = new AbortController();
      res.once("close", () => {
        if (!res.writableFinished) disconnected.abort();
      });
      const flightKey = `${actor.id} ${url.pathname}${url.search}`;
      const shared = method === "GET" ? getFlights.join(flightKey, disconnected.signal) : null;
      try {
        const ctx = {
          p: m.slice(1).map((s) => decodeURIComponent(s ?? "")),
          body,
          url,
          actor,
          signal: shared?.signal ?? disconnected.signal,
        };
        // Identical concurrent GETs of one user (every open tab refetches on the same live event) share one execution.
        const execute = () =>
          execution.run({ userId: actor.id, kind: "user" }, async () => {
            if (/^\/api\/(integrations|prod-errors)/.test(url.pathname))
              await loadPersonalIntegrations();
            return handler(ctx);
          });
        const routeStarted = performance.now();
        const out = method === "GET" ? await singleflight(flightKey, execute) : await execute();
        observe("http.route_ms", performance.now() - routeStarted);
        if (claim) await claim.finish(200, out ?? null);
        return await sendResult(req, res, out ?? null);
      } catch (e) {
        if (claim) {
          const { status, body, outcomeUncertain } = errorResponse(e);
          if (outcomeUncertain) {
            // Keep the claim in progress if storing the error also fails. The write may already have committed.
            await claim
              .finish(status, body, { outcomeUncertain })
              .catch(ignoreError("http.idempotency_finish_uncertain"));
          } else {
            await claim
              .finish(status, body)
              .catch(() => claim.release().catch(ignoreError("http.idempotency_release")));
          }
        }
        throw e;
      } finally {
        shared?.leave();
      }
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    if (res.headersSent) return;
    const { status, body } = errorResponse(e);
    if (e instanceof BodyTooLarge) {
      // Do not read the rest of an oversized body: answer, then close the connection.
      res.setHeader("Connection", "close");
      res.once("finish", () => req.destroy());
    }
    if (status >= 500) {
      logError("http.request_failed", "HTTP request failed", e, {
        method,
        path: url.pathname,
        status,
        request_id: correlationHeader(req.headers["x-request-id"]),
        correlation_id: correlationHeader(req.headers["x-correlation-id"]),
      });
    }
    return send(res, status, body);
  }
}
