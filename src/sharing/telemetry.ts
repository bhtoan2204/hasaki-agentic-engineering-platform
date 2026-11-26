import { log } from "../logging.ts";
import { countShared, observe as observeHistogram } from "../runtimeMetrics.ts";
import type { SharedEvent } from "./types.ts";

const LABEL: Record<string, string> = {
  hit: "hit",
  wait: "single-flight wait",
  miss: "miss",
  forced: "force re-run",
  bypass: "bypass",
  retry_held: "failed-retry held",
  denied: "denied",
  lost_race: "lost claim race",
  published: "published",
  failed: "failed",
  stale: "stale",
  expired: "stale",
};

/**
 * The default `observe` hook: counters (runtimeMetrics, fixed labels) and one log line per event. Only the values the event
 * carries are used (rule R1): no query, no I/O. The request and correlation ids come from the log context.
 */
export function recordSharedEvent(e: SharedEvent) {
  const retry = e.outcome === "bypass" && (e.reason === "backoff" || e.reason === "exhausted");
  const event = retry ? "retry_held" : e.outcome;
  countShared(e.kind, event);
  if (e.tokensSaved) countShared(e.kind, "tokens_saved", e.tokensSaved);
  if (e.durationMs != null) observeHistogram("shared.lookup_ms", e.durationMs);
  const line =
    `shared result ${LABEL[event] ?? event}: kind=${e.kind} key=${e.key ?? "-"} tenant=${e.scope ?? "-"}` +
    ` analysis=${e.analysisId ?? "-"} v=${e.version ?? "-"} run=${e.runId ?? "-"} actor=${e.actorId ?? "-"}` +
    (e.reason ? ` reason=${e.reason}` : "") +
    (e.durationMs != null ? ` ms=${Math.round(e.durationMs)}` : "");
  if (event === "failed" || event === "denied") log.warn(line);
  else log.info(line);
}
