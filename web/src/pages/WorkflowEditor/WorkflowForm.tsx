import { BookOpen, Braces, Clock, History, Info, Settings2 } from "lucide-react";
import { Field, time } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import {
  JsonField,
  type KnowledgeOption,
  MultiPick,
  Section,
  type Spec,
  type WorkflowDef,
  knowledgeOptions,
} from "./shared.tsx";

export function WorkflowForm({
  spec,
  def,
  knowledge,
  update,
}: {
  spec: Spec;
  def: WorkflowDef;
  knowledge: KnowledgeOption[];
  update: (fn: (s: Spec) => Spec) => void;
}) {
  const { t } = useI18n();
  const scoped = knowledge.filter((k) => k.scope_type === "WORKFLOW" && k.scope_ref === def.key);
  return (
    <div className="wfe-form">
      <div className="wfe-insp-head">
        <span className="wfe-tile tone-ai">
          <Settings2 size={17} strokeWidth={2} />
        </span>
        <div className="wfe-insp-title">
          <b>{t("wfe.config")}</b>
          <span className="muted small">{t("wfe.stepCount", { n: spec.steps.length })}</span>
        </div>
      </div>
      <div className="wfe-insp-body">
        <Section icon={Info} title={t("wfe.general")}>
          <Field label={t("wfe.name")}>
            <input
              value={spec.name}
              onChange={(e) => update((s) => ({ ...s, name: e.target.value }))}
            />
          </Field>
          <Field label={t("wfe.description")}>
            <textarea
              rows={2}
              value={spec.description ?? ""}
              onChange={(e) => update((s) => ({ ...s, description: e.target.value }))}
            />
          </Field>
          <Field label={t("wfe.feedbackStep")} hint={t("wfe.feedbackHint")}>
            <select
              value={spec.feedback_step ?? ""}
              onChange={(e) =>
                update((s) => ({
                  ...s,
                  feedback_step: e.target.value || undefined,
                }))
              }
            >
              <option value="">{t("wfe.firstCoding")}</option>
              {spec.steps.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.key}
                </option>
              ))}
            </select>
          </Field>
        </Section>
        <Section icon={BookOpen} title={t("wfe.skillsKnowledge")}>
          <Field label={t("wfe.skillsAll")}>
            <MultiPick
              value={spec.skills ?? []}
              options={knowledgeOptions(knowledge, true)}
              placeholder={t("wfe.addSkill")}
              onChange={(v) => update((s) => ({ ...s, skills: v }))}
            />
          </Field>
          <Field label={t("wfe.rulesAll")}>
            <MultiPick
              value={spec.knowledge ?? []}
              options={knowledgeOptions(knowledge, false)}
              placeholder={t("wfe.addKnowledge")}
              onChange={(v) => update((s) => ({ ...s, knowledge: v }))}
            />
          </Field>
          {scoped.length > 0 && (
            <div className="wfe-note small">
              <div className="muted">{t("wfe.scoped", { key: def.key })}</div>
              {scoped.map((k) => (
                <div key={k.key}>
                  <BookOpen size={12} /> <a href={`#/knowledge/${k.key}`}>{k.title}</a>
                </div>
              ))}
            </div>
          )}
        </Section>
        <Section icon={Braces} title={t("wfe.runInputs")}>
          <Field label={t("wfe.runInputsLabel")}>
            <JsonField
              value={spec.inputs ?? {}}
              onChange={(v) => update((s) => ({ ...s, inputs: v }))}
            />
          </Field>
        </Section>
        <Section
          icon={History}
          title={t("wfe.versions")}
          aside={<span className="count wfe-sec-count">{def.versions.length}</span>}
        >
          {def.versions.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              {t("wfe.noVersions")}
            </p>
          ) : (
            <ol className="wfe-versions">
              {def.versions.map((v) => (
                <li key={v.version}>
                  <span className="wfe-v">v{v.version}</span>
                  <div>
                    <div className="small">
                      {v.change_note || <span className="muted">{t("wfe.noNote")}</span>}
                    </div>
                    <div className="muted wfe-v-time">
                      <Clock size={11} /> {time(v.published_at)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="muted small" style={{ marginBottom: 0 }}>
            {t("wfe.versionPinned")}
          </p>
        </Section>
      </div>
    </div>
  );
}
