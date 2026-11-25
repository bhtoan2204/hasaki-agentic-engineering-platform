import { useState, type ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { Field } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";

/** Paste-a-secret form shared by Argo CD, Kafka UI and Splunk. */
export function PasteForm({
  label,
  placeholder,
  busyLabel,
  onSave,
  extra,
}: {
  label: string;
  placeholder: string;
  busyLabel?: string;
  onSave: (v: string) => Promise<unknown>;
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Field label={label}>
        <textarea
          rows={3}
          className="mono"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <div className="ig-actions">
        <button
          type="button"
          className="sm"
          disabled={!value.trim() || busy}
          aria-describedby={!value.trim() ? "ig-h1" : undefined}
          onClick={async () => {
            setBusy(true);
            const ok = await onSave(value);
            setBusy(false);
            if (ok) setValue("");
          }}
        >
          <KeyRound size={14} strokeWidth={2} />
          {busy ? (busyLabel ?? t("ig.checking")) : t("ig.save")}
        </button>
        {!value.trim() && (
          <span id="ig-h1" className="muted small">
            {t("hint.fillRequired")}
          </span>
        )}
        {extra}
      </div>
    </>
  );
}
