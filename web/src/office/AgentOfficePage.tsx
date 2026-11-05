import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "../ui.tsx";
import { AgentDetailsPanel } from "./AgentDetailsPanel.tsx";
import { usePreviewOffice } from "./demo.ts";
import { OfficeScene } from "./OfficeScene.tsx";
import { OfficeToolbar } from "./OfficeToolbar.tsx";
import { useNow, useOfficeExecutionState, useOfficeRuns } from "./useOfficeExecutionState.ts";
import { mapOffice, ROLE_INFO } from "./workflowToAgentMapper.ts";
import { useI18n } from "../i18n/index.tsx";
import type { OfficeSnapshot, Role } from "./types.ts";
import "./office.css";

const EMPTY: OfficeSnapshot = { run: null, steps: [], graph: [], attempts: [], questions: [], events: {} };

function pref(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function savePref(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {}
}
const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Route: #/office[/<runId> | /preview]. */
export function AgentOfficePage({ param }: { param?: string }) {
  const { t, locale } = useI18n();
  const preview = param === "preview";
  const pinnedRun = param && param !== "preview" ? Number(param) : null;
  const { runs, active } = useOfficeRuns();
  const runId = preview ? null : pinnedRun ?? active[0]?.id ?? null;

  const [selected, setSelected] = useState<Role | null>(null);
  const [focusStep, setFocusStep] = useState<string | null>(null);
  const [animate, setAnimate] = useState(() => pref("office.animate", !reducedMotion()));
  const [compact, setCompact] = useState(() => pref("office.compact", false));
  const [fullscreen, setFullscreen] = useState(false);
  const shell = useRef<HTMLDivElement>(null);

  const real = useOfficeExecutionState(runId, focusStep);
  const demo = usePreviewOffice(preview);
  const now = useNow(1000);
  const snapshot = preview ? demo.snapshot : real.snapshot ?? EMPTY;
  const agents = useMemo(() => mapOffice(snapshot, now, locale), [snapshot, now, locale]);
  const sel = selected ? agents.find((a) => a.role === selected) ?? null : null;

  useEffect(() => setFocusStep(sel?.step?.key ?? null), [sel?.step?.key]);
  useEffect(() => setSelected(null), [runId, preview]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.fullscreenElement && setSelected(null);
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFs);
    return () => (window.removeEventListener("keydown", onKey), document.removeEventListener("fullscreenchange", onFs));
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shell.current?.requestFullscreen?.().catch(() => {});
  }, []);

  const running = agents.filter((a) => a.pose === "work").length;
  const waiting = agents.filter((a) => a.pose === "ask" || a.pose === "approval").length;
  const failed = agents.filter((a) => a.pose === "frustrated").length;
  const run = snapshot.run;
  const events = sel?.attempt ? snapshot.events[sel.attempt.id] ?? [] : [];

  return (
    <div ref={shell} className={`office${animate ? "" : " office--still"}${compact ? " office--compact" : ""}${preview ? " office--preview" : ""}${fullscreen ? " office--fs" : ""}`}>
      <OfficeToolbar
        runs={runs}
        activeIds={new Set(active.map((r) => r.id))}
        runId={runId}
        onRun={(id) => navigate(id ? `/office/${id}` : "/office")}
        preview={preview}
        onPreview={(on) => navigate(on ? "/office/preview" : pinnedRun ? `/office/${pinnedRun}` : "/office")}
        animate={animate}
        onAnimate={(v) => (setAnimate(v), savePref("office.animate", v))}
        compact={compact}
        onCompact={(v) => (setCompact(v), savePref("office.compact", v))}
        onFullscreen={toggleFullscreen}
        fullscreen={fullscreen}
        live={preview ? null : real.live}
      />

      {preview && (
        <div className="office-preview-ribbon" role="status">
          {t("office.previewBanner")}
          <span className="office-caption">{t("office.scene", { n: demo.frame + 1, total: demo.frames, caption: demo.caption })}</span>
        </div>
      )}

      <div className="office-body">
        <section className="office-main">
          <div className="office-runline">
            {preview ? (
              <span className="muted">{t("office.simRun")}</span>
            ) : run ? (
              <>
                <b>Run #{run.id}</b> <span className="office-runtitle">{run.title}</span> <span className={`office-runstatus s-${run.status}`}>{run.status}</span>
              </>
            ) : real.error ? (
              <span className="err">{t("office.loadFail", { error: real.error })}</span>
            ) : (
              <span className="muted">{real.loading ? t("office.loading") : t("office.break")}</span>
            )}
            <span className="grow" />
            <span className="office-stats" aria-live="polite">
              {running > 0 && <span className="st-run">{t("ov.working", { n: running })}</span>}
              {waiting > 0 && <span className="st-wait">{t("ov.needYou", { n: waiting })}</span>}
              {failed > 0 && <span className="st-fail">{t("office.failedN", { n: failed })}</span>}
            </span>
          </div>

          <OfficeScene agents={agents} now={now} still={!animate} selected={selected} onSelect={(r) => setSelected((s) => (s === r ? null : r))} />

          {!preview && !run && !real.loading && (
            <div className="office-idle-card">
              <div><b>{t("office.idleTitle")}</b> {t("office.idleBody")} <button className="linkish" onClick={() => navigate("/office/preview")}>{t("office.preview")}</button></div>
              <div className="office-idle-runs">
                {runs.slice(0, 6).map((r) => <a key={r.id} href={`#/office/${r.id}`}>#{r.id} <span className="muted">{r.status}</span> {r.title}</a>)}
              </div>
            </div>
          )}

          <ul className="office-roster" aria-label={t("office.roster")}>
            {agents.map((a) => (
              <li key={a.role}>
                <button className={`office-chip pose-${a.pose}${selected === a.role ? " is-sel" : ""}`} onClick={() => setSelected((s) => (s === a.role ? null : a.role))} aria-pressed={selected === a.role} title={a.detail}>
                  <span className="office-chip-dot" aria-hidden />
                  <b>{ROLE_INFO[a.role].name}</b> <span className="muted">{t(`office.role.${a.role}.title`)}</span>
                  <span className="office-chip-state">{a.status ?? "—"}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="office-note muted small">{t("office.note")}</p>
        </section>

        {sel && <AgentDetailsPanel agent={sel} runId={preview ? null : runId} events={events} now={now} preview={preview} attempts={snapshot.attempts} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}
