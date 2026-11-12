import { useCallback, useEffect, useRef, useState } from "react";

let csrf = "";
let supportView = false;
let authed = false;

export function setCsrf(token: string) {
  csrf = token;
}
export function setSupportView(on: boolean) {
  supportView = on;
  // The set of visible events changes with the scope: start a new cursor and reload every view once.
  cursor = null;
  seen.clear();
  close();
  open();
  broadcast();
}
export function setAuthed(on: boolean) {
  authed = on;
  if (!on) {
    csrf = "";
    supportView = false;
    clearApiCache();
    close();
    cursor = null;
    seen.clear();
  }
}

function withScope(path: string) {
  if (!supportView || path.startsWith("/api/auth") || path.startsWith("/api/ui-messages"))
    return path;
  return path + (path.includes("?") ? "&" : "?") + "scope=all";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() rejects (no HTTP status at all) when the browser drops in-flight requests, e.g. net::ERR_NETWORK_CHANGED
 * while Wi-Fi re-keys or the VPN (Cloudflare WARP) reconnects. GETs are safe to repeat, so they are retried a few
 * times with a short backoff; POSTs are not (the server may already have applied them).
 */
async function fetchRetrying(url: string, init: RequestInit, retries: number): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep([500, 1500, 3000][attempt] ?? 3000);
    }
  }
}

/** Random key; crypto.getRandomValues also works on plain-HTTP LAN installs where randomUUID is unavailable. */
function idempotencyKey() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const scoped = withScope(path);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (body !== undefined && csrf) headers["X-CSRF-Token"] = csrf;
  // One key per user action: the server replays the first response for create-type routes (no duplicate runs).
  if (body !== undefined) headers["Idempotency-Key"] = idempotencyKey();
  const isGet = body === undefined;
  const r = await fetchRetrying(
    scoped,
    {
      method: isGet ? "GET" : "POST",
      headers,
      body: isGet ? undefined : JSON.stringify(body),
      credentials: "include",
    },
    isGet ? 3 : 0,
  );
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith("/api/auth/login")) {
    setAuthed(false);
    window.dispatchEvent(new Event("auth:lost"));
  }
  if (!r.ok)
    throw new Error(
      (j.error || `HTTP ${r.status}`) + (j.details ? "\n" + j.details.join("\n") : ""),
    );
  return j as T;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}
const apiCache = new Map<string, CacheEntry<any>>();
const inFlight = new Map<string, Promise<any>>();

export function clearApiCache() {
  apiCache.clear();
  inFlight.clear();
}

export function invalidateCache(prefix?: string) {
  if (!prefix) {
    apiCache.clear();
    return;
  }
  for (const key of apiCache.keys()) {
    if (key.includes(prefix)) {
      apiCache.delete(key);
    }
  }
}

/** Fetch data, refetch on demand. Stale-while-revalidate: keeps previous data during background reload (no flicker). */
export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const scopedKey = path ? withScope(path) : null;
  const cached = scopedKey ? apiCache.get(scopedKey) : undefined;

  const [data, setDataState] = useState<T | null>(() => (cached ? (cached.data as T) : null));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!cached && !!path);
  const [refreshing, setRefreshing] = useState<boolean>(!!cached && !!path);
  const seq = useRef(0);

  // Sync cache when path/scopedKey changes
  useEffect(() => {
    if (scopedKey) {
      const entry = apiCache.get(scopedKey);
      if (entry) {
        setDataState(entry.data as T);
        setLoading(false);
        setRefreshing(true);
      } else {
        setDataState((prev) => {
          if (!prev) setLoading(true);
          return prev;
        });
        setRefreshing(true);
      }
    } else {
      setLoading(false);
      setRefreshing(false);
    }
  }, [scopedKey]);

  const setData = useCallback(
    (d: T | null) => {
      setDataState(d);
      if (scopedKey && d !== null) {
        apiCache.set(scopedKey, { data: d, timestamp: Date.now() });
      }
    },
    [scopedKey],
  );

  const load = useCallback(
    async (fresh: boolean) => {
      if (!path) return;
      const key = withScope(path);
      const n = ++seq.current;

      setDataState((prev) => {
        if (prev === null) setLoading(true);
        else setRefreshing(true);
        return prev;
      });

      try {
        // A mutation must not reuse a GET that started before it committed: that response is the
        // previous screen, and the view would sit there until the next live tick (up to one poll).
        if (fresh) inFlight.delete(key);
        let p = inFlight.get(key);
        if (!p) {
          p = api<T>(path);
          inFlight.set(key, p);
          const flight = p;
          flight.finally(() => {
            if (inFlight.get(key) === flight) inFlight.delete(key);
          });
        }
        const d = await p;
        if (n === seq.current) {
          apiCache.set(key, { data: d, timestamp: Date.now() });
          setDataState(d);
          setError(null);
        }
      } catch (e) {
        if (n === seq.current) setError((e as Error).message);
      } finally {
        if (n === seq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [path],
  );

  const reload = useCallback(() => load(false), [load]);
  const reloadFresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps]);

  return { data, error, loading, refreshing, reload, reloadFresh, setData };
}

