import { Maximize2, Minimize2, Pause, Play, Shrink, Sparkles, Expand } from "lucide-react";
import type { LiveState } from "../api.ts";
import { useI18n } from "../i18n/index.tsx";

export function OfficeToolbar({
  runs,
  activeIds,
  runId,
  onRun,
  preview,
  onPreview,
  animate,
  onAnimate,
  compact,
  onCompact,
  onFullscreen,
  fullscreen,
  live,
}: {
  runs: any[];
  activeIds: Set<number>;
  runId: number | null;
  onRun: (id: number | null) => void;
  preview: boolean;
  onPreview: (on: boolean) => void;
  animate: boolean;
  onAnimate: (on: boolean) => void;
  compact: boolean;
  onCompact: (on: boolean) => void;
  onFullscreen: () => void;
  fullscreen: boolean;
  live: LiveState | null;
}) {
  const { t } = useI18n();
  const active = runs.filter((r) => activeIds.has(r.id));
  const recent = runs.filter((r) => !activeIds.has(r.id)).slice(0, 30);
  return (
    <div className="office-toolbar" role="toolbar" aria-label={t("office.toolbar")}>
      <label className="office-runpick">
        <span className="sr-only">{t("office.pick")}</span>
        <select
          value={preview ? "preview" : (runId ?? "")}
          onChange={(e) =>
            e.target.value === "preview"
              ? onPreview(true)
              : (onPreview(false), onRun(e.target.value ? Number(e.target.value) : null))
          }
        >
          <option value="">{active.length ? t("office.auto") : t("office.none")}</option>
          {active.length > 0 && (
            <optgroup label={t("office.active")}>
              {active.map((r) => (
                <option key={r.id} value={r.id}>
                  #{r.id} · {r.status} · {r.title}
                </option>
              ))}
            </optgroup>
          )}
          {recent.length > 0 && (
            <optgroup label={t("office.history")}>
              {recent.map((r) => (
                <option key={r.id} value={r.id}>
                  #{r.id} · {r.status} · {r.title}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label={t("office.sim")}>
            <option value="preview">{t("office.preview")}</option>
          </optgroup>
        </select>
      </label>
      {!preview && runId && (
        <a className="small" href={`#/runs/${runId}`}>
          {t("office.graph", { n: runId })}
        </a>
      )}
      <span className="grow" />
      {!preview && live && (
        <span className={`office-live is-${live}`} title={t("office.liveTip")}>
          {live === "sse"
            ? `● ${t("live.sse")}`
            : live === "polling"
              ? `◌ ${t("live.polling")}`
              : `… ${t("live.connecting")}`}
        </span>
      )}
      <button
        className={`ghost sm${preview ? " is-on" : ""}`}
        aria-pressed={preview}
        onClick={() => onPreview(!preview)}
        title={t("office.previewTip")}
      >
        <Sparkles size={15} /> Preview
      </button>
      <button
        className={`ghost sm${animate ? " is-on" : ""}`}
        aria-pressed={animate}
        onClick={() => onAnimate(!animate)}
      >
        {animate ? (
          <>
            <Pause size={15} /> Animation
          </>
        ) : (
          <>
            <Play size={15} /> Animation
          </>
        )}
      </button>
      <button
        className={`ghost sm${compact ? " is-on" : ""}`}
        aria-pressed={compact}
        onClick={() => onCompact(!compact)}
      >
        {compact ? (
          <>
            <Expand size={15} /> {t("office.wide")}
          </>
        ) : (
          <>
            <Shrink size={15} /> {t("office.compact")}
          </>
        )}
      </button>
      <button className="ghost sm" aria-pressed={fullscreen} onClick={onFullscreen}>
        {fullscreen ? (
          <>
            <Minimize2 size={15} /> {t("office.exitFullscreen")}
          </>
        ) : (
          <>
            <Maximize2 size={15} /> {t("office.fullscreen")}
          </>
        )}
      </button>
    </div>
  );
}
