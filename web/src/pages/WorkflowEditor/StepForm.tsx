import { StepAgentFields } from "../../StepAgentFields.tsx";
import { useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  Info,
  Plus,
  Repeat,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { Field, toast } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import {
  CONFIGURED,
  Check,
  DEFAULT_CONFIG,
  JsonField,
  type KnowledgeOption,
  MultiPick,
  STEP_TYPES,
  Section,
  type Spec,
  type Step,
  type StepConfig,
  ancestors,
  knowledgeOptions,
  typeIcon,
  typeTone,
} from "./shared.tsx";

export function StepForm({
  step,
  spec,
  knowledge,
  updateStep,
  renameStep,
  removeStep,
  onBack,
}: {
  step: Step;
  spec: Spec;
  knowledge: KnowledgeOption[];
  updateStep: (k: string, fn: (s: Step) => void) => void;
  renameStep: (a: string, b: string) => void;
  removeStep: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [keyDraft, setKeyDraft] = useState(step.key);
  const set = (fn: (s: Step) => void) => updateStep(step.key, fn);
  const cfg = step.config;
  const setCfg = (k: string, v: unknown) =>
    set((s) => (v === undefined || v === "" ? delete s.config[k] : (s.config[k] = v)));
  const anc = [...ancestors(spec.steps, step.key)];
  const others = spec.steps.filter((s) => s.key !== step.key).map((s) => s.key);
  const isAgent = step.type === "agent" || step.type === "coding_agent";
  const I = typeIcon(step.type);
  return (
    <div className="wfe-form">
      <div className="wfe-insp-head">
        <button
          type="button"
          className="quiet icon"
          onClick={onBack}
          aria-label={t("wfe.backConfig")}
          title={t("wfe.backConfig")}
        >
          <ArrowLeft size={17} />
        </button>
        <span className={`wfe-tile ${typeTone(step.type)}`}>
          <I size={17} strokeWidth={2} />
        </span>
        <div className="wfe-insp-title">
          <b>{step.name || step.key}</b>
          <span className="muted small">
            {t(`wfe.type.${step.type}`)} · <span className="mono">{step.key}</span>
          </span>
        </div>
        <button type="button" className="xs danger" onClick={removeStep}>
          <Trash2 size={13} /> {t("wfe.deleteStep")}
        </button>
      </div>
      <div className="wfe-insp-body">
        <Section icon={Info} title={t("wfe.general")}>
          <div className="grid2">
            <Field label={t("wfe.key")}>
              <input
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                onBlur={() => keyDraft !== step.key && renameStep(step.key, keyDraft)}
              />
            </Field>
            <Field label={t("wfe.name")}>
              <input
                value={step.name ?? ""}
                onChange={(e) => set((s) => (s.name = e.target.value))}
              />
            </Field>
          </div>
          <Field label={t("wfe.type")}>
            <select
              value={step.type}
              onChange={(e) =>
                set((s) => {
                  s.type = e.target.value;
                  s.config = structuredClone(DEFAULT_CONFIG[e.target.value]);
                })
              }
            >
              {STEP_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`wfe.type.${type}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("wfe.depends")}>
            <MultiPick
              value={step.depends_on}
              options={others
                .filter(
                  (k) =>
                    !spec.steps.find((s) => s.key === k && ancestors(spec.steps, k).has(step.key)),
                )
                .map((k) => [k, k])}
              placeholder={t("wfe.dependsPh")}
              onChange={(v) => set((s) => (s.depends_on = v))}
            />
          </Field>
        </Section>

        {CONFIGURED.has(step.type) && (
          <Section icon={I} title={t(`wfe.cfg.${step.type}`)}>
            {isAgent && (
              <>
                <Field label={t("wfe.instructions")} hint={t("wfe.instructionsHint")}>
                  <textarea
                    rows={8}
                    value={cfg.instructions ?? ""}
                    onChange={(e) => setCfg("instructions", e.target.value)}
                  />
                </Field>
                <Field label={t("wfe.outputContract")}>
                  <textarea
                    className="code"
                    rows={2}
                    value={cfg.output_contract ?? ""}
                    onChange={(e) => setCfg("output_contract", e.target.value)}
                  />
                </Field>
                <Field label={t("wfe.skills")}>
                  <MultiPick
                    value={cfg.skills ?? []}
                    options={knowledgeOptions(knowledge, true)}
                    placeholder={t("wfe.assignSkill")}
                    onChange={(v) => setCfg("skills", v.length ? v : undefined)}
                  />
                </Field>
                <Field label={t("wfe.rules")}>
                  <MultiPick
                    value={cfg.knowledge ?? []}
                    options={knowledgeOptions(knowledge, false)}
                    placeholder={t("wfe.assignKnowledge")}
                    onChange={(v) => setCfg("knowledge", v.length ? v : undefined)}
                  />
                </Field>
                <Check
                  title={t("wfe.delegateTip")}
                  checked={!!cfg.delegation?.enabled}
                  onChange={(c) =>
                    setCfg(
                      "delegation",
                      c ? { enabled: true, agents: ["explorer", "reviewer"] } : undefined,
                    )
                  }
                >
                  {t("wfe.delegate")}
                </Check>
                <StepAgentFields value={cfg.agent ?? {}} onChange={(v) => setCfg("agent", v)} />
                <div className="grid2">
                  <Field label={t("wfe.maxTurns")}>
                    <input
                      type="number"
                      value={cfg.max_turns ?? ""}
                      onChange={(e) =>
                        setCfg("max_turns", e.target.value ? Number(e.target.value) : undefined)
                      }
                    />
                  </Field>
                </div>
              </>
            )}
            {step.type === "human_input" && (
              <div className="wfe-questions">
                {(cfg.questions ?? []).map((q, i) => (
                  <div key={i} className="wfe-question">
                    <div className="wfe-question-head">
                      <span className="wfe-qn">{i + 1}</span>
                      <span className="grow muted small">{t("wfe.question")}</span>
                      <button
                        type="button"
                        className="quiet xs"
                        onClick={() => set((s) => s.config.questions?.splice(i, 1))}
                      >
                        <Trash2 size={12} /> {t("wfe.deleteQuestion")}
                      </button>
                    </div>
                    <input
                      placeholder={t("wfe.questionPh")}
                      value={q.question}
                      onChange={(e) =>
                        set((s) => {
                          const qs = s.config.questions;
                          if (qs) qs[i].question = e.target.value;
                        })
                      }
                    />
                    <input
                      placeholder={t("wfe.optionsPh")}
                      value={(q.options ?? []).join(", ")}
                      onChange={(e) =>
                        set((s) => {
                          const qs = s.config.questions;
                          if (qs)
                            qs[i].options = e.target.value
                              .split(",")
                              .map((x) => x.trim())
                              .filter(Boolean);
                        })
                      }
                    />
                  </div>
                ))}
                <button
                  type="button"
                  className="xs ghost"
                  onClick={() =>
                    set(
                      (s) =>
                        (s.config.questions = [
                          ...(s.config.questions ?? []),
                          { question: "", options: [] },
                        ]),
                    )
                  }
                >
                  <Plus size={12} /> {t("wfe.addQuestion")}
                </button>
              </div>
            )}
            {step.type === "human_approval" && (
              <>
                <Field label={t("wfe.message")}>
                  <input
                    value={cfg.message ?? ""}
                    onChange={(e) => setCfg("message", e.target.value)}
                  />
                </Field>
                <Field label={t("wfe.showOutputs")}>
                  <MultiPick
                    value={cfg.show_outputs ?? []}
                    options={anc.map((k) => [k, k])}
                    placeholder={t("wfe.prevStep")}
                    onChange={(v) => setCfg("show_outputs", v)}
                  />
                </Field>
                <Check
                  checked={!!cfg.select_repositories}
                  onChange={(c) => setCfg("select_repositories", c || undefined)}
                >
                  {t("wfe.selectRepos")}
                </Check>
                {cfg.select_repositories && (
                  <Check
                    checked={!!cfg.auto_approve_unambiguous}
                    onChange={(c) => setCfg("auto_approve_unambiguous", c || undefined)}
                  >
                    {t("wfe.autoApprove")}
                  </Check>
                )}
                <Field label={t("wfe.onReject")}>
                  <select
                    value={cfg.on_reject?.reexecute ?? ""}
                    onChange={(e) =>
                      setCfg(
                        "on_reject",
                        e.target.value ? { reexecute: e.target.value } : undefined,
                      )
                    }
                  >
                    <option value="">{t("wfe.markFailed")}</option>
                    {anc.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
            {step.type === "integration" && (
              <>
                <Field label={t("wfe.action")}>
                  <select
                    value={cfg.action ?? ""}
                    onChange={(e) => set((s) => (s.config = { action: e.target.value }))}
                  >
                    <option value="repository_discovery">{t("wfe.act.discovery")}</option>
                    <option value="select_repositories">{t("wfe.act.select")}</option>
                    <option value="publish_report">{t("wfe.act.report")}</option>
                    <option value="noop">{t("wfe.act.noop")}</option>
                  </select>
                </Field>
                {cfg.action === "repository_discovery" && (
                  <div className="grid2 wfe-align-end">
                    <Check checked={!!cfg.use_ai} onChange={(c) => setCfg("use_ai", c)}>
                      {t("wfe.aiRank")}
                    </Check>
                    <Field label={t("wfe.maxCandidates")}>
                      <input
                        type="number"
                        value={cfg.max_candidates ?? 5}
                        onChange={(e) => setCfg("max_candidates", Number(e.target.value))}
                      />
                    </Field>
                  </div>
                )}
                {cfg.action === "publish_report" && (
                  <>
                    <Field label={t("wfe.title")}>
                      <input
                        value={cfg.title ?? ""}
                        onChange={(e) => setCfg("title", e.target.value)}
                      />
                    </Field>
                    <Field label={t("wfe.gather")}>
                      <MultiPick
                        value={cfg.from ?? []}
                        options={anc.map((k) => [k, k])}
                        placeholder={t("wfe.addStepShort")}
                        onChange={(v) => setCfg("from", v)}
                      />
                    </Field>
                  </>
                )}
              </>
            )}
            {step.type === "command" && (
              <>
                <Field label={t("wfe.command")} hint={t("wfe.commandHint")}>
                  <textarea
                    className="code"
                    rows={6}
                    value={cfg.command ?? ""}
                    onChange={(e) => setCfg("command", e.target.value)}
                  />
                </Field>
                <div className="grid2 wfe-align-end">
                  <Field label={t("wfe.timeout")}>
                    <input
                      type="number"
                      value={cfg.timeout_seconds ?? 600}
                      onChange={(e) => setCfg("timeout_seconds", Number(e.target.value))}
                    />
                  </Field>
                  <Check
                    checked={!!cfg.allow_failure}
                    onChange={(c) => setCfg("allow_failure", c || undefined)}
                  >
                    {t("wfe.allowFail")}
                  </Check>
                </div>
              </>
            )}
            {step.type === "condition" && (
              <div className="grid3">
                <Field label={t("wfe.path")}>
                  <input value={cfg.path ?? ""} onChange={(e) => setCfg("path", e.target.value)} />
                </Field>
                <Field label={t("wfe.op")}>
                  <select value={cfg.op ?? "truthy"} onChange={(e) => setCfg("op", e.target.value)}>
                    {["eq", "ne", "gt", "lt", "exists", "truthy", "contains"].map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </Field>
                <Field label={t("wfe.valueJson")}>
                  <input
                    value={JSON.stringify(cfg.value ?? null)}
                    onChange={(e) => {
                      try {
                        setCfg("value", JSON.parse(e.target.value));
                      } catch {
                        /* ignore: keep the last valid value while the JSON is incomplete */
                      }
                    }}
                  />
                </Field>
              </div>
            )}
            {step.type === "git_pull_request" && (
              <>
                <Field label={t("wfe.mode")}>
                  <select
                    value={cfg.mode ?? "auto"}
                    onChange={(e) => setCfg("mode", e.target.value)}
                  >
                    <option value="approval">{t("wfe.mode.approval")}</option>
                    <option value="auto">{t("wfe.mode.auto")}</option>
                    <option value="draft">{t("wfe.mode.draft")}</option>
                    <option value="none">{t("wfe.mode.none")}</option>
                  </select>
                </Field>
                <Field label={t("wfe.contentFrom")}>
                  <select
                    value={cfg.content_from ?? ""}
                    onChange={(e) => setCfg("content_from", e.target.value)}
                  >
                    <option value="">{t("wfe.findPr")}</option>
                    {anc.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
          </Section>
        )}

        <Section icon={Repeat} title={t("wfe.execution")}>
          <Check
            checked={!!step.requires_approval}
            onChange={(c) => set((s) => (s.requires_approval = c || undefined))}
          >
            {t("wfe.gate")}
          </Check>
          <div className="grid2">
            <Field label={t("wfe.maxAttempts")}>
              <input
                type="number"
                min={1}
                max={10}
                value={step.max_attempts ?? 1}
                onChange={(e) => set((s) => (s.max_attempts = Number(e.target.value)))}
              />
            </Field>
            <Field label={t("wfe.backoff")}>
              <input
                type="number"
                min={0}
                value={step.retry_backoff_seconds ?? 5}
                onChange={(e) => set((s) => (s.retry_backoff_seconds = Number(e.target.value)))}
              />
            </Field>
          </div>
          <Field label={t("wfe.runIf")} hint={t("wfe.runIfHint")}>
            <div className="grid3">
              <select
                value={step.run_if?.step ?? ""}
                onChange={(e) =>
                  set((s) =>
                    e.target.value
                      ? (s.run_if = {
                          step: e.target.value,
                          equals: s.run_if?.equals ?? true,
                          path: s.run_if?.path,
                        })
                      : delete s.run_if,
                  )
                }
              >
                <option value="">{t("wfe.always")}</option>
                {anc.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              {step.run_if && (
                <input
                  placeholder={t("wfe.pathPh")}
                  value={step.run_if.path ?? ""}
                  onChange={(e) => set((s) => (s.run_if!.path = e.target.value || undefined))}
                />
              )}
              {step.run_if && (
                <input
                  placeholder={t("wfe.equalsPh")}
                  defaultValue={JSON.stringify(step.run_if.equals)}
                  onBlur={(e) => {
                    try {
                      const v = JSON.parse(e.target.value);
                      set((s) => (s.run_if!.equals = v));
                    } catch {
                      toast(t("wfe.equalsJson"));
                    }
                  }}
                />
              )}
            </div>
          </Field>
        </Section>

        <details className="wfe-sec wfe-adv">
          <summary className="wfe-sec-head">
            <SlidersHorizontal size={14} strokeWidth={2} /> <span>{t("wfe.advanced")}</span>
            <ChevronDown size={14} className="wfe-adv-chev" />
          </summary>
          <JsonField
            value={cfg}
            rows={10}
            onChange={(v) => v && typeof v === "object" && set((s) => (s.config = v as StepConfig))}
          />
        </details>
      </div>
    </div>
  );
}