export type LiveState = "sse" | "polling" | "connecting";

/** What the server announces: ids and the kind only. Views fetch what they show through the REST API. */
export type LivePayload = {
  id: number;
  run_id: number;
  step_id: number | null;
  attempt_id: number | null;
  kind: string;
};

/**
 * Transcript-level kinds written while an agent or command works (tool calls, results, thinking, output lines, agent
 * notes). They never change run, step, question or cost state; that always comes with a "status" event.
 */
const ACTIVITY_KINDS = new Set([
  "tool",
  "tool_result",
  "agent",
  "assistant",
  "thinking",
  "prompt",
  "system_prompt",
  "result",
  "log",
]);

/**
 * True when `p` may change what a view shows beyond a transcript: status transitions, user actions, handoffs and
 * run-level notes. `undefined` (a catch-up after an outage) and any unknown kind count as a state change.
 */
export function isStateChange(p?: LivePayload | null) {
  if (!p) return true;
  if (p.kind === "system") return p.attempt_id == null; // attempt-level "system" lines are agent narration
  return !ACTIVITY_KINDS.has(p.kind);
}

/**
 * One EventSource per browser tab, shared by every component (browsers allow only ~6 HTTP/1.1 connections per host;
 * one stream per component across a few tabs used them all and every fetch hung). The stream is closed while the tab
 * is hidden and reopened when it becomes visible again.
 *
 * Recovery is cursor-based: every event carries its `workflow_events.id`. A reopened stream passes `?after=<cursor>`
 * (the browser's own reconnect sends Last-Event-ID) and the server replays the gap, so only the views touched by
 * missed events reload. Duplicates are dropped by id. When the gap is too large (`hello.reset`) or no cursor is known,
 * every view reloads once instead. While the stream is down, `/api/events?after=` is polled for the same slice.
 */
type Sub = {
  runId: number | null;
  cb: (p?: LivePayload) => void;
  setState: (s: LiveState) => void;
};
const subs = new Set<Sub>();
let es: EventSource | null = null;
let state: LiveState = "connecting";
let poll: ReturnType<typeof setInterval> | null = null;
let reopen: ReturnType<typeof setTimeout> | null = null;
let reopenDelay = 2000;
/** Newest event id this tab is up to date with (null until the first hello). */
let cursor: number | null = null;
const seen = new Set<number>();

const POLL_MS = 1500;
const REOPEN_MAX_MS = 30_000;

