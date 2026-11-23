import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";

type EventState<T> = {
  path: string;
  events: T[] | null;
  error: string | null;
  retrying?: boolean;
};

const NO_EVENTS: never[] = [];

/** Fetch the next events on each live tick, keeping loaded rows and the cursor if a request fails. */
export function useRunEvents<T extends { id: number }>(path: string, tick: number) {
  const [state, setState] = useState<EventState<T> | null>(null);
  const [retry, setRetry] = useState(0);
  const cursor = useRef({ path, after: 0 });

  useEffect(() => {
    if (cursor.current.path !== path) {
      cursor.current = { path, after: 0 };
      setState(null);
    }
    let active = true;
    void api<T[]>(`${path}?after=${cursor.current.after}`)
      .then((rows) => {
        if (!active) return;
        if (rows.length) cursor.current.after = rows[rows.length - 1].id;
        setState((prev) => {
          const existing = prev?.path === path ? prev : null;
          if (existing?.events && !rows.length && !existing.error && !existing.retrying)
            return existing;
          return { path, events: [...(existing?.events ?? []), ...rows], error: null };
        });
      })
      .catch((error: Error) => {
        if (active) {
          setState((prev) => ({
            path,
            events: prev?.path === path ? prev.events : null,
            error: error.message,
          }));
        }
      });
    return () => {
      active = false;
    };
  }, [path, tick, retry]);

  const current = state?.path === path ? state : null;
  const reload = () => {
    setState((prev) => (prev?.path === path ? { ...prev, error: null, retrying: true } : prev));
    setRetry((n) => n + 1);
  };
  return {
    events: current?.events ?? NO_EVENTS,
    error: current?.error ?? null,
    loading: !current || Boolean(current.retrying),
    reload,
  };
}
