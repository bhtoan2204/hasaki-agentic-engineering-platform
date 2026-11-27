import { useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Copy, ErrorBox, Loading } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { useRunEvents } from "../useRunEvents.ts";
import { type TranscriptEvent } from "./shared.tsx";

/** Live stdout/stderr of a command step, streamed as "log" events while it runs. */
export function CommandLog({
  attemptId,
  live,
  tick,
  startedAt,
}: {
  attemptId: number;
  live: boolean;
  tick: number;
  startedAt: string;
}) {
  const { t } = useI18n();
  const { events, error, loading, reload } = useRunEvents<TranscriptEvent>(
    `/api/attempts/${attemptId}/transcript`,
    tick,
  );
  const box = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const [, force] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [events, follow]);
  const text = events.map((e) => (e.kind === "log" ? e.content : `\n${e.content}\n`)).join("");
  const lastAt = events.length ? events[events.length - 1].created_at : startedAt;
  const quiet = live ? Math.round((Date.now() - new Date(lastAt).getTime()) / 1000) : 0;
  if (!events.length && loading) return <Loading />;
  if (!events.length && error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && <Loading />}
      <div className="rv-toolrow">
        <span className="small muted grow si-cmd-status">
          {live ? (
            <>
              <span className="spinner" />{" "}
              {t("si.runningFor", {
                secs: Math.round((Date.now() - new Date(startedAt).getTime()) / 1000),
                quiet,
              })}
            </>
          ) : (
            <>
              <CheckCircle2 size={13} /> {t("si.done")}
            </>
          )}
          {live && quiet > 60 && <span className="si-cmd-quiet">({t("si.quiet")})</span>}
        </span>
        <label>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />{" "}
          {t("si.follow")}
        </label>
        <Copy text={text} />
      </div>
      <pre ref={box} className="rv-term">
        {text || t("si.noLog")}
      </pre>
    </div>
  );
}