function setShared(s: LiveState) {
  state = s;
  subs.forEach((x) => x.setState(s));
}
/** Without a payload every subscriber reloads (catch-up when the gap is unknown). */
function broadcast(p?: LivePayload) {
  subs.forEach((x) => {
    if (!p || x.runId === null || p.run_id === x.runId) x.cb(p);
  });
}
function deliver(p: LivePayload) {
  if (seen.has(p.id)) return;
  seen.add(p.id);
  if (seen.size > 1000) seen.delete(seen.values().next().value!);
  cursor = Math.max(cursor ?? 0, p.id);
  broadcast(p);
}
/** Fallback while the stream is unavailable: one small cursor request per tick instead of reloading every view. */
async function pollOnce() {
  if (document.visibilityState === "hidden" || !authed) return;
  try {
    const r = await api<{ events: LivePayload[]; reset: boolean; cursor: number }>(
      `/api/events${cursor == null ? "" : `?after=${cursor}`}`,
    );
    const unknownGap = cursor == null || r.reset;
    if (unknownGap) broadcast();
    else r.events.forEach(deliver);
    cursor = Math.max(cursor ?? 0, r.cursor);
  } catch {
    // server unreachable: keep what is shown; the next tick (or the stream) catches up
  }
}
function stopPolling() {
  if (poll) (clearInterval(poll), (poll = null));
}
function startPolling() {
  setShared("polling");
  if (poll) return;
  void pollOnce();
  poll = setInterval(() => void pollOnce(), POLL_MS);
}
function streamUrl() {
  const q = new URLSearchParams();
  if (supportView) q.set("scope", "all");
  if (cursor != null) q.set("after", String(cursor));
  const s = q.toString();
  return s ? `/api/stream?${s}` : "/api/stream";
}
function open() {
  if (!authed || es || !subs.size || document.visibilityState === "hidden") return;
  if (reopen) (clearTimeout(reopen), (reopen = null));
  try {
    const source = new EventSource(streamUrl());
    es = source;
    source.addEventListener("hello", (e) => {
      const h = JSON.parse((e as MessageEvent).data ?? "{}");
      reopenDelay = 2000;
      const unknownGap = cursor == null ? false : !!h.reset;
      if (typeof h.cursor === "number") cursor = Math.max(cursor ?? 0, h.cursor);
      if (h.live === false)
        startPolling(); // stream open but the server's LISTEN is down: don't trust it yet
      else (stopPolling(), setShared("sse"));
      if (unknownGap) broadcast();
    });
    source.addEventListener("change", (e) => deliver(JSON.parse((e as MessageEvent).data)));
    source.onerror = () => {
      startPolling(); // EventSource reconnects by itself (with Last-Event-ID); poll meanwhile
      // After a network change the browser may give up for good (CLOSED): open a fresh stream with backoff.
      if (source.readyState === EventSource.CLOSED && es === source) {
        es = null;
        reopen = setTimeout(open, reopenDelay);
        reopenDelay = Math.min(reopenDelay * 2, REOPEN_MAX_MS);
      }
    };
  } catch {
    startPolling();
  }
}
function close() {
  es?.close();
  es = null;
  if (reopen) (clearTimeout(reopen), (reopen = null));
  stopPolling();
}
if (typeof window !== "undefined")
  // Network back (Wi-Fi/VPN reconnected): reopen the stream if it died; the server replays what was missed.
  window.addEventListener("online", () => {
    if (!es || es.readyState === EventSource.CLOSED) (close(), open());
  });
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") close();
    else {
      // Reopening with ?after= replays what happened while hidden; without a cursor reload everything once.
      if (cursor == null) broadcast();
      open();
    }
  });

/** Rank of a payload when several arrive in one batch: the most significant one is handed to the subscriber. */
const weight = (p?: LivePayload) => (!p ? 3 : p.kind === "status" ? 2.5 : isStateChange(p) ? 2 : 1);
/** First call 250 ms after an event, then at most once per second while events keep coming. */
const FIRST_MS = 250;
const GAP_MS = 1000;

/**
 * Calls `onChange` when an event for `runId` (or any run when null) is written to PostgreSQL. Events are batched
 * (throttled, never starved by a steady stream); the callback receives the most significant payload of the batch
 * (`undefined` for a full catch-up, then status, then other state changes, then transcript activity), so a
 * `p.kind === "status"` check is not lost to a transcript line that arrived right after it. Use `isStateChange(p)` to
 * skip transcript-only events.
 */
export function useLive(
  runId: number | null,
  onChange: (payload?: LivePayload) => void,
  enabled = true,
) {
  const [live, setLive] = useState<LiveState>(state);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: { p?: LivePayload } | null = null;
    let last = 0;
    const fire = () => {
      timer = null;
      last = Date.now();
      const batch = pending;
      pending = null;
      if (batch) cb.current(batch.p);
    };
    const sub: Sub = {
      runId,
      setState: setLive,
      cb: (p) => {
        if (!pending || weight(p) > weight(pending.p)) pending = { p };
        if (!timer) timer = setTimeout(fire, Math.max(FIRST_MS, last + GAP_MS - Date.now()));
      },
    };
    subs.add(sub);
    setLive(state);
    open();
    return () => {
      subs.delete(sub);
      if (timer) clearTimeout(timer);
      if (!subs.size) close();
    };
  }, [runId, enabled]);
  return live;
}

export const STATUS_COLORS: Record<string, string> = {
  PENDING: "var(--st-idle)",
  READY: "var(--st-run)",
  RUNNING: "var(--st-run)",
  RETRYING: "var(--st-run)",
  WAITING: "var(--st-wait)",
  WAITING_INPUT: "var(--st-wait)",
  WAITING_APPROVAL: "var(--st-wait)",
  PAUSED: "var(--st-wait)",
  COMPLETED: "var(--st-ok)",
  FAILED: "var(--st-err)",
  STALE: "var(--st-err)",
  CANCELED: "var(--st-idle)",
  SKIPPED: "var(--st-idle)",
};

export const LIVE_STATUSES = new Set([
  "RUNNING",
  "RETRYING",
  "WAITING",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
]);
