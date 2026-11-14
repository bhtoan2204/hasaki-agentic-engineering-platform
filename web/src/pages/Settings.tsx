import { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import { api, useApi } from "../api.ts";
import { ErrorBox, Field, Loading, PageHeader } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";

const PROVIDERS = ["claude", "codex", "cursor", "antigravity"] as const;
const EFFORTS = ["", "low", "medium", "high", "xhigh"] as const;
const AGY_EFFORTS = ["", "low", "medium", "high", "xhigh", "max"] as const;

type Form = {
  model: string;
  maxTurns: number;
  defaultProvider: string;
  enabledProviders: Record<(typeof PROVIDERS)[number], boolean>;
  codex: { model: string; reasoningEffort: string };
  antigravity: { model: string; effort: string; sandbox: boolean; maxConcurrent: number };
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

function fromEffective(e: Form): Form {
  return {
    ...e,
    codex: { ...e.codex },
    antigravity: { ...e.antigravity },
    costBudget: { ...e.costBudget },
    scheduler: { ...e.scheduler },
    enabledProviders: { ...e.enabledProviders },
    routing: { sensitiveProviders: [...e.routing.sensitiveProviders] },
    hasakiWork: { ...e.hasakiWork },
  };
}

export function SettingsPage() {
  const { t } = useI18n();
  const { data, error, loading, setData } = useApi<{ effective: Form }>("/api/settings/operator");
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (data?.effective) setForm(fromEffective(data.effective));
  }, [data]);

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  async function save() {
    if (!form || busy) return;
    setBusy(true);
    setNote("");
    try {
      const view = await api("/api/settings/operator", form);
      setData(view);
      setNote(t("set.saved"));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const view = await api("/api/settings/operator/clear", {});
      setData(view);
      setNote(t("set.restored"));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !form) return <Loading />;
  if (!form)
    return (
      <>
        <PageHeader icon={Settings2} title={t("set.title")} subtitle={t("set.subtitle")} />
        {error && <ErrorBox error={error} />}
      </>
    );

  const usd = (n: number | null) => (n == null ? "" : String(n));
  const parseUsd = (raw: string) => {
    const t = raw.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  return (
    <>
      <PageHeader icon={Settings2} title={t("set.title")} subtitle={t("set.subtitle")} />
      <p className="muted small">{t("set.dbNote")}</p>
      {error && <ErrorBox error={error} />}
      <div className="stack" style={{ marginTop: "var(--sp-3)" }}>
        <section className="card">
          <h3>{t("set.agents")}</h3>
          <Field label={t("set.providers")} hint={t("set.providersHint")}>
            <span className="row tight">
              {PROVIDERS.map((p) => (
                <label key={p}>
                  <input
                    type="checkbox"
                    checked={form.enabledProviders[p] !== false}
                    onChange={(e) => {
                      const enabledProviders = { ...form.enabledProviders, [p]: e.target.checked };
                      const stillOn = PROVIDERS.filter((id) => enabledProviders[id] !== false);
                      if (!stillOn.length) return;
                      const defaultProvider = stillOn.includes(
                        form.defaultProvider as (typeof PROVIDERS)[number],
                      )
                        ? form.defaultProvider
                        : stillOn[0];
                      set({ enabledProviders, defaultProvider });
                    }}
                  />{" "}
                  {p}
                </label>
              ))}
            </span>
          </Field>
          <div className="grid2">
            <Field label={t("set.provider")}>
              <select
                value={form.defaultProvider}
                onChange={(e) => set({ defaultProvider: e.target.value })}
              >
                {PROVIDERS.filter((p) => form.enabledProviders[p] !== false).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("set.claudeModel")} hint={t("set.claudeModelHint")}>
              <input
                value={form.model}
                onChange={(e) => set({ model: e.target.value })}
                autoComplete="off"
              />
            </Field>
            <Field label={t("set.maxTurns")}>
              <input
                type="number"
                min={1}
                max={500}
                value={form.maxTurns}
                onChange={(e) => set({ maxTurns: Number(e.target.value) })}
              />
            </Field>
          </div>
          <h4>{t("set.codex")}</h4>
          <div className="grid2">
            <Field label={t("set.model")}>
              <input
                value={form.codex.model}
                onChange={(e) => set({ codex: { ...form.codex, model: e.target.value } })}
                autoComplete="off"
              />
            </Field>
            <Field label={t("set.effort")}>
              <select
                value={form.codex.reasoningEffort}
                onChange={(e) => set({ codex: { ...form.codex, reasoningEffort: e.target.value } })}
              >
                {EFFORTS.map((effort) => (
                  <option key={effort || "default"} value={effort}>
                    {effort || t("set.effortDefault")}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <h4>{t("set.agy")}</h4>
          <div className="grid2">
            <Field label={t("set.model")}>
              <input
                value={form.antigravity.model}
                onChange={(e) =>
                  set({ antigravity: { ...form.antigravity, model: e.target.value } })
                }
                autoComplete="off"
              />
            </Field>
            <Field label={t("set.effort")}>
              <select
                value={form.antigravity.effort}
                onChange={(e) =>
                  set({ antigravity: { ...form.antigravity, effort: e.target.value } })
                }
              >
                {AGY_EFFORTS.map((effort) => (
                  <option key={effort || "default"} value={effort}>
                    {effort || t("set.effortDefault")}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("set.concurrent")}>
              <input
                type="number"
                min={1}
                max={8}
                value={form.antigravity.maxConcurrent}
                onChange={(e) =>
                  set({
                    antigravity: { ...form.antigravity, maxConcurrent: Number(e.target.value) },
                  })
                }
              />
            </Field>
            <label className="field">
              <span>{t("set.sandbox")}</span>
              <span>
                <input
                  type="checkbox"
                  checked={form.antigravity.sandbox}
                  onChange={(e) =>
                    set({ antigravity: { ...form.antigravity, sandbox: e.target.checked } })
                  }
                />{" "}
                {t("set.sandboxHint")}
              </span>
            </label>
          </div>
        </section>

        <div className="grid2">
          <section className="card">
            <h3>{t("set.budget")}</h3>
            <Field label={t("set.runUsd")}>
              <input
                inputMode="decimal"
                value={usd(form.costBudget.runUsd)}
                onChange={(e) =>
                  set({
                    costBudget: { ...form.costBudget, runUsd: parseUsd(e.target.value) },
                  })
                }
              />
            </Field>
            <Field label={t("set.workItemUsd")}>
              <input
                inputMode="decimal"
                value={usd(form.costBudget.workItemUsd)}
                onChange={(e) =>
                  set({
                    costBudget: { ...form.costBudget, workItemUsd: parseUsd(e.target.value) },
                  })
                }
              />
            </Field>
            <Field label={t("set.warnPct")}>
              <input
                type="number"
                min={10}
                max={100}
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
          </section>

          <section className="card">
            <h3>{t("set.scheduler")}</h3>
            <p className="muted small">{t("set.restart")}</p>
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
            <h3>{t("set.routing")}</h3>
            <Field label={t("set.sensitive")}>
              <span className="row tight">
                {PROVIDERS.map((p) => (
                  <label key={p}>
                    <input
                      type="checkbox"
                      checked={form.routing.sensitiveProviders.includes(p)}
                      onChange={(e) => {
                        const has = form.routing.sensitiveProviders.includes(p);
                        const sensitiveProviders = e.target.checked
                          ? has
                            ? form.routing.sensitiveProviders
                            : [...form.routing.sensitiveProviders, p]
                          : form.routing.sensitiveProviders.filter((x) => x !== p);
                        set({ routing: { sensitiveProviders } });
                      }}
                    />{" "}
                    {p}
                  </label>
                ))}
              </span>
            </Field>
            <h3>{t("set.work")}</h3>
            <Field label={t("set.poll")}>
              <input
                type="number"
                min={0}
                max={1440}
                value={form.hasakiWork.pollMinutes}
                onChange={(e) =>
                  set({
                    hasakiWork: { ...form.hasakiWork, pollMinutes: Number(e.target.value) },
                  })
                }
              />
            </Field>
            <label className="field">
              <span>{t("set.autoPick")}</span>
              <input
                type="checkbox"
                checked={form.hasakiWork.autoPick}
                onChange={(e) =>
                  set({ hasakiWork: { ...form.hasakiWork, autoPick: e.target.checked } })
                }
              />
            </label>
            <Field label={t("set.autoWorkflow")}>
              <input
                value={form.hasakiWork.autoWorkflow}
                onChange={(e) =>
                  set({ hasakiWork: { ...form.hasakiWork, autoWorkflow: e.target.value } })
                }
                autoComplete="off"
              />
            </Field>
          </section>
        </div>

        <div className="row">
          <button disabled={busy} onClick={save}>
            {t("common.save")}
          </button>
          <button className="ghost" disabled={busy} onClick={restore}>
            {t("set.restore")}
          </button>
          {note && <span className="small">{note}</span>}
        </div>
      </div>
    </>
  );
}
