import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowUpRight, Building2, Eye, EyeOff, Minus, Settings2, X } from "lucide-react";
import { useI18n } from "../i18n/index.tsx";
import { mapOffice, primaryStep } from "./workflowToAgentMapper.ts";
import { companionActivity, prioritizeCompanionRuns, type CompanionState } from "./companionState.ts";
import { useNow, useOfficeExecutionState, useOfficeRuns } from "./useOfficeExecutionState.ts";
import { HasakiCompanionAvatar } from "./HasakiCompanionAvatar.tsx";
import "./companion.css";

type Preferences = { hidden: boolean; minimized: boolean; intensity: "off" | "subtle" | "normal" | "playful"; position: { right: number; bottom: number }; name: string };
const PREF_KEY = "hasaki.companion.preferences.v1";
const DEFAULT_PREFS: Preferences = { hidden: false, minimized: true, intensity: "normal", position: { right: 20, bottom: 20 }, name: "Hasaki-chan" };
function readPrefs(): Preferences {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? "null");
    if (!p || typeof p !== "object") return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...p, position: { ...DEFAULT_PREFS.position, ...(p.position ?? {}) }, intensity: ["off", "subtle", "normal", "playful"].includes(p.intensity) ? p.intensity : "normal", name: typeof p.name === "string" ? p.name.slice(0, 32) : DEFAULT_PREFS.name };
  } catch { return DEFAULT_PREFS; }
}
const STATUS_I18N: Record<string, string> = { RUNNING: "status.RUNNING", RETRYING: "status.RETRYING", WAITING: "status.WAITING", WAITING_INPUT: "status.WAITING_INPUT", WAITING_APPROVAL: "status.WAITING_APPROVAL", COMPLETED: "status.COMPLETED", FAILED: "status.FAILED", CANCELED: "status.CANCELED", PAUSED: "status.PAUSED", READY: "status.READY" };
const STATE_I18N: Record<CompanionState, string> = {
  IDLE: "companion.state.idle", WALKING: "companion.state.working", WORKING: "companion.state.working", THINKING: "companion.state.thinking", RESEARCHING: "companion.state.researching", CODING: "companion.state.coding", TESTING: "companion.state.testing", REVIEWING: "companion.state.reviewing", WAITING: "companion.state.waiting", ASKING: "companion.state.asking", APPROVAL_REQUIRED: "companion.state.approval", SUCCESS: "companion.state.success", CELEBRATING: "companion.state.success", FAILED: "companion.state.failed", RETRYING: "companion.state.retrying", HANDOFF: "companion.state.handoff", SLEEPING: "companion.state.sleeping",
};
function sectionLabel(section: string, t: (key: string) => string) {
  const keys: Record<string, string> = { overview: "nav.overview", "work-items": "nav.workItems", runs: "nav.runs", workflows: "nav.workflows", questions: "nav.questions", "prod-errors": "nav.prodErrors", knowledge: "nav.knowledge", repositories: "nav.repositories", insights: "nav.insights", office: "nav.office", integrations: "nav.integrations" };
  return t(keys[section] ?? "nav.overview");
}

