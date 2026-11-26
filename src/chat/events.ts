import type { IncomingMessage, ServerResponse } from "node:http";
import { listening, subscribe, type Unsubscribe } from "../db/listener.ts";
import { sessionFromRequest } from "../auth/sessions.ts";
import type { Actor } from "../authz/access.ts";
import { chatRepository } from "./repository.ts";
import type { ChatEventKind, EventRow } from "./types.ts";
import { log } from "../logging.ts";
import { ignoreError } from "../ignoreError.ts";

/**
 * Chat stream. Events live in `chat_events` (bounded payloads, one row per lifecycle step — never per token) and are
 * announced with NOTIFY chat_events. A subscriber is one owner watching one conversation: the stream is authorized
 * by conversation ownership, never by a workflow run id. The SSE id is the event id, so a reconnect with
 * Last-Event-ID (or ?after=) replays exactly the missed events without duplicates.
 */
type Client = {
  res: ServerResponse;
  conversationId: number;
  ownerId: number;
  cursor: number;
  queued: EventRow[] | null;
};
const clients = new Set<Client>();
let unsubscribe: Unsubscribe | null = null;
const holders = new Set<object>();
const REPLAY_LIMIT = 500;

/** Open chat streams (for tests and diagnostics). */
export const chatStreamClientCount = () => clients.size;

export async function emitChatEvent(input: {
  conversationId: number;
  ownerId: number;
  turnId: number | null;
  kind: ChatEventKind;
  data?: Record<string, unknown>;
}) {
  return chatRepository.insertEvent({ ...input, data: input.data ?? {} });
}

function write(client: Client, e: EventRow) {
  if (e.id <= client.cursor) return;
  client.cursor = e.id;
  client.res.write(
    `id: ${e.id}\nevent: chat\ndata: ${JSON.stringify({ id: e.id, turn_id: e.turn_id, kind: e.kind, data: e.data, created_at: e.created_at })}\n\n`,
  );
}

/**
 * Deliveries run strictly in NOTIFY order. Each event's row is fetched as soon as it is announced (fetches overlap), but
 * it is written only after every earlier event: `write` drops ids at or below the cursor, so a later event whose fetch
 * finished first would otherwise make the earlier one vanish from a live stream until the next reconnect.
 */
let deliveries: Promise<void> = Promise.resolve();
function fanOut(raw: { id: number; conversation_id: number; owner_id: number }) {
  const targets = [...clients].filter(
    (c) => c.conversationId === raw.conversation_id && c.ownerId === raw.owner_id,
  );
  if (!targets.length) return;
  const fetched = chatRepository.getEvent(raw.id);
  fetched.catch(ignoreError("chat_stream.event_fetch")); // reported by the chain below
  deliveries = deliveries
    .then(async () => {
      const row = await fetched;
      if (!row) return;
      for (const c of targets) {
        if (!clients.has(c)) continue;
        if (c.queued) c.queued.push(row);
        else write(c, row);
      }
    })
    .catch((e) => log.error("chat stream fan-out:", (e as Error).message));
}

function onNotify(payload: string) {
  try {
    const raw = JSON.parse(payload);
    fanOut({
      id: Number(raw.id),
      conversation_id: Number(raw.conversation_id),
      owner_id: Number(raw.owner_id),
    });
  } catch {
    /* malformed payload */
  }
}

/**
 * Lazy: chat_events is LISTENed (on the shared listener) only while a stream on this instance holds it; the last
 * holder to leave UNLISTENs it.
 */
function holdListener(holder: object) {
  holders.add(holder);
  unsubscribe ??= subscribe("chat_events", onNotify, () => {
    // Notifications sent while LISTEN was down are lost: replay each client from its cursor.
    for (const cl of clients) void catchUp(cl).catch(ignoreError("chat_stream.catch_up"));
  });
  return listening("chat_events") ? Promise.resolve() : unsubscribe.ready;
}

function releaseListener(holder: object) {
  if (!holders.delete(holder) || holders.size || !unsubscribe) return;
  const u = unsubscribe;
  unsubscribe = null;
  void u().catch(ignoreError("chat_stream.unlisten"));
}

export async function stopChatStream() {
  for (const c of clients) c.res.end();
  clients.clear();
  holders.clear();
  const u = unsubscribe;
  unsubscribe = null;
  await u?.();
}

async function catchUp(client: Client) {
  client.queued = [];
  try {
    let reset = false;
    const rows = await chatRepository.eventsAfter(
      client.conversationId,
      client.ownerId,
      client.cursor,
      REPLAY_LIMIT + 1,
    );
    if (rows.length > REPLAY_LIMIT) {
      reset = true;
      client.cursor =
        (await chatRepository.latestEventId(client.conversationId))?.id ?? client.cursor;
    } else for (const r of rows) write(client, r);
    client.res.write(
      `retry: 3000\nevent: hello\ndata: ${JSON.stringify({ live: listening("chat_events"), cursor: client.cursor, replayed: reset ? 0 : rows.length, reset })}\n\n`,
    );
  } finally {
    const queued = client.queued ?? [];
    client.queued = null;
    for (const e of queued) write(client, e);
  }
}

function cursorParam(raw: string | string[] | null | undefined): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** GET /api/chat/conversations/:id/events — owner only; 404 for anything else (existence is not revealed). */
export async function handleChatStream(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  actor: Actor,
  conversationId: number,
) {
  const conversation = await chatRepository.getConversation(conversationId, actor.id);
  if (!conversation) {
    res
      .writeHead(404, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "not found" }));
    return;
  }
  // Registered before any await: a disconnect while the stream is set up must be seen (see api/stream.ts).
  let closed = false;
  let ping: ReturnType<typeof setInterval> | null = null;
  let client: Client | null = null;
  const holder = {};
  const release = () => {
    closed = true;
    if (ping) clearInterval(ping);
    if (client) clients.delete(client);
    releaseListener(holder);
  };
  req.on("close", release);
  const after =
    cursorParam(req.headers["last-event-id"]) ?? cursorParam(url.searchParams.get("after"));
  await holdListener(holder).catch((e) => log.error("chat stream listen:", (e as Error).message));
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const cursor = after ?? (await chatRepository.latestEventId(conversationId))?.id ?? 0;
  if (closed) return;
  const self: Client = { res, conversationId, ownerId: actor.id, cursor, queued: [] };
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
      .catch(() => res.write(": ping\n\n"));
  }, 20_000);
  await catchUp(self);
}

/** Polling fallback with the same filtering: events after a cursor for one owned conversation. */
export async function chatEventsSince(conversationId: number, ownerId: number, after: number) {
  const rows = await chatRepository.eventsAfter(conversationId, ownerId, after, REPLAY_LIMIT + 1);
  if (rows.length > REPLAY_LIMIT)
    return {
      events: [],
      reset: true,
      cursor: (await chatRepository.latestEventId(conversationId))?.id ?? after,
    };
  return { events: rows, reset: false, cursor: rows.at(-1)?.id ?? after };
}
