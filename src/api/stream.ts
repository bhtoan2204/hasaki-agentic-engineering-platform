import { HttpError } from "../http/error.ts";
import { positiveId } from "../http/params.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "../db/pool.ts";
import { listening, subscribe, type Unsubscribe } from "../db/listener.ts";
import { sessionFromRequest } from "../auth/sessions.ts";
import type { Actor } from "../authz/access.ts";
import { log } from "../logging.ts";
import { ignoreError } from "../ignoreError.ts";

/**
 * Server-Sent Events relay for LISTEN/NOTIFY on `workflow_events` (migration 005). Each subscriber is authenticated,
 * and payloads are filtered by the viewer's access before they are written. A revoked session closes the stream.
 *
 * Every event carries its `workflow_events.id` as the SSE `id:`, so the table itself is the replay log:
 *  - the browser's automatic reconnect sends `Last-Event-ID`; a manual reopen passes `?after=<id>`;
 *  - the gap is replayed from the table (owner-scoped) before live events resume, without duplicates;
 *  - a gap larger than REPLAY_LIMIT is not replayed: `hello.reset` tells the client to reload its views instead;
 *  - `GET /api/events?after=<id>` returns the same slice for the client's polling fallback.
 * Payloads are only ids and the kind (never content): clients fetch what they show through the REST API.
 */
export type LivePayload = {
  id: number;
  run_id: number;
  step_id: number | null;
  attempt_id: number | null;
  kind: string;
};
type Client = {
  res: ServerResponse;
  runId: number | null;
  userId: number;
  role: Actor["role"];
  support: boolean;
  /** Live events queued while the backlog is being replayed (null once live). */
  queued: LivePayload[] | null;
  sent: Set<number>;
  /** Newest event id this client has been brought up to (replay point after a listener outage). */
  cursor: number | null;
};
const clients = new Set<Client>();
let unsubscribe: Unsubscribe | null = null;
let stopped = false;

export const REPLAY_LIMIT = 500;
/** Ids remembered per client to drop a live event that the replay already delivered. */
const SENT_MEMORY = 1000;

/** A run's owner never changes once set (legacy claiming only fills NULL), so a non-null owner is cached. */
const owners = new Map<number, number>();
async function ownerOf(runId: number): Promise<number | null> {
  const hit = owners.get(runId);
  if (hit != null) return hit;
  const row = (await pool.query("SELECT owner_id FROM workflow_runs WHERE id = $1", [runId]))
    .rows[0];
  const ownerId = row?.owner_id == null ? null : Number(row.owner_id);
  if (ownerId != null) {
    if (owners.size >= 5000) owners.clear();
    owners.set(runId, ownerId);
  }
  return ownerId;
}

function visible(
  client: Pick<Client, "runId" | "userId" | "role" | "support">,
  runId: number,
  ownerId: number | null,
) {
  if (client.runId !== null && client.runId !== runId) return false;
  if (ownerId == null) return false;
  if (ownerId === client.userId) return true;
  return client.support && client.role === "admin";
}

function send(client: Client, p: LivePayload) {
  if (client.sent.has(p.id)) return;
  client.sent.add(p.id);
  client.cursor = Math.max(client.cursor ?? 0, p.id);
  if (client.sent.size > SENT_MEMORY) client.sent.delete(client.sent.values().next().value!);
  client.res.write(`id: ${p.id}\nevent: change\ndata: ${JSON.stringify(p)}\n\n`);
}

/** Deliveries run strictly in NOTIFY order: a cold owner lookup for one event must not let a later event overtake it. */
let deliveries: Promise<void> = Promise.resolve();
/** One owner lookup per notification at most (cached), never one per subscriber. */
function fanOut(p: LivePayload) {
  if (!clients.size) return;
  const owner = ownerOf(p.run_id); // starts now, so lookups overlap; only the delivery below is ordered
  owner.catch(ignoreError("event_stream.owner_lookup")); // reported by the chain below
  deliveries = deliveries
    .then(async () => {
      const ownerId = await owner;
      for (const cl of clients) {
        if (!visible(cl, p.run_id, ownerId)) continue;
        if (cl.queued) cl.queued.push(p);
        else send(cl, p);
      }
    })
    .catch((e) => log.error("event stream fan-out:", (e as Error).message));
}

/**
 * Events after `afterId` that this viewer may see, oldest first. `reset` means the gap is larger than `limit`:
 * the caller must reload its views instead of applying events. `cursor` is the newest event id at query time.
 */
export async function eventsSince(
  viewer: { userId: number; role: Actor["role"]; support: boolean; runId: number | null },
  afterId: number,
  limit = REPLAY_LIMIT,
): Promise<{ events: LivePayload[]; reset: boolean; cursor: number }> {
  const all = viewer.support && viewer.role === "admin";
  // Snapshot first, then read up to it: an event committed during the read is left for the next call, never skipped.
  const cursor = await latestEventId();
  const rows = (
    await pool.query(
      `SELECT e.id, e.run_id, e.step_id, e.attempt_id, e.kind
         FROM workflow_events e JOIN workflow_runs r ON r.id = e.run_id
        WHERE e.id > $1 AND e.id <= $2 AND r.owner_id IS NOT NULL AND ($3::boolean OR r.owner_id = $4)
          AND ($5::bigint IS NULL OR e.run_id = $5)
        ORDER BY e.id LIMIT $6`,
      [afterId, cursor, all, viewer.userId, viewer.runId, limit + 1],
    )
  ).rows.map((r) => ({
    id: Number(r.id),
    run_id: Number(r.run_id),
    step_id: r.step_id == null ? null : Number(r.step_id),
    attempt_id: r.attempt_id == null ? null : Number(r.attempt_id),
    kind: r.kind,
  }));
  if (rows.length > limit) return { events: [], reset: true, cursor };
  return { events: rows, reset: false, cursor: Math.max(cursor, afterId) };
}

