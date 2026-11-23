/**
 * SSE relays without real sockets or sleeps: fake request/response objects, real PostgreSQL LISTEN/NOTIFY. Every wait is
 * on an event (a frame written, a promise settled), never on a timer.
 *  - delivery order follows NOTIFY order even when the lookups behind two notifications finish out of order;
 *  - a client that disconnects while the handler is still setting up is never registered (no leaked client or timer).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pool, withTx } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser } from "../src/auth/users.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { runEvents } from "../src/workflow/events.ts";
import {
  startEventStream,
  stopEventStream,
  handleStream,
  streamClientCount,
} from "../src/api/stream.ts";
import { chatRepository } from "../src/chat/repository.ts";
import { handleChatStream, stopChatStream, chatStreamClientCount } from "../src/chat/events.ts";
import type { Actor } from "../src/authz/access.ts";
import type { EventRow } from "../src/chat/types.ts";

type Frame = { event: string; id?: number; data: Record<string, unknown> };
/** A request/response pair that records SSE frames and lets a test wait for one. */
function connection(headers: Record<string, string> = {}) {
  const req = Object.assign(new EventEmitter(), { headers }) as unknown as IncomingMessage;
  const frames: Frame[] = [];
  const waiters: Array<{ pred: () => boolean; resolve: () => void }> = [];
  const res = {
    writeHead() {
      return res;
    },
    write(chunk: string) {
      for (const block of String(chunk).split("\n\n")) {
        if (!block.trim() || block.startsWith(":")) continue;
        const f: Frame = { event: "message", data: {} };
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) f.event = line.slice(7);
          else if (line.startsWith("id: ")) f.id = Number(line.slice(4));
          else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
        }
        frames.push(f);
      }
      for (const w of [...waiters]) {
        if (!w.pred()) continue;
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
      return true;
    },
    end() {
      return res;
    },
  } as unknown as ServerResponse;
  const until = (pred: () => boolean) =>
    pred() ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ pred, resolve }));
  return {
    req,
    res,
    frames,
    until,
    ids: () => frames.filter((f) => f.event !== "hello").map((f) => f.id),
    hello: () => until(() => frames.some((f) => f.event === "hello")),
    close: () => req.emit("close"),
  };
}

let owner: Actor;
const actor = (id: number): Actor => ({ id, role: "member" }) as Actor;
const runs: number[] = [];

before(async () => {
  await migrate();
  owner = actor(
    (await createUser({ username: "sse-owner", password: "sse-owner-password", role: "member" }))
      .id,
  );
  await definitions.create({
    key: "sse-order",
    spec: { name: "SSE order", steps: [{ key: "only", type: "agent" }] },
  });
  for (let i = 0; i < 2; i++)
    runs.push(
      Number((await startRun({ definitionKey: "sse-order", ownerId: owner.id, start: false })).id),
    );
  await startEventStream();
});
after(async () => {
  await stopEventStream();
  await stopChatStream();
  await pool.end();
});

test(
  "run events are delivered in NOTIFY order even when one owner lookup is cold",
  { timeout: 8_000 },
  async () => {
    const [cold, warm] = runs;
    const c = connection();
    await handleStream(c.req, c.res, new URL("http://x/api/stream"), owner, false);
    // Warm the owner cache for one run only: its next event needs no database round trip, the other run's does.
    await runEvents.add(pool, warm, "status", "warm up", null);
    await c.until(() => c.ids().length === 1);
    // Same transaction → one burst of notifications, in id order: cold run first, warm run second.
    await withTx(async (db) => {
      await runEvents.add(db, cold, "status", "first", null);
      await runEvents.add(db, warm, "status", "second", null);
    });
    await c.until(() => c.ids().length === 3);
    const ids = c.ids() as number[];
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
      "ids never go backwards",
    );
    c.close();
  },
);

test(
  "a run stream whose client disconnects during the access check is never registered",
  { timeout: 8_000 },
  async () => {
    const fresh = Number(
      (await startRun({ definitionKey: "sse-order", ownerId: owner.id, start: false })).id,
    );
    const before = streamClientCount();
    const c = connection();
    const handled = handleStream(
      c.req,
      c.res,
      new URL(`http://x/api/stream?run_id=${fresh}`),
      owner,
      false,
    ).catch(() => {});
    c.close(); // while the run lookup is still in flight
    await handled;
    assert.equal(streamClientCount(), before);
  },
);

const chatEvent = (id: number): EventRow =>
  ({
    id,
    turn_id: null,
    kind: "phase.updated",
    data: {},
    created_at: new Date(0).toISOString(),
  }) as unknown as EventRow & {
    conversation_id: number;
    owner_id: number;
  };

test(
  "chat events reach a live client in order when their lookups finish out of order",
  { timeout: 8_000 },
  async (t) => {
    const conversationId = 424242;
    const gates = new Map<number, (row: EventRow | null) => void>();
    t.mock.method(chatRepository, "getConversation", async () => ({ id: conversationId }) as never);
    t.mock.method(chatRepository, "latestEventId", async () => ({ id: 0 }) as never);
    t.mock.method(chatRepository, "eventsAfter", async () => [] as never);
    t.mock.method(
      chatRepository,
      "getEvent",
      (id: number) => new Promise((r) => gates.set(id, r as never)) as never,
    );
    const c = connection();
    await handleChatStream(c.req, c.res, new URL("http://x/"), owner, conversationId);
    await c.hello();
    const notify = (id: number) =>
      pool.query("SELECT pg_notify('chat_events', $1)", [
        JSON.stringify({ id, conversation_id: conversationId, owner_id: owner.id }),
      ]);
    await notify(1);
    await notify(2);
    await until(() => gates.size === 2);
    gates.get(2)!(chatEvent(2)); // the later event's lookup answers first
    gates.get(1)!(chatEvent(1));
    await c.until(() => c.ids().length === 2);
    assert.deepEqual(c.ids(), [1, 2]);
    c.close();
  },
);

test(
  "a chat client that disconnects while the stream is being set up is never registered",
  { timeout: 8_000 },
  async (t) => {
    const conversationId = 424243;
    let release!: () => void;
    t.mock.method(chatRepository, "getConversation", async () => ({ id: conversationId }) as never);
    t.mock.method(chatRepository, "eventsAfter", async () => [] as never);
    t.mock.method(
      chatRepository,
      "latestEventId",
      () => new Promise((r) => (release = () => r({ id: 0 }))) as never,
    );
    const before = chatStreamClientCount();
    const c = connection();
    const handled = handleChatStream(c.req, c.res, new URL("http://x/"), owner, conversationId);
    await until(() => typeof release === "function");
    c.close();
    release();
    await handled;
    assert.equal(chatStreamClientCount(), before);
  },
);

/** Resolves when `pred` holds, re-checked on each macrotask-free microtask turn (no timers). */
async function until(pred: () => boolean) {
  for (let i = 0; i < 10_000 && !pred(); i++) await new Promise<void>((r) => setImmediate(r));
  assert.ok(pred(), "condition never became true");
}