/** Persistent shell companion. The run list and selected run detail use the same API/SSE hooks as Agent Office. */
export function GlobalChibiCompanion({ section }: { section: string }) {
  const { t, locale } = useI18n();
  const [prefs, setPrefs] = useState(readPrefs);
  const [open, setOpen] = useState(() => !prefs.minimized);
  const [settings, setSettings] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const moved = useRef(false);
  const dragPosition = useRef(prefs.position);
  const pointerStart = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null);
  const avatarRef = useRef<HTMLButtonElement>(null);
  const runsResult = useOfficeRuns();
  const runs = runsResult.runs ?? [];
  const runMeta = prioritizeCompanionRuns(runs);
  const runId = runMeta?.id ? Number(runMeta.id) : null;
  const { snapshot, loading } = useOfficeExecutionState(runId, null);
  const now = useNow(1000);
  const agents = useMemo(() => snapshot ? mapOffice(snapshot, now, locale) : [], [snapshot, now, locale]);
  const step = snapshot ? primaryStep(snapshot.steps, snapshot.attempts) : null;
  const agent = step ? agents.find((a) => a.step?.key === step.key) ?? null : null;
  const attempt = step ? snapshot?.attempts.find((a) => a.id === step.current_attempt_id) ?? null : null;
  const pendingQuestion = !!snapshot?.questions.some((q) => q.step_key === step?.key && ["OPEN", "PENDING", "WAITING"].includes(q.status.toUpperCase()));
  const activity = companionActivity(snapshot?.run ?? null, step, agent, attempt, now, pendingQuestion);
  const setPreference = useCallback((patch: Partial<Preferences>) => setPrefs((old) => {
    const next = { ...old, ...patch, position: patch.position ? { ...old.position, ...patch.position } : old.position };
    try { localStorage.setItem(PREF_KEY, JSON.stringify(next)); } catch {}
    return next;
  }), []);
  const closePanel = useCallback(() => { setOpen(false); setPreference({ minimized: true }); }, [setPreference]);
  const togglePanel = useCallback(() => {
    const next = !open;
    setOpen(next);
    setPreference({ minimized: !next });
  }, [open, setPreference]);

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    pointerStart.current = { x: event.clientX, y: event.clientY, right: prefs.position.right, bottom: prefs.position.bottom };
    dragPosition.current = prefs.position;
    moved.current = false;
    const move = (pointer: PointerEvent) => {
      if (!pointerStart.current) return;
      const dx = pointer.clientX - pointerStart.current.x, dy = pointer.clientY - pointerStart.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) moved.current = true;
      if (!moved.current) return;
      const panelWidth = Math.min(window.innerWidth - 16, window.innerWidth < 600 ? 280 : 310);
      const maxRight = Math.max(8, window.innerWidth - panelWidth - 8);
      const maxBottom = open ? Math.max(8, window.innerHeight - Math.min(window.innerHeight * .7, 540) - 86) : Math.max(8, window.innerHeight - 76);
      dragPosition.current = { right: Math.max(8, Math.min(maxRight, pointerStart.current.right - dx)), bottom: Math.max(8, Math.min(maxBottom, pointerStart.current.bottom - dy)) };
      const root = avatarRef.current?.closest<HTMLElement>(".global-companion");
      if (root) { root.style.right = `${dragPosition.current.right}px`; root.style.bottom = `${dragPosition.current.bottom}px`; }
    };
    const end = () => {
      pointerStart.current = null;
      if (moved.current) setPreference({ position: dragPosition.current });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    const clamp = () => {
      const panelWidth = Math.min(window.innerWidth - 16, window.innerWidth < 600 ? 280 : 310);
      const maxRight = Math.max(8, window.innerWidth - panelWidth - 8);
      const maxBottom = open ? Math.max(8, window.innerHeight - Math.min(window.innerHeight * .7, 540) - 86) : Math.max(8, window.innerHeight - 76);
      setPreference({ position: { right: Math.min(prefs.position.right, maxRight), bottom: Math.min(prefs.position.bottom, maxBottom) } });
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [open, prefs.position.bottom, prefs.position.right, setPreference]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { closePanel(); avatarRef.current?.focus(); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, closePanel]);

  if (prefs.hidden) return <button className="companion-restore" onClick={() => setPreference({ hidden: false })} aria-label={t("companion.restore")} title={t("companion.restore")}><Eye size={16} /><span>{prefs.name}</span></button>;
  const stateText = t(STATE_I18N[activity.state]);
  const statusText = activity.status ? t(STATUS_I18N[activity.status] ?? "status.PENDING") : stateText;
  const context = sectionLabel(section, t);
  const provider = activity.provider ? `${activity.provider}${activity.model ? ` · ${activity.model}` : ""}` : null;
  const runHref = activity.run ? `#/runs/${activity.run.id}${activity.step?.key ? `/${encodeURIComponent(activity.step.key)}` : ""}` : "#/office";
  const actionKey = activity.action === "approval" ? "companion.openApproval" : activity.action === "question" ? "companion.openQuestion" : activity.action === "handoff" ? "companion.openHandoff" : activity.action === "failure" ? "companion.openFailure" : activity.run ? "companion.openRun" : "companion.openOffice";
  const message = activity.run
    ? activity.state === "APPROVAL_REQUIRED" ? t("companion.messageApproval", { n: activity.run.id })
      : activity.state === "ASKING" ? t("companion.messageQuestion", { n: activity.run.id })
      : activity.state === "HANDOFF" ? activity.failureCategory ? t("companion.messageProviderUnavailable", { provider: provider ?? t("companion.agent"), n: activity.run.id }) : t("companion.messageHandoff", { n: activity.run.id })
      : activity.state === "FAILED" ? t("companion.messageFailed", { n: activity.run.id })
      : activity.state === "CELEBRATING" || activity.state === "SUCCESS" ? t("companion.messageSuccess", { n: activity.run.id })
      : activity.state === "WAITING" ? t("companion.messageWaiting", { n: activity.run.id })
      : t("companion.messageWorking", { provider: provider ?? t("companion.agent"), step: activity.detail ?? t("companion.activeStep") })
    : loading ? t("companion.loading") : t("companion.messageSleeping");

  return <div className={`global-companion intensity-${prefs.intensity}${open ? " is-open" : ""}`} data-visible={visible} style={{ right: `max(${prefs.position.right}px, env(safe-area-inset-right))`, bottom: `max(${prefs.position.bottom}px, env(safe-area-inset-bottom))` }}>
    {open && <section className="companion-panel" role="dialog" aria-modal="false" aria-labelledby="companion-title">
      <header className="companion-panel-head"><span className="companion-status-dot" data-state={activity.state} /><div className="companion-heading"><strong id="companion-title">{prefs.name}</strong><span>{stateText} · {context}</span></div>
        <button className="quiet icon" onClick={closePanel} aria-label={t("common.close")}><X size={16} /></button>
      </header>
      <p className="companion-message">{message}</p>
      {activity.run && <div className="companion-run-card">
        <div className="companion-run-title"><b>#{activity.run.id}</b><span>{activity.run.title}</span></div>
        <div className="companion-meta"><span>{activity.step?.name ?? t("companion.noCurrentStep")}</span><span className="companion-run-status">{statusText}</span></div>
        {provider && <div className="companion-provider">{provider}</div>}
      </div>}
      <div className="companion-panel-actions">
        <a className="btn companion-action" href={runHref}><ArrowUpRight size={15} />{t(actionKey)}</a>
        <a className="btn ghost companion-office-action" href="#/office"><Building2 size={15} />{t("companion.openOffice")}</a>
      </div>
      {settings && <div className="companion-settings">
        <label>{t("companion.name")}<input maxLength={32} value={prefs.name} onChange={(e) => setPreference({ name: e.target.value || "Hasaki-chan" })} /></label>
        <label>{t("companion.intensity")}<select value={prefs.intensity} onChange={(e) => setPreference({ intensity: e.target.value as Preferences["intensity"] })}><option value="off">{t("companion.noMotion")}</option><option value="subtle">{t("companion.subtle")}</option><option value="normal">{t("companion.normal")}</option><option value="playful">{t("companion.playful")}</option></select></label>
        <small className="muted">{t("companion.conceptNote")}</small>
      </div>}
      <footer className="companion-panel-foot">
        <button className="linkish" onClick={() => setSettings((v) => !v)} aria-expanded={settings}><Settings2 size={14} />{t("companion.preferences")}</button>
        <button className="linkish" onClick={closePanel}><Minus size={14} />{t("companion.minimize")}</button>
        <button className="linkish" onClick={() => { closePanel(); setPreference({ hidden: true }); }}><EyeOff size={14} />{t("companion.hide")}</button>
      </footer>
    </section>}
    <div className="companion-stage">
      <button ref={avatarRef} className="companion-avatar" aria-label={t("companion.toggle", { name: prefs.name, state: stateText })} aria-expanded={open} aria-controls="companion-title" onPointerDown={beginDrag} onClick={() => { if (!moved.current) togglePanel(); moved.current = false; }} onKeyDown={(event) => { const delta = event.shiftKey ? 32 : 12; if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); setPreference({ position: { right: prefs.position.right + (event.key === "ArrowLeft" ? delta : event.key === "ArrowRight" ? -delta : 0), bottom: prefs.position.bottom + (event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0) } }); }}>
        <HasakiCompanionAvatar state={activity.state} className="companion-art" />
        <span className="companion-orbit" aria-hidden="true" />
      </button>
    </div>
    <span className="sr-only" role="status" aria-live="polite">{activity.run ? t("companion.announce", { n: activity.run.id, state: stateText }) : stateText}</span>
  </div>;
}
