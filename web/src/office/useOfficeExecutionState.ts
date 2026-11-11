import { useCallback, useEffect, useRef, useState } from "react";
import { api, isStateChange, useApi, useLive, type LiveState } from "../api.ts";
import type { EventLite, OfficeSnapshot } from "./types.ts";

const KEEP_EVENTS = 40;
const WATCH = ["RUNNING", "RETRYING", "WAITING_INPUT", "WAITING_APPROVAL", "FAILED"];

/**
 * Real execution state for the office: the run detail (`GET /api/runs/:id`), refreshed by the shared SSE stream
 * (`useLive`), plus the recent transcript of attempts worth showing (active/failed steps and the selected step),
 * fetched incrementally with `?after=<last id>` from the existing transcript endpoint. No new backend endpoints.
 */
export function useOfficeExecutionState(runId: number | null, focusStepKey: string | null) {
  const {
    data: run,
    error,
    loading,
    reload,
  } = useApi<any>(runId ? `/api/runs/${runId}` : null, [runId]);
  const [events, setEvents] = useState<Record<number, EventLite[]>>({});
  const cursor = useRef<Record<number, number>>({});
  const inflight = useRef<Set<number>>(new Set());

  useEffect(() => {
    setEvents({});
    cursor.current = {};
  }, [runId]);

  const pullTranscripts = useCallback(
    async (r: any) => {
      if (!r?.steps) return;
      const ids: number[] = r.steps
        .filter(
          (s: any) => s.current_attempt_id && (WATCH.includes(s.status) || s.key === focusStepKey),
        )
        .map((s: any) => Number(s.current_attempt_id));
      await Promise.all(
        ids.map(async (id) => {
          if (inflight.current.has(id)) return;
          inflight.current.add(id);
          try {
            const after = cursor.current[id] ?? 0;
            const rows = await api<EventLite[]>(
              `/api/attempts/${id}/transcript${after ? `?after=${after}` : ""}`,
            );
            if (!rows.length) return;
            cursor.current[id] = rows[rows.length - 1].id;
            const slim = rows.map((e) => ({
              id: e.id,
              kind: e.kind,
              created_at: e.created_at,
              content: String(e.content ?? "").slice(0, 600),
              data: e.data,
            }));
            setEvents((prev) => ({
              ...prev,
              [id]: [...(prev[id] ?? []), ...slim].slice(-KEEP_EVENTS),
            }));
          } catch {
            // transcript is decoration; the step status still drives the office
          } finally {
            inflight.current.delete(id);
          }
        }),
      );
    },
    [focusStepKey],
  );

  useEffect(() => void pullTranscripts(run), [run, pullTranscripts]);
  // A transcript line only extends the speech bubbles (incremental); the run itself is reloaded on state changes.
  const latestRun = useRef(run);
  latestRun.current = run;
  const live: LiveState = useLive(
    runId,
    (p) => (isStateChange(p) ? void reload() : void pullTranscripts(latestRun.current)),
    !!runId,
  );

  const snapshot: OfficeSnapshot | null = run
    ? {
        run: {
          id: run.id,
          title: run.title,
          status: run.status,
          branch: run.branch,
        },
        steps: run.steps,
        graph: run.graph?.steps ?? [],
        attempts: run.attempts ?? [],
        questions: run.questions ?? [],
        events,
      }
    : null;
  return {
    snapshot,
    error: runId ? error : null,
    loading: !!runId && loading && !run,
    live,
    reload,
  };
}

/** Runs for the picker: active ones first. Refreshed when any run changes. */
export function useOfficeRuns() {
  const { data, reload } = useApi<any[]>("/api/runs");
  useLive(null, (p) => {
    if (!p || p.kind === "status") void reload();
  });
  const runs = data ?? [];
  const isActive = (r: any) => ["RUNNING", "WAITING", "PAUSED"].includes(r.status);
  return { runs, active: runs.filter(isActive), isActive };
}

/** A clock for durations and the short celebration window; pauses while the tab is hidden. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(
      () => document.visibilityState === "visible" && setNow(Date.now()),
      intervalMs,
    );
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
