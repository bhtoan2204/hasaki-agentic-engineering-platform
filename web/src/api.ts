import { useCallback, useEffect, useRef, useState } from "react";

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body !== undefined ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error || `HTTP ${r.status}`) + (j.details ? "\n" + j.details.join("\n") : ""));
  return j as T;
}

/** Fetch data, refetch on demand. Keeps the previous data while reloading (no flicker). */
export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    try {
      const d = await api<T>(path);
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(true);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps]);
  return { data, error, loading, reload, setData };
}

export type LiveState = "sse" | "polling" | "connecting";

/**
 * One EventSource per browser tab, shared by every component (browsers allow only ~6 HTTP/1.1 connections per host;
 * one stream per component across a few tabs used them all and every fetch hung). The stream is closed while the tab is
 * hidden and reopened (with a refresh) when it becomes visible again. Falls back to polling when SSE is unavailable.
 */
type Sub = { runId: number | null; cb: (p?: any) => void; setState: (s: LiveState) => void };
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
  if (poll) clearInterval(poll), (poll = null);
}
function startPolling() {
  setShared("polling");
  if (!poll) poll = setInterval(() => broadcast(), 3000);
}
function open() {
  if (es || !subs.size || document.visibilityState === "hidden") return;
  try {
    es = new EventSource("/api/stream");
    es.addEventListener("hello", () => (stopPolling(), setShared("sse")));
    es.addEventListener("change", (e) => broadcast(JSON.parse((e as MessageEvent).data)));
    es.onerror = () => startPolling(); // EventSource reconnects by itself; poll meanwhile
  } catch {
    startPolling();
  }
}
function close() {
  es?.close();
  es = null;
  stopPolling();
}
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") close();
    else {
      open();
      broadcast(); // catch up on what happened while hidden
    }
  });

/** Calls `onChange` (debounced) when an event for `runId` (or any run when null) is written to PostgreSQL. */
export function useLive(runId: number | null, onChange: (payload?: any) => void, enabled = true) {
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
  PENDING: "var(--muted)",
  READY: "var(--accent)",
  RUNNING: "var(--accent)",
  RETRYING: "var(--accent)",
  WAITING: "var(--warn)",
  WAITING_INPUT: "var(--warn)",
  WAITING_APPROVAL: "var(--warn)",
  PAUSED: "var(--warn)",
  COMPLETED: "var(--ok)",
  FAILED: "var(--err)",
  STALE: "var(--err)",
  CANCELED: "var(--muted)",
  SKIPPED: "var(--muted)",
};
