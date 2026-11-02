import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { config } from "../config.ts";

/**
 * Server-Sent Events relay for LISTEN/NOTIFY on `workflow_events` (see migration 005). Browsers subscribe to one run
 * (`?run_id=`) or to everything; each notification is forwarded as `event: change` so the UI refetches real data.
 */
type Client = { res: ServerResponse; runId: number | null };
const clients = new Set<Client>();
let listener: pg.Client | null = null;

export async function startEventStream() {
  const connect = async () => {
    const c = new pg.Client({ connectionString: config.databaseUrl });
    c.on("notification", (n) => {
      if (!n.payload) return;
      let runId: number | null = null;
      try {
        runId = JSON.parse(n.payload).run_id ?? null;
      } catch {}
      for (const cl of clients) if (cl.runId === null || cl.runId === runId) cl.res.write(`event: change\ndata: ${n.payload}\n\n`);
    });
    c.on("error", (e) => {
      console.error("event stream listener:", e.message);
      listener = null;
      setTimeout(() => connect().catch(() => {}), 2000);
    });
    await c.connect();
    await c.query("LISTEN workflow_events");
    listener = c;
  };
  await connect();
}

export function handleStream(req: IncomingMessage, res: ServerResponse, url: URL) {
  const runId = url.searchParams.get("run_id") ? Number(url.searchParams.get("run_id")) : null;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`event: hello\ndata: ${JSON.stringify({ live: !!listener })}\n\n`);
  const client = { res, runId };
  clients.add(client);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(client);
  });
}