async function latestEventId() {
  return Number(
    (await pool.query("SELECT COALESCE(max(id), 0) AS id FROM workflow_events")).rows[0].id,
  );
}

function hello(client: Client, info: Record<string, unknown>) {
  client.res.write(
    `retry: 3000\nevent: hello\ndata: ${JSON.stringify({ live: listening("workflow_events"), ...info })}\n\n`,
  );
}

/** Replay what `client` missed after `afterId`, then switch it to live delivery (queued live events after the replay). */
async function catchUp(client: Client, afterId: number | null) {
  client.queued = [];
  try {
    if (afterId == null) {
      const cursor = await latestEventId();
      client.cursor = Math.max(client.cursor ?? 0, cursor);
      hello(client, { cursor });
    } else {
      const { events, reset, cursor } = await eventsSince(client, afterId);
      for (const p of events) send(client, p);
      client.cursor = Math.max(client.cursor ?? 0, cursor);
      hello(client, { cursor, replayed: events.length, reset });
    }
  } finally {
    const queued = client.queued ?? [];
    client.queued = null;
    // Everything up to the cursor was replayed, or is covered by a reset: a late NOTIFY for it must not stream again.
    const floor = client.cursor ?? 0;
    for (const p of queued) if (p.id > floor) send(client, p);
  }
}

function onNotify(payload: string) {
  let p: LivePayload;
  try {
    const raw = JSON.parse(payload);
    if (raw.run_id == null || raw.id == null) return;
    p = {
      id: Number(raw.id),
      run_id: Number(raw.run_id),
      step_id: raw.step_id ?? null,
      attempt_id: raw.attempt_id ?? null,
      kind: String(raw.kind),
    };
  } catch {
    return;
  }
  fanOut(p);
}

export async function startEventStream() {
  stopped = false;
  await unsubscribe?.();
  unsubscribe = subscribe(
    "workflow_events",
    onNotify,
    () => {
      // Notifications sent while LISTEN was down are lost; replay them to every client from what it last saw.
      for (const cl of clients)
        catchUp(cl, cl.cursor).catch((e) => log.error("event stream resync:", e.message));
    },
    () => {
      // Connected browsers keep the stream but must not trust it for now: they switch to their polling fallback.
      if (!stopped) for (const cl of clients) hello(cl, { live: false });
    },
  );
  await unsubscribe.ready;
}

/** Tests and shutdown: stop listening and close every open stream. */
export async function stopEventStream() {
  stopped = true;
  for (const cl of clients) cl.res.end();
  clients.clear();
  owners.clear();
  const u = unsubscribe;
  unsubscribe = null;
  await u?.();
}

function cursorParam(raw: string | string[] | null | undefined): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

async function runAllowed(runId: number, actor: Actor, support: boolean) {
  const ownerId = await ownerOf(runId);
  return visible({ runId, userId: actor.id, role: actor.role, support }, runId, ownerId);
}

export async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  actor: Actor,
  support: boolean,
) {
  // Registered before any await: a disconnect during the access check must be seen, or the client would be added to a
  // dead connection afterwards and keep its ping timer forever.
  let closed = false;
  let ping: ReturnType<typeof setInterval> | null = null;
  let client: Client | null = null;
  const release = () => {
    closed = true;
    if (ping) clearInterval(ping);
    if (client) clients.delete(client);
  };
  req.on("close", release);
  const filter = url.searchParams.get("run_id");
  const runId = filter ? positiveId(filter, "run_id") : null;
  if (runId != null && !(await runAllowed(runId, actor, support)))
    throw new HttpError(404, "not found");
  if (closed) return;
  // The browser's own reconnect sends Last-Event-ID (newest); a reopened stream passes ?after=.
  const after =
    cursorParam(req.headers["last-event-id"]) ?? cursorParam(url.searchParams.get("after"));
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const self: Client = {
    res,
    runId,
    userId: actor.id,
    role: actor.role,
    support,
    queued: [],
    sent: new Set(),
    cursor: after,
  };
  client = self;
  clients.add(self);
  ping = setInterval(() => {
    sessionFromRequest(req)
      .then((session) => {
        if (!session || session.id !== actor.id) {
          release();
          res.end();
          return;
        }
        res.write(": ping\n\n");
      })
      // A database hiccup (e.g. a connection timeout over VPN) must not become an unhandled rejection: that would
      // terminate the whole server and every step running in it. Keep the stream; the next ping re-checks the session.
      .catch((e) => {
        log.error("event stream session check:", (e as Error).message);
        res.write(": ping\n\n");
      });
  }, 20_000);
  try {
    await catchUp(self, after);
  } catch (e) {
    log.error("event stream replay:", (e as Error).message);
    hello(self, { reset: true });
  }
}

/** Polling fallback: `GET /api/events?after=<id>[&run_id=]` → `{ events, reset, cursor }`, same filtering as the stream. */
export async function handleEventsSince(url: URL, actor: Actor, support: boolean) {
  const filter = url.searchParams.get("run_id");
  const runId = filter ? positiveId(filter, "run_id") : null;
  if (runId != null && !(await runAllowed(runId, actor, support))) return null;
  const after = cursorParam(url.searchParams.get("after"));
  if (after == null) return { events: [], reset: true, cursor: await latestEventId() };
  return eventsSince({ userId: actor.id, role: actor.role, support, runId }, after);
}

/** Open streams (for tests and diagnostics). */
export const streamClientCount = () => clients.size;
