import { useCallback, useEffect, useRef, useState } from "react";

let csrf = "";
let supportView = false;
let authed = false;

export function setCsrf(token: string) {
  csrf = token;
}
export function setSupportView(on: boolean) {
  supportView = on;
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
  }
}

function withScope(path: string) {
  if (
    !supportView ||
    path.startsWith("/api/auth") ||
    path.startsWith("/api/ui-messages")
  )
    return path;
  return path + (path.includes("?") ? "&" : "?") + "scope=all";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() rejects (no HTTP status at all) when the browser drops in-flight requests, e.g. net::ERR_NETWORK_CHANGED
 * while Wi-Fi re-keys or the VPN (Cloudflare WARP) reconnects. GETs are safe to repeat, so they are retried a few
 * times with a short backoff; POSTs are not (the server may already have applied them).
 */
async function fetchRetrying(
  url: string,
  init: RequestInit,
  retries: number,
): Promise<Response> {
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
      (j.error || `HTTP ${r.status}`) +
        (j.details ? "\n" + j.details.join("\n") : ""),
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

  const [data, setDataState] = useState<T | null>(() =>
    cached ? (cached.data as T) : null,
  );
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

  const reload = useCallback(async () => {
    if (!path) return;
    const key = withScope(path);
    const n = ++seq.current;

    setDataState((prev) => {
      if (prev === null) setLoading(true);
      else setRefreshing(true);
      return prev;
    });

    try {
      let p = inFlight.get(key);
      if (!p) {
        p = api<T>(path);
        inFlight.set(key, p);
        p.finally(() => inFlight.delete(key));
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
  }, [path]);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps]);

  return { data, error, loading, refreshing, reload, setData };
}

export type LiveState = "sse" | "polling" | "connecting";

/**
 * One EventSource per browser tab, shared by every component (browsers allow only ~6 HTTP/1.1 connections per host;
 * one stream per component across a few tabs used them all and every fetch hung). The stream is closed while the tab is
 * hidden and reopened (with a refresh) when it becomes visible again. Falls back to polling when SSE is unavailable.
 */
type Sub = {
  runId: number | null;
  cb: (p?: any) => void;
  setState: (s: LiveState) => void;
};
const subs = new Set<Sub>();
let es: EventSource | null = null;
let state: LiveState = "connecting";
let poll: ReturnType<typeof setInterval> | null = null;

function setShared(s: LiveState) {
  state = s;
  subs.forEach((x) => x.setState(s));
}
function broadcast(p?: any) {
  subs.forEach((x) => {
    if (!p || x.runId === null || p.run_id === x.runId) x.cb(p);
  });
}
function stopPolling() {
  if (poll) (clearInterval(poll), (poll = null));
}
function startPolling() {
  setShared("polling");
  if (!poll) poll = setInterval(() => broadcast(), 3000);
}
function open() {
  if (!authed || es || !subs.size || document.visibilityState === "hidden")
    return;
  try {
    es = new EventSource(supportView ? "/api/stream?scope=all" : "/api/stream");
    es.addEventListener("hello", () => (stopPolling(), setShared("sse")));
    es.addEventListener("change", (e) =>
      broadcast(JSON.parse((e as MessageEvent).data)),
    );
    es.onerror = () => {
      startPolling(); // EventSource reconnects by itself; poll meanwhile
      // After a network change the browser may give up for good (CLOSED): open a fresh stream shortly.
      if (es?.readyState === EventSource.CLOSED) {
        es = null;
        setTimeout(open, 2000);
      }
    };
  } catch {
    startPolling();
  }
}
function close() {
  es?.close();
  es = null;
  stopPolling();
}
if (typeof window !== "undefined")
  // Network back (Wi-Fi/VPN reconnected): reopen the stream if it died and catch up on missed changes.
  window.addEventListener("online", () => {
    if (!es || es.readyState === EventSource.CLOSED) (close(), open());
    broadcast();
  });
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") close();
    else {
      open();
      broadcast(); // catch up on what happened while hidden
    }
  });

/** Calls `onChange` (debounced) when an event for `runId` (or any run when null) is written to PostgreSQL. */
export function useLive(
  runId: number | null,
  onChange: (payload?: any) => void,
  enabled = true,
) {
  const [live, setLive] = useState<LiveState>(state);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub: Sub = {
      runId,
      setState: setLive,
      cb: (p) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => cb.current(p), 250);
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
