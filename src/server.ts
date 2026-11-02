import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { startPolling } from "./work.ts";
import { loadToken } from "./hasakiAuth.ts";
import { seedTemplates } from "./workflow/definitions.ts";
import { registerDefaultExecutors } from "./workflow/executors/index.ts";
import { startScheduler } from "./workflow/scheduler.ts";
import { syncRepositoriesFromConfig } from "./repos/service.ts";
import { seedKnowledge } from "./knowledge/service.ts";
import { errorStatus, HttpError, routes } from "./api/routes.ts";

const publicDir = join(import.meta.dirname, "..", "public");
const STATIC: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/app.css": "app.css" };
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };

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
  const file = req.method === "GET" ? STATIC[url.pathname] : undefined;
  if (file && existsSync(join(publicDir, file))) {
    res.writeHead(200, { "Content-Type": TYPES[file.split(".").pop()!], "Cache-Control": "no-cache" });
    return res.end(readFileSync(join(publicDir, file)));
  }
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
await loadToken();
registerDefaultExecutors();
// Durable scheduler: in-flight work resumes from PostgreSQL (expired leases are reaped and retried).
const scheduler = startScheduler();
startPolling();

// No auth on this API, so listen on loopback only (set HOST=0.0.0.0 to expose deliberately).
const server = createServer(handle).listen(config.port, process.env.HOST ?? "127.0.0.1", () => console.log(`workflow platform on ${config.publicUrl}`));

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    console.log(`${sig}: stopping workers (in-flight attempts finish or are reaped after their lease)`);
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
    await scheduler.stop();
    process.exit(0);
  });
