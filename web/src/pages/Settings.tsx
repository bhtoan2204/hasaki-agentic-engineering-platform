import { IntakePolicies, IntakeQueue } from "./Intake.tsx";
import { AgentIsolation } from "./AgentIsolation.tsx";
import { AutonomyPolicies } from "./AutonomyPolicies.tsx";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  Inbox,
  RotateCcw,
  Server,
  Settings2,
  ShieldCheck,
  Link2,
  Plus,
  Trash2,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import { dialog } from "../dialog/index.ts";
import { AgentSettings } from "./AgentSettings.tsx";
import { EmptyState, ErrorBox, Field, Loading, PageHeader } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import "./Settings.css";

const PROVIDERS = ["claude", "codex", "cursor", "antigravity", "copilot"] as const;
type ProviderId = (typeof PROVIDERS)[number];

type Form = {
  model: string;
  models: Record<string, Record<string, string>>;
  fileBaseUrl: string;
  relatedProjects: Record<string, string[]>;
  bitbucketAccess: "strict" | "personal" | "trusted";
  signozAllowedHosts: string[];
  maxTurns: number;
  defaultProvider: string;
  enabledProviders: Record<ProviderId, boolean>;
  codex: { model: string; reasoningEffort: string };
  antigravity: { model: string; effort: string; sandbox: boolean; maxConcurrent: number };
  copilot: { model: string; effort: string; sandbox: boolean; maxConcurrent: number };
  costBudget: {
    runUsd: number | null;
    workItemUsd: number | null;
    warnPct: number;
    action: "pause" | "warn";
    unknownEstimate: "warn" | "pause";
  };
  scheduler: { workers: number; lightWorkers: number };
  routing: { sensitiveProviders: string[] };
  hasakiWork: { pollMinutes: number; autoPick: boolean; autoWorkflow: string };
};
type View = { effective: Form; saved: Partial<Record<keyof Form, unknown>> };

type SectionId =
  "agents" | "models" | "providers" | "integration" | "budget" | "scheduler" | "routing" | "work";
const SECTIONS: Array<{ id: SectionId; icon: LucideIcon; keys: Array<keyof Form> }> = [
  { id: "agents", icon: Bot, keys: [] },
  { id: "budget", icon: Wallet, keys: ["costBudget"] },
  { id: "scheduler", icon: Server, keys: ["scheduler"] },
  { id: "routing", icon: ShieldCheck, keys: ["routing"] },
  {
    id: "integration",
    icon: Link2,
    keys: ["fileBaseUrl", "relatedProjects", "bitbucketAccess", "signozAllowedHosts"],
  },
  { id: "work", icon: Inbox, keys: ["hasakiWork"] },
];

function fromEffective(e: Form): Form {
  return {
    ...e,
    models: Object.fromEntries(Object.entries(e.models ?? {}).map(([k, v]) => [k, { ...v }])),
    fileBaseUrl: e.fileBaseUrl ?? "",
    relatedProjects: Object.fromEntries(
      Object.entries(e.relatedProjects ?? {}).map(([k, v]) => [k, [...v]]),
    ),
    bitbucketAccess: e.bitbucketAccess ?? "strict",
    signozAllowedHosts: [...(e.signozAllowedHosts ?? [])],
    codex: { ...e.codex },
    antigravity: { ...e.antigravity },
    copilot: { ...e.copilot },
    costBudget: { ...e.costBudget },
    scheduler: { ...e.scheduler },
    enabledProviders: { ...e.enabledProviders },
    routing: { sensitiveProviders: [...e.routing.sensitiveProviders] },
    hasakiWork: { ...e.hasakiWork },
  };
}

