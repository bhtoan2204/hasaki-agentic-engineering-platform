import { Activity } from "lucide-react";
import { useI18n } from "../../i18n/index.tsx";
import { ErrorBox, Loading, time } from "../../ui.tsx";
import { useRunEvents } from "../useRunEvents.ts";
import { type TimelineEvent } from "./shared.tsx";

/** Run timeline, fetched once and then incrementally (`?after=`) whenever an event arrives. */
export function RunTimeline({ runId, activity }: { runId: number; activity: number }) {
  const { t } = useI18n();
  const { events, error, loading, reload } = useRunEvents<TimelineEvent>(
    `/api/runs/${runId}/events`,
    activity,
  );
  return (
    <div className="rv-sec">
      <div className="rv-sec-title">
        <Activity size={14} /> {t("common.timeline")}
      </div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && <Loading />}
      {(events.length > 0 || (!loading && !error)) && (
        <div className="rv-tl">
          {events
            .slice()
            .reverse()
            .slice(0, 300)
            .map((e) => (
              <div key={e.id} className="rv-tl-row">
                <span className="muted">
                  {time(e.created_at)}
                  <br />
                  <span className="mono">{e.step_key ?? "run"}</span>
                </span>
                <span>
                  <b className="muted small">{e.kind}</b>{" "}
                  <span
                    style={{
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      color: e.kind === "user" ? "var(--brand-700)" : undefined,
                    }}
                  >
                    {e.content}
                  </span>
                </span>
              </div>
            ))}
          {!events.length && (
            <div className="muted small" style={{ padding: 12 }}>
              {t("rv.noEvents")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
