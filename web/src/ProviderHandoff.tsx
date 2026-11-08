import { HandoffPreview } from "./HandoffPreview.tsx";
import { useState, useEffect } from "react";
import { useApi } from "./api.ts";
import { useI18n } from "./i18n/index.tsx";
import { Field, time } from "./ui.tsx";

/** Server-owned checkpoints; selecting a provider never starts execution before explicit confirmation. */
export function ProviderHandoff({
  runId,
  step,
  attempts,
  handoffs = [],
  action,
  active = true,
}: {
  active?: boolean;
  runId: number;
  step: any;
  attempts: any[];
  handoffs?: any[];
  action: (path: string, body?: any) => Promise<any>;
}) {
  const { locale } = useI18n();
  const en = locale === "en";
  const [provider, setProvider] = useState("codex"),
    [model, setModel] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const current = handoffs.find(
    (h) => h.source_attempt_id === step.current_attempt_id,
  );
  useEffect(() => setConfirmed(false), [current?.workspace_fingerprint]);
  const pending =
    active &&
    current &&
    ["STOPPING", "READY", "BLOCKED"].includes(current.status);
  const {
    data: options,
    error,
    reload,
  } = useApi<any[]>(
    show || pending
      ? `/api/runs/${runId}/steps/${step.key}/handoff-providers`
      : null,
  );
  const target = options?.find((p) => p.provider === provider);
  const send = async (path: string, body: any) => {
    setBusy(true);
    try {
      await action(path, body);
    } finally {
      setBusy(false);
      setConfirmed(false);
    }
  };
  return (
    <section className="card" style={{ margin: 12, padding: 14 }}>
      <b>{en ? "Agent handoff" : "Bàn giao agent"}</b>
      {pending && (
        <p role="status">
          <strong>
            {current.failure_category ??
              (en ? "Manual switch" : "Chuyển thủ công")}
          </strong>{" "}
          · {current.original_provider} · {current.status}
        </p>
      )}
      {current?.blocked_reason && (
        <p className="error">{current.blocked_reason}</p>
      )}
      {!pending &&
        active &&
        ["RUNNING", "FAILED", "WAITING_INPUT", "RETRYING", "CANCELED"].includes(
          step.status,
        ) && (
          <button
            className="sm"
            disabled={busy || !step.current_attempt_id}
            onClick={() => {
              setShow(true);
              void send("handoff", {
                expected_attempt_id: step.current_attempt_id,
                reason: en
                  ? "User requested provider switch"
                  : "Người dùng yêu cầu chuyển agent",
              });
            }}
          >
            {en ? "Switch Agent" : "Chuyển agent"}
          </button>
        )}
      {current?.status === "STOPPING" && (
        <p className="muted small">
          {en
            ? "Cancellation requested. Waiting for executor termination and stable Git inspection. No continuation can start yet."
            : "Đã yêu cầu hủy. Đang chờ tiến trình kết thúc và kiểm tra Git ổn định. Chưa thể chạy agent tiếp theo."}
        </p>
      )}
      {pending && (
        <>
          {(current.status !== "STOPPING" ||
            attempts.find((a) => a.id === current.source_attempt_id)
              ?.executor_stopped_at) && (
            <button
              className="sm ghost"
              disabled={busy}
              onClick={() =>
                send("handoff", {
                  expected_attempt_id: current.source_attempt_id,
                  reason: en
                    ? "User requested checkpoint reinspection"
                    : "Người dùng yêu cầu kiểm tra lại checkpoint",
                })
              }
            >
              {en
                ? "Reinspect preserved state"
                : "Kiểm tra lại trạng thái được giữ lại"}
            </button>
          )}
          <HandoffPreview handoff={current} />
          {error && (
            <p role="alert">
              {String(error)}{" "}
              <button className="quiet" onClick={reload}>
                {en ? "Retry availability check" : "Kiểm tra lại khả dụng"}
              </button>
            </p>
          )}
          <div className="grid2">
            <Field label={en ? "Target provider" : "Agent tiếp theo"}>
              <select
                aria-label={en ? "Target provider" : "Agent tiếp theo"}
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setModel("");
                  setConfirmed(false);
                }}
              >
                {["claude", "codex", "cursor", "antigravity"].map((p) => (
                  <option key={p} value={p}>
                    {p}
                    {options?.find((o) => o.provider === p)?.ok ? " ✓" : " · ?"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={en ? "Target model" : "Mô hình tiếp theo"}>
              <input
                aria-label={en ? "Target model" : "Mô hình tiếp theo"}
                list="handoff-models"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setConfirmed(false);
                }}
                placeholder={en ? "Provider default" : "Mặc định nhà cung cấp"}
              />
              <datalist id="handoff-models">
                {target?.models?.map((m: string) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
          </div>
          <p className="muted small">
            {target?.ok
              ? en
                ? "CLI readiness confirmed. Remaining quota and billing are unknown; readiness does not guarantee a successful request."
                : "CLI đã sẵn sàng. Chưa biết hạn mức còn lại và chi phí; trạng thái sẵn sàng không bảo đảm yêu cầu sẽ thành công."
              : (target?.error ??
                (en
                  ? "Checking provider availability…"
                  : "Đang kiểm tra khả dụng…"))}
          </p>
          <label className="small">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {en
              ? "I reviewed the checkpoint and preserved changes, and authorize continuation with this provider, including unreported usage/cost."
              : "Tôi đã xem checkpoint và thay đổi được giữ lại, đồng ý tiếp tục với agent này, bao gồm chi phí/sử dụng chưa được báo cáo."}
          </label>
          <button
            className="sm"
            disabled={
              busy || !confirmed || !target?.ok || current.status !== "READY"
            }
            onClick={() =>
              send("handoff-resume", {
                handoff_id: current.id,
                expected_attempt_id: current.source_attempt_id,
                provider,
                model: model || null,
                confirm: true,
                checkpoint_fingerprint: current.workspace_fingerprint,
              })
            }
          >
            {en ? "Confirm resume" : "Xác nhận tiếp tục"}
          </button>
        </>
      )}
      {(handoffs.length > 0 || attempts.length > 1) && (
        <details>
          <summary>
            {en
              ? "Handoff history & provider timeline"
              : "Lịch sử bàn giao và dòng thời gian agent"}
          </summary>
          {handoffs.map((h) => (
            <p key={h.id} className="small">
              #{h.id} · {h.original_provider} → {h.target_provider ?? "—"} ·{" "}
              {h.status} · {h.failure_category ?? h.reason} ·{" "}
              {time(h.created_at)}
            </p>
          ))}
          {attempts.map((a) => (
            <p key={a.id} className="small">
              #{a.number} · {a.agent_provider ?? a.metrics?.provider ?? "—"} ·{" "}
              {a.agent_model ?? a.metrics?.model ?? "—"} · {a.status} ·{" "}
              {time(a.started_at)}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
