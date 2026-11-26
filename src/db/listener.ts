import pg from "pg";
import { config } from "../config.ts";
import { log } from "../logging.ts";
import { ignoreError } from "../ignoreError.ts";

/**
 * The one dedicated LISTEN connection of this process, shared by every channel (cache invalidation, run events, chat
 * events). It exists only while a channel has a subscriber. A lost connection is reconnected with backoff and every
 * channel is LISTENed again; notifications sent meanwhile are lost, so each subscriber's onLost/onReconnect runs its
 * own bypass/replay logic. Connect, LISTEN, UNLISTEN and close run one at a time (`reconcile`) against the channels
 * subscribed at that moment, so subscribing or unsubscribing during a reconnect converges to the right set.
 */
export type ListenerClient = Pick<pg.Client, "on" | "connect" | "query" | "end">;
export interface ListenerHandlers {
  onNotify: (payload: string) => void;
  /** After a lost connection is back and this channel is LISTENed again. */
  onReconnect?: () => void;
  /** The connection was lost (or could not be opened): notifications are being missed from now on. */
  onLost?: () => void;
}
export type Unsubscribe = (() => Promise<void>) & {
  /** Settles after the first attempt to LISTEN; rejects when it failed (a reconnect is then already scheduled). */
  ready: Promise<void>;
};

const defaultClient = (connectionString: string): ListenerClient =>
  // keepAlive: the connection is idle between notifications; without it a VPN/NAT hop can drop it silently.
  new pg.Client({ connectionString, keepAlive: true, keepAliveInitialDelayMillis: 30000 });
let factory = { connectionString: config.databaseUrl, make: defaultClient };

const subscribers = new Map<string, Set<ListenerHandlers>>();
const listened = new Set<string>();
let client: ListenerClient | null = null;
let connected = false;
let reconnecting = false;
let retryTimer: NodeJS.Timeout | null = null;
let retryMs = 1000;
let queue: Promise<void> = Promise.resolve();

/** Tests inject a fake client; applies from the next connection. */
export function configureListener(connectionString: string, make: (cs: string) => ListenerClient) {
  factory = { connectionString, make };
}

export const listening = (channel: string) => connected && listened.has(channel);

export function subscribe(
  channel: string,
  onNotify: ListenerHandlers["onNotify"],
  onReconnect?: ListenerHandlers["onReconnect"],
  onLost?: ListenerHandlers["onLost"],
): Unsubscribe {
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error(`invalid channel name: ${channel}`);
  const handlers: ListenerHandlers = { onNotify, onReconnect, onLost };
  let set = subscribers.get(channel);
  if (!set) subscribers.set(channel, (set = new Set()));
  set.add(handlers);
  const unsubscribe = (async () => {
    if (!set.delete(handlers)) return;
    if (!set.size && subscribers.get(channel) === set) subscribers.delete(channel);
    await reconcile().catch(ignoreError("db.listener_unsubscribe"));
  }) as Unsubscribe;
  unsubscribe.ready = reconcile();
  unsubscribe.ready.catch(ignoreError("db.listener_subscribe"));
  return unsubscribe;
}

function reconcile(): Promise<void> {
  const step = queue.then(apply);
  queue = step.catch(() => {});
  return step;
}

async function apply() {
  if (!subscribers.size) return close();
  if (!client) await connect();
  const c = client!;
  for (const channel of subscribers.keys())
    if (!listened.has(channel)) {
      await c.query(`LISTEN ${channel}`);
      if (client !== c) throw new Error("listener connection lost");
      listened.add(channel);
    }
  for (const channel of [...listened])
    if (!subscribers.has(channel)) {
      await c.query(`UNLISTEN ${channel}`);
      if (client !== c) throw new Error("listener connection lost");
      listened.delete(channel);
    }
  connected = true;
  retryMs = 1000;
  if (!reconnecting) return;
  reconnecting = false;
  for (const set of subscribers.values()) for (const h of set) safely(() => h.onReconnect?.());
}

async function connect() {
  const c = factory.make(factory.connectionString);
  client = c;
  listened.clear();
  c.on("notification", (n) => {
    if (client !== c || !n.payload) return;
    for (const h of subscribers.get(n.channel) ?? []) safely(() => h.onNotify(n.payload!));
  });
  // One broken connection can report several errors (terminated, then connection lost): handled once.
  c.on("error", (e) => lost(c, e.message));
  c.on("end", () => lost(c, "connection ended"));
  try {
    await c.connect();
  } catch (e) {
    lost(c, (e as Error).message);
    throw e;
  }
}

function lost(c: ListenerClient, why: string) {
  if (client !== c) return;
  client = null;
  connected = false;
  listened.clear();
  c.end().catch(ignoreError("db.listener_end"));
  if (!subscribers.size) return;
  log.error(`database listener lost (${why}); reconnecting`);
  reconnecting = true;
  for (const set of subscribers.values()) for (const h of set) safely(() => h.onLost?.());
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    reconcile().catch(ignoreError("db.listener_reconnect"));
  }, retryMs);
  retryTimer.unref();
  retryMs = Math.min(30_000, retryMs * 2);
}

async function close() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryMs = 1000;
  reconnecting = false;
  connected = false;
  listened.clear();
  const c = client;
  client = null;
  await c?.end().catch(ignoreError("db.listener_end"));
}

function safely(fn: () => void) {
  try {
    fn();
  } catch (e) {
    log.error("database listener subscriber:", (e as Error).message);
  }
}
