import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { pool } from "../db/pool.ts";
import { execution } from "../auth/execution.ts";
import { loadPersonalIntegrations } from "../integrations/loadPersonal.ts";
import { errorStatus, routes } from "../api/routes.ts";
import { claimIdempotency, needsIdempotency } from "./idempotency.ts";
import { singleflight } from "../cache/index.ts";
import { HttpError } from "./error.ts";
import { messages as uiMessages } from "../../web/src/i18n/messages.ts";
import { handleStream } from "../api/stream.ts";
import { clearSessionCookie, csrfOk, login, logout, sessionFromRequest, setSessionCookie } from "../auth/sessions.ts";
import { setPassword } from "../auth/users.ts";
import { wantsSupport } from "../authz/access.ts";

const webDist = join(import.meta.dirname, "..", "..", "web", "dist");
const publicDir = join(import.meta.dirname, "..", "..", "public");
const CLASSIC: Record<string, string> = { "/classic": "index.html", "/classic/": "index.html", "/app.js": "app.js" };
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

function serveFile(res: ServerResponse, file: string, cache = "no-cache") {
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": cache });
  res.end(readFileSync(file));
}

function serveStatic(url: URL, res: ServerResponse) {
  if (CLASSIC[url.pathname]) return serveFile(res, join(publicDir, CLASSIC[url.pathname])), true;
  if (url.pathname.startsWith("/api/")) return false;
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  const file = join(webDist, rel);
  if (rel && file.startsWith(webDist) && existsSync(file) && statSync(file).isFile())
    return serveFile(res, file, rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache"), true;
  const index = join(webDist, "index.html");
  if (existsSync(index)) return serveFile(res, index), true;
  res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" }).end("UI not built yet: run `npm run build` (npm start does it automatically).");
  return true;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function send(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extra });
  res.end(JSON.stringify(body));
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const method = req.method ?? "GET";
  const key = `${method} ${url.pathname}`;
  try {
    if (key === "GET /api/health") return send(res, 200, { ok: true });
    if (key === "GET /api/ui-messages") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(JSON.stringify(uiMessages));
    }
    if (key === "GET /api/auth/status") {
      const result = await pool.query("SELECT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND active) AS ready");
      return send(res, 200, { bootstrapRequired: !result.rows[0].ready }, { "Cache-Control": "no-store" });
    }
    if (key === "POST /api/auth/login") {
      const body = await readJson(req);
      try {
        const result = await login(String(body.username ?? ""), String(body.password ?? ""), req);
        setSessionCookie(res, req, result.token);
        return send(res, 200, { user: { id: result.user.id, username: result.user.username, role: result.user.role }, csrf: result.user.csrf });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 401;
        return send(res, status, { error: (e as Error).message });
      }
    }
    if (method === "GET" && !url.pathname.startsWith("/api/") && serveStatic(url, res)) return;

    const actor = await sessionFromRequest(req);
    if (!actor) return send(res, 401, { error: "authentication required" });
    if (method !== "GET" && method !== "HEAD" && !csrfOk(req, actor.csrf)) return send(res, 403, { error: "CSRF check failed" });

    if (key === "GET /api/auth/me") return send(res, 200, { user: { id: actor.id, username: actor.username, role: actor.role }, csrf: actor.csrf });
    if (key === "POST /api/auth/logout") {
      await logout(req);
      clearSessionCookie(res, req);
      return send(res, 200, { ok: true });
    }
    if (key === "POST /api/auth/password") {
      const body = await readJson(req);
      await setPassword(actor.id, String(body.password ?? ""));
      await logout(req);
      clearSessionCookie(res, req);
      return send(res, 200, { ok: true });
    }

    if (method === "GET" && url.pathname === "/api/stream") {
      return handleStream(req, res, url, actor, wantsSupport(actor, url.searchParams.get("scope")));
    }
    const raw = method === "GET" && url.pathname.match(/^\/api\/artifacts\/(\d+)\/raw$/);
    if (raw) {
      const { requireArtifact } = await import("../authz/access.ts");
      await requireArtifact(actor, Number(raw[1]), wantsSupport(actor, url.searchParams.get("scope")));
      const a = (await pool.query("SELECT name, content, data FROM workflow_artifacts WHERE id = $1", [Number(raw[1])])).rows[0];
      if (!a) return res.writeHead(404).end();
      const bin = a.data?.encoding === "base64";
      res.writeHead(200, {
        "Content-Type": bin ? a.data.mime : "text/plain; charset=utf-8",
        "Content-Disposition": `inline; filename="${String(a.name).replace(/"/g, "")}"`,
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(bin ? Buffer.from(a.content, "base64") : a.content);
    }

    for (const [routeMethod, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (!m || routeMethod !== method) continue;
      const body = method === "POST" ? await readJson(req) : {};
      // Create-type POSTs with an Idempotency-Key: a repeat replays the first response instead of creating twice.
      const idemKey = req.headers["idempotency-key"];
      const claim = typeof idemKey === "string" && needsIdempotency(method, url.pathname) ? await claimIdempotency(actor.id, idemKey, url.pathname, body) : null;
      if (claim && claim.kind !== "run") return send(res, claim.status, claim.body, claim.kind === "replay" ? { "Idempotent-Replayed": "true" } : undefined);
      try {
        const ctx = { p: m.slice(1).map((s) => decodeURIComponent(s ?? "")), body, url, actor };
        // Identical concurrent GETs of one user (every open tab refetches on the same live event) share one execution.
        const execute = () => execution.run({ userId: actor.id, kind: "user" }, async () => {
          if (/^\/api\/(integrations|prod-errors)/.test(url.pathname)) await loadPersonalIntegrations();
          return handler(ctx);
        });
        const out = method === "GET" ? await singleflight(`${actor.id} ${url.pathname}${url.search}`, execute) : await execute();
        if (claim) await claim.finish(200, out ?? null);
        return send(res, 200, out ?? null);
      } catch (e) {
        if (claim) await claim.finish(errorStatus(e), { error: (e as Error).message, details: (e as { errors?: unknown }).errors }).catch(() => claim.release().catch(() => {}));
        throw e;
      }
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    if (res.headersSent) return;
    const status = errorStatus(e);
    if (status >= 500) console.error(e);
    return send(res, status, { error: (e as Error).message, details: (e as { errors?: unknown }).errors });
  }
}
