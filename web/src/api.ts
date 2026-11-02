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
 * Live updates: Server-Sent Events relayed from PostgreSQL LISTEN/NOTIFY (`/api/stream`). Calls `onChange` (debounced)
 * whenever an event for the run (or any run) is written. Falls back to polling every 3s if SSE is unavailable.
 */
export function useLive(runId: number | null, onChange: (payload?: any) => void, enabled = true) {
  const [state, setState] = useState<LiveState>("connecting");
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const fire = (p?: any) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cb.current(p), 250);
    };
    const startPolling = () => {
      setState("polling");
      if (!poll) poll = setInterval(() => cb.current(), 3000);
    };
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/stream${runId ? `?run_id=${runId}` : ""}`);
      es.addEventListener("hello", () => {
        setState("sse");
        if (poll) clearInterval(poll), (poll = null);
      });
      es.addEventListener("change", (e) => fire(JSON.parse((e as MessageEvent).data)));
      es.onerror = () => startPolling(); // EventSource retries by itself; poll meanwhile
    } catch {
      startPolling();
    }
    return () => {
      es?.close();
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
    };
  }, [runId, enabled]);
  return state;
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
