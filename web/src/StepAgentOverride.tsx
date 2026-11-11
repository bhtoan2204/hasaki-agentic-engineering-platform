import { useState } from "react";
import { StepAgentFields } from "./StepAgentFields.tsx";
import { useI18n } from "./i18n/index.tsx";

export function StepAgentOverride({
  value,
  save,
}: {
  value?: Record<string, any> | null;
  save: (value: Record<string, any> | null) => Promise<unknown>;
}) {
  const { locale } = useI18n();
  const en = locale === "en";
  const [draft, setDraft] = useState(value ?? {});
  const [busy, setBusy] = useState(false);
  const submit = async (v: Record<string, any> | null) => {
    setBusy(true);
    try {
      await save(v);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="card" style={{ margin: 12, padding: 12 }}>
      <summary>
        {en ? "Agent settings for the next attempt" : "Cấu hình agent cho lần thử tiếp theo"}
      </summary>
      <p className="muted small">
        {en
          ? "Saved changes apply to the next attempt. Previous attempts retain their original provider and model. Retry or continue the step separately."
          : "Thay đổi áp dụng cho lần thử tiếp theo. Các lần thử trước giữ nguyên nhà cung cấp và mô hình. Thử lại hoặc tiếp tục bước bằng thao tác riêng."}
      </p>
      <StepAgentFields allowVerification={false} value={draft} onChange={setDraft} />
      <div className="actions">
        <button disabled={busy} onClick={() => submit(draft)}>
          {en ? "Save override" : "Lưu ghi đè"}
        </button>
        <button className="ghost" disabled={busy} onClick={() => submit(null)}>
          {en ? "Restore step defaults" : "Khôi phục mặc định của bước"}
        </button>
      </div>
    </details>
  );
}
