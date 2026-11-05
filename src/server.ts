import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { startPolling } from "./work.ts";
import { loadToken } from "./hasakiAuth.ts";
import { loadArgoToken } from "./integrations/argocd.ts";
import { loadSplunkCookie } from "./integrations/splunk.ts";
import { loadKafkaCookie } from "./integrations/kafka.ts";
import { loadAccountSettings } from "./integrations/accounts.ts";
import { loadVaultToken } from "./integrations/vault.ts";
import { seedTemplates } from "./workflow/definitions.ts";
import { registerDefaultExecutors } from "./workflow/executors/index.ts";
import { startScheduler } from "./workflow/scheduler.ts";
import { syncRepositoriesFromConfig } from "./repos/service.ts";
import { seedKnowledge } from "./knowledge/service.ts";
import { errorStatus, HttpError, routes } from "./api/routes.ts";
import { handleStream, startEventStream } from "./api/stream.ts";
import { childGroups } from "./workflow/local.ts";
import { pool } from "./db/pool.ts";

// The React app (web/, built by `npm run build`, which `npm start` runs first) is served from web/dist.
// The previous vanilla UI stays available at /classic while it is phased out.
const webDist = join(import.meta.dirname, "..", "web", "dist");
const publicDir = join(import.meta.dirname, "..", "public");
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

/** Static files for GET requests outside /api. Returns false when nothing matched. */
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

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/api/stream") return handleStream(req, res, url);
  // Raw evidence files (images/PDF) for preview/download.
  const raw = req.method === "GET" && url.pathname.match(/^\/api\/artifacts\/(\d+)\/raw$/);
  if (raw) {
    const a = (await pool.query("SELECT name, content, data FROM workflow_artifacts WHERE id = $1", [Number(raw[1])])).rows[0];
    if (!a) return res.writeHead(404).end();
    const bin = a.data?.encoding === "base64";
    res.writeHead(200, { "Content-Type": bin ? a.data.mime : "text/plain; charset=utf-8", "Content-Disposition": `inline; filename="${String(a.name).replace(/"/g, "")}"`, "X-Content-Type-Options": "nosniff" });
    return res.end(bin ? Buffer.from(a.content, "base64") : a.content);
  }
  if (req.method === "GET" && serveStatic(url, res)) return;
  for (const [method, pattern, handler] of routes) {
    const m = url.pathname.match(pattern);
    if (!m || method !== req.method) continue;
    try {
      const body = method === "POST" ? await readJson(req) : {};
      const out = await handler({ p: m.slice(1).map((s) => decodeURIComponent(s ?? "")), body, url });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(out ?? null));
    } catch (e) {
      const status = errorStatus(e);
      if (status >= 500) console.error(e);
      res.writeHead(status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: (e as Error).message, details: (e as any).errors }));
    }
  }
  res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
}

const applied = await migrate();
if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
await seedTemplates();
await syncRepositoriesFromConfig();
await seedKnowledge();
await loadAccountSettings();
await loadToken();
await loadArgoToken();
await loadSplunkCookie();
await loadKafkaCookie();
await loadVaultToken();
registerDefaultExecutors();
await startEventStream();
// Durable scheduler: in-flight work resumes from PostgreSQL (expired leases are reaped and retried).
const scheduler = startScheduler();
startPolling();

// No auth on this API, so listen on loopback only (set HOST=0.0.0.0 to expose deliberately).
const server = createServer(handle).listen(config.port, process.env.HOST ?? "127.0.0.1", () => console.log(`workflow platform on ${config.publicUrl}`));

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    console.log(`${sig}: stopping workers (in-flight attempts finish or are reaped after their lease)`);
    server.close();
    childGroups.killAll(); // detached command process groups (go test, ...) would otherwise outlive the server
    setTimeout(() => process.exit(0), 3000).unref();
    await scheduler.stop();
    process.exit(0);
  });