/** Empty cells mean "inherit": they are not stored. */
function pruneModels(models: Form["models"]) {
  return Object.fromEntries(
    Object.entries(models)
      .map(([profile, roles]) => [
        profile,
        Object.fromEntries(Object.entries(roles).filter(([, m]) => m.trim())),
      ])
      .filter(([, roles]) => Object.keys(roles).length),
  ) as Form["models"];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const normalize = (f: Form): Form => ({
  ...f,
  models: pruneModels(f.models),
  signozAllowedHosts: f.signozAllowedHosts.map((h) => h.trim()).filter(Boolean),
});

export function SettingsPage() {
  const { t } = useI18n();
  const { data, error, loading, reload, setData } = useApi<View>("/api/settings/operator");
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [active, setActive] = useState<SectionId>("agents");

  /** Related-project rows keep what is being typed; the form holds the parsed mapping. */
  const [related, setRelated] = useState<Array<{ project: string; links: string }>>([]);
  const reset = (f: Form) => {
    setForm(f);
    setRelated(
      Object.entries(f.relatedProjects).map(([project, links]) => ({
        project,
        links: links.join(", "),
      })),
    );
  };
  const editRelated = (rows: Array<{ project: string; links: string }>) => {
    setRelated(rows);
    const relatedProjects: Form["relatedProjects"] = {};
    for (const r of rows) {
      const links = r.links
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      if (r.project.trim() && links.length) relatedProjects[r.project.trim()] = links;
    }
    set({ relatedProjects });
  };

  useEffect(() => {
    if (data?.effective) reset(fromEffective(data.effective));
  }, [data]);

  const baseline = useMemo(
    () => (data?.effective ? normalize(fromEffective(data.effective)) : null),
    [data],
  );
  const dirtyKeys = useMemo(() => {
    if (!form || !baseline) return new Set<keyof Form>();
    const now = normalize(form);
    return new Set(
      (Object.keys(baseline) as Array<keyof Form>).filter((k) => !same(now[k], baseline[k])),
    );
  }, [form, baseline]);
  const dirty = dirtyKeys.size > 0;
  const overridden = (keys: Array<keyof Form>) =>
    keys.some((k) => !!data?.saved && Object.prototype.hasOwnProperty.call(data.saved, k));

  const set = (patch: Partial<Form>) => {
    setNote(null);
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  const save = useCallback(async () => {
    if (!form || busy || !dirty) return;
    setBusy(true);
    setNote(null);
    try {
      const operator = Object.fromEntries(
        Object.entries(normalize(form)).filter(
          ([key]) =>
            ![
              "model",
              "models",
              "maxTurns",
              "defaultProvider",
              "enabledProviders",
              "codex",
              "antigravity",
              "copilot",
            ].includes(key),
        ),
      );
      const view = await api("/api/settings/operator", operator);
      setData(view);
      setNote({ text: t("set.saved"), ok: true });
    } catch (e) {
      setNote({ text: (e as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  }, [form, busy, dirty, setData, t]);

  async function restore() {
    if (busy) return;
    const ok = await dialog.confirm({
      title: t("set.restore.title"),
      description: t("set.confirmRestore"),
      confirmLabel: t("set.restore.action"),
      cancelLabel: t("common.cancel"),
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setNote(null);
    try {
      const view = await api("/api/settings/operator/clear", {});
      setData(view);
      setNote({ text: t("set.restored"), ok: true });
    } catch (e) {
      setNote({ text: (e as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [save, dirty]);

  const ready = !!form;
  useEffect(() => {
    if (!ready) return;
    const els = SECTIONS.map((s) => document.getElementById(`set-${s.id}`)).filter(
      (el): el is HTMLElement => !!el,
    );
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id.replace("set-", "") as SectionId);
      },
      { rootMargin: "-15% 0px -70% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ready]);

  if (loading && !form) return <Loading />;
  if (!form)
    return (
      <>
        <PageHeader icon={Settings2} title={t("set.title")} subtitle={t("set.subtitle")} />
        {error ? (
          <ErrorBox error={error} onRetry={reload} />
        ) : (
          <EmptyState title={t("common.noData")} />
        )}
      </>
    );

  const usd = (n: number | null) => (n == null ? "" : String(n));
  const parseUsd = (raw: string) => {
    const v = raw.trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const section = (id: SectionId, body: ReactNode, aside?: ReactNode) => {
    const meta = SECTIONS.find((s) => s.id === id)!;
    const changed = meta.keys.some((k) => dirtyKeys.has(k));
    return (
      <section id={`set-${id}`} className="card set-section">
        <header className="set-section-head">
          <meta.icon size={18} aria-hidden />
          <h3>{t(`set.nav.${id}`)}</h3>
          {aside}
          {changed ? (
            <span className="set-flag is-dirty">{t("set.flagUnsaved")}</span>
          ) : overridden(meta.keys) ? (
            <span className="set-flag is-saved" title={t("set.flagSavedHint")}>
              {t("set.flagSaved")}
            </span>
          ) : (
            <span className="set-flag" title={t("set.flagConfigHint")}>
              {t("set.flagConfig")}
            </span>
          )}
        </header>
        {body}
      </section>
    );
  };

  const toggle = (checked: boolean, onChange: (v: boolean) => void, label: string) => (
    <span className="set-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </span>
  );

  return (
    <>
      <PageHeader
        icon={Settings2}
        title={t("set.title")}
        subtitle={t("set.subtitle")}
        actions={
          <button className="ghost" disabled={busy} onClick={restore} title={t("set.restoreHint")}>
            <RotateCcw size={14} aria-hidden /> {t("set.restore")}
          </button>
        }
      />
      <p className="muted small">{t("set.dbNote")}</p>
      {error && <ErrorBox error={error} />}

      <div className="set-layout">
        <nav className="set-nav" aria-label={t("set.title")}>
          {SECTIONS.map((s) => {
            const changed = s.keys.some((k) => dirtyKeys.has(k));
            return (
              <a
                key={s.id}
                href={`#set-${s.id}`}
                aria-current={active === s.id ? "true" : undefined}
                className={active === s.id ? "is-active" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  setActive(s.id);
                  document
                    .getElementById(`set-${s.id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                <s.icon size={15} aria-hidden />
                <span>{t(`set.nav.${s.id}`)}</span>
                {changed ? (
                  <i className="set-dot is-dirty" title={t("set.flagUnsaved")} />
                ) : overridden(s.keys) ? (
                  <i className="set-dot is-saved" title={t("set.flagSaved")} />
                ) : null}
              </a>
            );
          })}
        </nav>

        <div className="set-content">
          <AgentSettings />
          <AutonomyPolicies />
          <AgentIsolation />
          <IntakePolicies />
          <IntakeQueue all />

          {section(
            "budget",
            <div className="grid2">
              <Field label={t("set.runUsd")}>
                <span className="set-affix">
                  <b aria-hidden>$</b>
                  <input
                    inputMode="decimal"
                    placeholder={t("set.unlimited")}
                    value={usd(form.costBudget.runUsd)}
                    onChange={(e) =>
                      set({ costBudget: { ...form.costBudget, runUsd: parseUsd(e.target.value) } })
                    }
                  />
                </span>
              </Field>
              <Field label={t("set.workItemUsd")}>
                <span className="set-affix">
                  <b aria-hidden>$</b>
                  <input
                    inputMode="decimal"
                    placeholder={t("set.unlimited")}
                    value={usd(form.costBudget.workItemUsd)}
                    onChange={(e) =>
                      set({
                        costBudget: { ...form.costBudget, workItemUsd: parseUsd(e.target.value) },
                      })
                    }
                  />
                </span>
              </Field>
              <Field label={t("set.warnPct")}>
                <span className="set-range">
                  <input
                    type="range"
                    min={10}
                    max={100}
                    step={5}
                    value={Math.round(form.costBudget.warnPct * 100)}
                    onChange={(e) =>
                      set({
                        costBudget: {
                          ...form.costBudget,
                          warnPct: Math.min(1, Math.max(0.1, Number(e.target.value) / 100)),
                        },
                      })
                    }
                  />
                  <output>{Math.round(form.costBudget.warnPct * 100)}%</output>
                </span>
              </Field>
              <Field label={t("set.action")}>
                <select
                  value={form.costBudget.action}
                  onChange={(e) =>
                    set({
                      costBudget: {
                        ...form.costBudget,
                        action: e.target.value as Form["costBudget"]["action"],
                      },
                    })
                  }
                >
                  <option value="pause">{t("set.actionPause")}</option>
                  <option value="warn">{t("set.actionWarn")}</option>
                </select>
              </Field>
              <Field label={t("set.unknown")}>
                <select
                  value={form.costBudget.unknownEstimate}
                  onChange={(e) =>
                    set({
                      costBudget: {
                        ...form.costBudget,
                        unknownEstimate: e.target.value as Form["costBudget"]["unknownEstimate"],
                      },
                    })
                  }
                >
                  <option value="warn">{t("set.unknownWarn")}</option>
                  <option value="pause">{t("set.unknownPause")}</option>
                </select>
              </Field>
            </div>,
          )}

          {section(
            "scheduler",
            <div className="grid2">
              <Field label={t("set.workers")}>
                <input
                  type="number"
                  min={1}
                  max={32}
                  value={form.scheduler.workers}
                  onChange={(e) =>
                    set({ scheduler: { ...form.scheduler, workers: Number(e.target.value) } })
                  }
                />
              </Field>
              <Field label={t("set.lightWorkers")}>
                <input
                  type="number"
                  min={0}
                  max={16}
                  value={form.scheduler.lightWorkers}
                  onChange={(e) =>
                    set({ scheduler: { ...form.scheduler, lightWorkers: Number(e.target.value) } })
                  }
                />
              </Field>
            </div>,
            <span className="set-flag is-warn" title={t("set.restart")}>
              {t("set.needsRestart")}
            </span>,
          )}

          {section(
            "routing",
            <Field label={t("set.sensitive")}>
              <span className="set-chips" role="group">
                {PROVIDERS.map((p) => {
                  const on = form.routing.sensitiveProviders.includes(p);
                  return (
                    <label key={p} className={`set-chip${on ? " is-on" : ""}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => {
                          const sensitiveProviders = e.target.checked
                            ? on
                              ? form.routing.sensitiveProviders
                              : [...form.routing.sensitiveProviders, p]
                            : form.routing.sensitiveProviders.filter((x) => x !== p);
                          set({ routing: { sensitiveProviders } });
                        }}
                      />
                      {p}
                    </label>
                  );
                })}
              </span>
            </Field>,
          )}

          {section(
            "integration",
            <>
              <div className="grid2">
                <Field label={t("set.fileBaseUrl")} hint={t("set.fileBaseUrlHint")}>
                  <input
                    type="url"
                    placeholder="https://"
                    value={form.fileBaseUrl}
                    onChange={(e) => set({ fileBaseUrl: e.target.value.trim() })}
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label={t("set.bitbucketAccess")}
                  hint={t(`set.access.${form.bitbucketAccess}Hint`)}
                >
                  <select
                    value={form.bitbucketAccess}
                    onChange={(e) =>
                      set({ bitbucketAccess: e.target.value as Form["bitbucketAccess"] })
                    }
                  >
                    {(["strict", "personal", "trusted"] as const).map((level) => (
                      <option key={level} value={level}>
                        {t(`set.access.${level}`)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label={t("set.signozHosts")} hint={t("set.signozHostsHint")}>
                <textarea
                  rows={2}
                  placeholder="signoz.internal.example"
                  value={form.signozAllowedHosts.join("\n")}
                  onChange={(e) => set({ signozAllowedHosts: e.target.value.split("\n") })}
                />
              </Field>
              <div className="field">
                <span>{t("set.related")}</span>
                <small className="muted">{t("set.relatedHint")}</small>
                <div className="set-related">
                  {related.map((row, i) => (
                    <div key={i} className="set-related-row">
                      <input
                        aria-label={t("set.relatedProject")}
                        placeholder={t("set.relatedProject")}
                        value={row.project}
                        onChange={(e) =>
                          editRelated(
                            related.map((r, j) =>
                              j === i ? { ...r, project: e.target.value } : r,
                            ),
                          )
                        }
                      />
                      <span aria-hidden className="muted">
                        →
                      </span>
                      <input
                        aria-label={t("set.relatedLinks")}
                        placeholder={t("set.relatedLinks")}
                        value={row.links}
                        onChange={(e) =>
                          editRelated(
                            related.map((r, j) => (j === i ? { ...r, links: e.target.value } : r)),
                          )
                        }
                      />
                      <button
                        type="button"
                        className="ghost icon"
                        aria-label={t("set.relatedRemove")}
                        onClick={() => editRelated(related.filter((_, j) => j !== i))}
                      >
                        <Trash2 size={14} aria-hidden />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="ghost sm"
                    onClick={() => editRelated([...related, { project: "", links: "" }])}
                  >
                    <Plus size={14} aria-hidden /> {t("set.relatedAdd")}
                  </button>
                </div>
              </div>
            </>,
          )}

          {section(
            "work",
            <div className="grid3 set-grid">
              <Field label={t("set.poll")}>
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={form.hasakiWork.pollMinutes}
                  onChange={(e) =>
                    set({ hasakiWork: { ...form.hasakiWork, pollMinutes: Number(e.target.value) } })
                  }
                />
              </Field>
              <Field label={t("set.autoWorkflow")}>
                <input
                  value={form.hasakiWork.autoWorkflow}
                  onChange={(e) =>
                    set({ hasakiWork: { ...form.hasakiWork, autoWorkflow: e.target.value } })
                  }
                  autoComplete="off"
                />
              </Field>
              <label className="field">
                <span>{t("set.autoPick")}</span>
                {toggle(
                  form.hasakiWork.autoPick,
                  (autoPick) => set({ hasakiWork: { ...form.hasakiWork, autoPick } }),
                  form.hasakiWork.autoPick ? t("set.on") : t("set.off"),
                )}
              </label>
            </div>,
          )}
        </div>
      </div>

      <div
        className={`set-savebar${dirty || note ? " is-visible" : ""}`}
        role="status"
        aria-live="polite"
      >
        {dirty ? (
          <span className="set-savebar-text">
            <i className="set-dot is-dirty" aria-hidden />
            {t("set.unsaved", { n: dirtyKeys.size })}
          </span>
        ) : (
          note && (
            <span className={`set-savebar-text${note.ok ? " is-ok" : " is-error"}`}>
              {note.text}
            </span>
          )
        )}
        <span className="grow" />
        {dirty && (
          <>
            <button
              className="ghost"
              disabled={busy}
              onClick={() => data?.effective && reset(fromEffective(data.effective))}
            >
              {t("set.discard")}
            </button>
            <button disabled={busy} onClick={save} title="Ctrl+S">
              {busy ? t("set.saving") : t("common.save")}
              <kbd>Ctrl S</kbd>
            </button>
          </>
        )}
        {!dirty && note && (
          <button className="ghost xs" onClick={() => setNote(null)} aria-label={t("set.dismiss")}>
            ×
          </button>
        )}
      </div>
    </>
  );
}
