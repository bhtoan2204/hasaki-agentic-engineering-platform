import { useState } from "react";
import { StepAgentFields, type StepAgentConfig } from "./StepAgentFields.tsx";
import { useI18n } from "./i18n/index.tsx";

export function StepAgentOverride({
  value,
  save,
}: {
  value?: StepAgentConfig | null;
  save: (value: StepAgentConfig | null) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value ?? {});
  const [busy, setBusy] = useState(false);
  const submit = async (v: StepAgentConfig | null) => {
    setBusy(true);
    try {
      await save(v);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="card" style={{ margin: 12, padding: 12 }}>
      <summary>{t("sao.title")}</summary>
      <p className="muted small">{t("sao.desc")}</p>
      <StepAgentFields allowVerification={false} value={draft} onChange={setDraft} />
      <div className="actions">
        <button disabled={busy} onClick={() => submit(draft)}>
          {t("sao.save")}
        </button>
        <button className="ghost" disabled={busy} onClick={() => submit(null)}>
          {t("sao.restore")}
        </button>
      </div>
    </details>
  );
}
