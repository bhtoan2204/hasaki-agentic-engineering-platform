import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import {
  configureListener,
  listening,
  subscribe,
  type ListenerClient,
} from "../src/db/listener.ts";

/** The shared LISTEN connection, driven through fake clients (no database). */
class FakeClient extends EventEmitter {
  queries: string[] = [];
  ended = false;
  failConnect = false;
  gate: Promise<void> | null = null;
  async connect() {
    await this.gate;
    if (this.failConnect) throw new Error("connect refused");
  }
  async query(sql: string) {
    this.queries.push(sql);
    return {} as never;
  }
  async end() {
    this.ended = true;
  }
}
const clients: FakeClient[] = [];
const next: Partial<FakeClient>[] = [];
configureListener("fake://", () => {
  const c = Object.assign(new FakeClient(), next.shift() ?? {});
  clients.push(c);
  return c as unknown as ListenerClient;
});
const quiet = async (fn: () => unknown) => {
  const original = console.error;
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.error = original;
  }
};
const notify = (c: FakeClient, channel: string, payload: string) =>
  c.emit("notification", { channel, payload });

test("one connection for every channel; notifications reach only that channel's subscribers", async () => {
  clients.length = 0;
  const got: string[] = [];
  const a = subscribe("chan_a", (p) => got.push(`a1:${p}`));
  const a2 = subscribe("chan_a", (p) => got.push(`a2:${p}`));
  const b = subscribe("chan_b", (p) => got.push(`b:${p}`));
  await Promise.all([a.ready, a2.ready, b.ready]);
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0].queries, ["LISTEN chan_a", "LISTEN chan_b"]);
  notify(clients[0], "chan_a", "x");
  notify(clients[0], "chan_b", "y");
  notify(clients[0], "chan_c", "z");
  assert.deepEqual(got, ["a1:x", "a2:x", "b:y"]);
  await Promise.all([a(), a2(), b()]);
  assert.equal(clients[0].ended, true, "the last unsubscribe closes the connection");
});

test("a forced disconnect re-LISTENs every channel and fires each onReconnect once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  clients.length = 0;
  const events: string[] = [];
  const subs = ["chan_a", "chan_b"].map((ch) =>
    subscribe(
      ch,
      () => {},
      () => events.push(`reconnect:${ch}`),
      () => events.push(`lost:${ch}`),
    ),
  );
  await Promise.all(subs.map((s) => s.ready));
  await quiet(() => {
    clients[0].emit("error", new Error("terminated"));
    clients[0].emit("error", new Error("connection lost"));
    clients[0].emit("end");
  });
  assert.deepEqual(events, ["lost:chan_a", "lost:chan_b"], "one outage, reported once");
  assert.equal(listening("chan_a"), false);
  next.push({ failConnect: true });
  await quiet(async () => {
    t.mock.timers.tick(1000);
    await setImmediate();
  });
  assert.equal(clients.length, 2, "first reconnect attempt failed");
  t.mock.timers.tick(2000);
  await setImmediate();
  assert.equal(clients.length, 3);
  assert.deepEqual(clients[2].queries, ["LISTEN chan_a", "LISTEN chan_b"]);
  assert.deepEqual(events, [
    "lost:chan_a",
    "lost:chan_b",
    "lost:chan_a",
    "lost:chan_b",
    "reconnect:chan_a",
    "reconnect:chan_b",
  ]);
  assert.equal(listening("chan_a") && listening("chan_b"), true);
  notify(clients[0], "chan_a", "stale"); // the dead connection is ignored
  await Promise.all(subs.map((s) => s()));
});

test("a lazily subscribed channel is LISTENed only while subscribed", async () => {
  clients.length = 0;
  const base = subscribe("chan_base", () => {});
  await base.ready;
  const chat = subscribe("chat_events", () => {});
  await chat.ready;
  assert.equal(listening("chat_events"), true);
  await chat();
  assert.equal(listening("chat_events"), false);
  assert.deepEqual(clients[0].queries, [
    "LISTEN chan_base",
    "LISTEN chat_events",
    "UNLISTEN chat_events",
  ]);
  assert.equal(clients[0].ended, false, "other channels keep the connection");
  await base();
  assert.equal(clients[0].ended, true);
});

test("subscribing and unsubscribing during a reconnect converge to the subscribed channels", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  clients.length = 0;
  const base = subscribe("chan_base", () => {});
  await base.ready;
  let open!: () => void;
  next.push({ gate: new Promise<void>((r) => (open = r)) });
  await quiet(() => clients[0].emit("error", new Error("vpn drop")));
  t.mock.timers.tick(1000); // the reconnect is now waiting in connect()
  await setImmediate();
  const reconnects: string[] = [];
  const chat = subscribe(
    "chat_events",
    () => {},
    () => reconnects.push("chat"),
  );
  const gone = subscribe("chan_gone", () => {});
  const unsubscribed = gone();
  open();
  await Promise.all([chat.ready, unsubscribed]);
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[1].queries, ["LISTEN chan_base", "LISTEN chat_events"]);
  assert.equal(listening("chan_gone"), false);
  assert.deepEqual(reconnects, ["chat"]);
  await chat();
  await base();
  assert.equal(clients[1].ended, true);
});
