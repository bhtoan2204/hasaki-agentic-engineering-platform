import { useEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, Layers, Play, StepForward, Workflow, X } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { AgentProviderField, type AgentProvider } from "../../agentProvider.tsx";
import { act, Field, navigate, toast } from "../../ui.tsx";
import { ProfilePreview, type ProfileChoice } from "../ProfilePreview.tsx";
import { useI18n } from "../../i18n/index.tsx";
import type { UiLocale } from "../../i18n/messages.ts";
import { Section } from "./shared.tsx";

export function QuickRun({ wfKey, onClose }: { wfKey: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { data: repos } =
    useApi<Array<{ name: string; enabled: boolean; self?: boolean }>>("/api/repositories");
  const { data: items } =
    useApi<Array<{ id: number; code: string; title: string }>>("/api/work-items");
  const [sel, setSel] = useState<string[]>([]);
  const [wi, setWi] = useState("");
  const [inputs, setInputs] = useState("{}");
  const [profile, setProfile] = useState<ProfileChoice>("AUTO");
  const [autonomy, setAutonomy] = useState("");
  const [outputLocale, setOutputLocale] = useState<UiLocale>(locale);
  const [agentProvider, setAgentProvider] = useState<AgentProvider>("claude");
  const [launching, setLaunching] = useState(false);
  const launchingRef = useRef(false);
  const start = async (mode: "start" | "step" | "pending") => {
    if (launchingRef.current) return;
    let parsed;
    try {
      parsed = JSON.parse(inputs || "{}");
    } catch {
      return toast(t("wfe.badInputs"));
    }
    launchingRef.current = true;
    setLaunching(true);
    const r = await act(() =>
      api<{ id: number }>("/api/runs", {
        workflow: wfKey,
        work_item_id: wi ? Number(wi) : null,
        repositories: sel,
        inputs: { ...parsed, ...(sel.length ? { repositories: sel } : {}) },
        start: mode === "start",
        profile,
        autonomy: autonomy || undefined,
        output_locale: outputLocale,
        agent_provider: agentProvider,
      }),
    );
    if (!r) {
      launchingRef.current = false;
      setLaunching(false);
      return;
    }
    if (mode === "step") await act(() => api(`/api/runs/${r.id}/start`, { step_mode: true }));
    navigate(`/runs/${r.id}`);
  };
  const enabledRepos = (repos ?? []).filter((r) => r.enabled);
  const selfWorkflow = wfKey === "platform-self-development";
  const selfNames = useMemo(
    () => (repos ?? []).filter((r) => r.enabled && r.self).map((r) => r.name),
    [repos],
  );
  useEffect(() => {
    if (selfWorkflow) setSel(selfNames);
  }, [selfWorkflow, selfNames]);
  return (
    <div className="wfe-form">
      <div className="wfe-insp-head">
        <span className="wfe-tile tone-ship">
          <Play size={17} strokeWidth={2} />
        </span>
        <div className="wfe-insp-title">
          <b>{t("wfe.runTitle", { key: wfKey })}</b>
          <span className="muted small">{t("wfe.latest")}</span>
        </div>
        <button
          type="button"
          className="quiet icon"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          <X size={17} />
        </button>
      </div>
      <div className="wfe-insp-body">
        <Section icon={Layers} title={t("wfe.context")}>
          <Field label={t("wfe.workItemOpt")}>
            <select value={wi} onChange={(e) => setWi(e.target.value)}>
              <option value="">{t("wfe.standalone")}</option>
              {(items ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.title}
                </option>
              ))}
            </select>
          </Field>
          <div className="field">
            <span>{t("wfe.repos")}</span>
            {selfWorkflow ? (
              <div className="muted small">
                {!repos
                  ? t("common.loading")
                  : selfNames.length
                    ? t("wfe.selfRepo", { repos: selfNames.join(", ") })
                    : t("wfe.selfRepoMissing")}
              </div>
            ) : enabledRepos.length === 0 ? (
              <div className="muted small">{repos ? t("wfe.noRepos") : t("common.loading")}</div>
            ) : (
              <div className="wfe-repos">
                {enabledRepos.map((r) => (
                  <label key={r.name} className={`wfe-repo${sel.includes(r.name) ? " on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={sel.includes(r.name)}
                      onChange={(e) =>
                        setSel(
                          e.target.checked ? [...sel, r.name] : sel.filter((x) => x !== r.name),
                        )
                      }
                    />{" "}
                    {r.name}
                  </label>
                ))}
              </div>
            )}
          </div>
          <Field label={t("wfe.inputs")} hint={t("wfe.inputsHint")}>
            <textarea
              className="code"
              rows={3}
              value={inputs}
              onChange={(e) => setInputs(e.target.value)}
            />
          </Field>
          <Field label={t("run.outputLanguage")} hint={t("run.outputHint")}>
            <select
              value={outputLocale}
              onChange={(e) => setOutputLocale(e.target.value as UiLocale)}
            >
              <option value="vi">{t("lang.vi")}</option>
              <option value="en">{t("lang.en")}</option>
            </select>
          </Field>
          <AgentProviderField value={agentProvider} onChange={setAgentProvider} />
        </Section>
        <Section icon={Workflow} title={t("wfe.profile")}>
          <ProfilePreview
            workflow={wfKey}
            workItemId={wi ? Number(wi) : null}
            repositories={sel}
            inputs={(() => {
              try {
                return JSON.parse(inputs || "{}");
              } catch {
                return {};
              }
            })()}
            value={profile}
            onChange={setProfile}
            autonomy={autonomy}
            onAutonomy={setAutonomy}
          />
        </Section>
        <div className="wfe-run-actions">
          <button type="button" disabled={launching} onClick={() => start("start")}>
            <Play size={15} /> {t("rv.start")}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={launching}
            onClick={() => start("step")}
          >
            <StepForward size={15} /> {t("rv.stepMode")}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={launching}
            onClick={() => start("pending")}
          >
            <FilePlus2 size={15} /> {t("wfe.createPending")}
          </button>
        </div>
      </div>
    </div>
  );
}
