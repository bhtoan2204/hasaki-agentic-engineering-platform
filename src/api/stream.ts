import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { config } from "../config.ts";
import { pool } from "../db/pool.ts";
import { sessionFromRequest } from "../auth/sessions.ts";
import type { Actor } from "../authz/access.ts";

/**
 * Server-Sent Events relay for LISTEN/NOTIFY on `workflow_events`. Each subscriber is authenticated.
 * Payloads are filtered by the viewer's access before they are written. A revoked session closes the stream.
 */
type Client = { res: ServerResponse; runId: number | null; userId: number; role: Actor["role"]; support: boolean };
const clients = new Set<Client>();
let listener: pg.Client | null = null;

async function visible(client: Client, runId: number | null) {
  if (client.runId !== null && client.runId !== runId) return false;
  if (runId == null) return false;
  const row = (await pool.query("SELECT owner_id FROM workflow_runs WHERE id = $1", [runId])).rows[0];
  const ownerId = row?.owner_id == null ? null : Number(row.owner_id);
  if (ownerId == null) return false;
  if (ownerId === client.userId) return true;
  return client.support && client.role === "admin";
}

export async function startEventStream() {
  const connect = async () => {
    const c = new pg.Client({ connectionString: config.databaseUrl });
    c.on("notification", (n) => {
      if (!n.payload) return;
      let runId: number | null = null;
      try {
        runId = JSON.parse(n.payload).run_id ?? null;
      } catch {
        return;
      }
      for (const cl of clients) {
        void visible(cl, runId).then((ok) => {
          if (ok) cl.res.write(`event: change\ndata: ${n.payload}\n\n`);
        });
      }
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

export async function handleStream(req: IncomingMessage, res: ServerResponse, url: URL, actor: Actor, support: boolean) {
  const runId = url.searchParams.get("run_id") ? Number(url.searchParams.get("run_id")) : null;
  if (runId != null) {
    const row = (await pool.query("SELECT owner_id FROM workflow_runs WHERE id = $1", [runId])).rows[0];
    const ownerId = row?.owner_id == null ? null : Number(row.owner_id);
    const allowed = ownerId != null && (ownerId === actor.id || (support && actor.role === "admin"));
    if (!allowed) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`event: hello\ndata: ${JSON.stringify({ live: !!listener })}\n\n`);
  const client: Client = { res, runId, userId: actor.id, role: actor.role, support };
  clients.add(client);
  const ping = setInterval(() => {
    void sessionFromRequest(req).then((session) => {
      if (!session || session.id !== actor.id) {
        clearInterval(ping);
        clients.delete(client);
        res.end();
        return;
      }
      res.write(": ping\n\n");
    });
  }, 20_000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(client);
  });
}
