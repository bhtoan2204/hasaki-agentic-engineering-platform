import { useState } from "react";
import { api } from "../../api.ts";
import { dialog } from "../../dialog/index.ts";
import { useI18n } from "../../i18n/index.tsx";
import { act } from "../../ui.tsx";
import { type PullRequestStatus } from "./shared.tsx";

/**
 * Merge readiness, CI pipeline and the human-only merge/close actions of one PR/MR. The server re-checks the run
 * owner's permission, mergeability, approvals and the required pipeline at the moment of the action.
 */
export function PullRequestControls({ id, onDone }: { id: number; onDone: () => void }) {
  const { t } = useI18n();
  const [st, setSt] = useState<PullRequestStatus | null>(null);
  const load = async () =>
    setSt((await act(() => api<PullRequestStatus>(`/api/pull-requests/${id}/status`))) ?? null);
  const pipeline = st?.pipelines?.[0] ?? st?.readiness?.pipeline ?? null;
  return (
    <div
      className="small"
      style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
    >
      <button type="button" className="sm ghost" onClick={load}>
        {t("rv.pr.status")}
      </button>
      {pipeline && (
        <span
          className={`badge ${pipeline.status === "success" ? "ok" : pipeline.status === "failed" ? "err" : ""}`}
        >
          {t("rv.pr.pipeline")} #{pipeline.id}: {pipeline.status}
        </span>
      )}
      {st?.readiness && (
        <span className="muted" title={st.readiness.reasons.join("; ")}>
          {st.readiness.mergeable
            ? t("rv.pr.mergeable")
            : `${t("rv.pr.notMergeable")}: ${st.readiness.reasons.join("; ")}`}
          {st.readiness.approvals && !st.readiness.approvals.enforced
            ? ` · ${t("rv.pr.approvalsNotEnforced")}`
            : ""}
        </span>
      )}
      {st?.readiness?.mergeable && (
        <button
          type="button"
          className="sm"
          onClick={async () => {
            const ok = await dialog.confirm({
              title: t("rv.pr.merge.title"),
              description: t("rv.pr.mergeConfirm"),
              confirmLabel: t("rv.pr.merge.action"),
              cancelLabel: t("common.cancel"),
              variant: "warning",
            });
            if (!ok) return;
            if (await act(() => api(`/api/pull-requests/${id}/merge`, {}), t("rv.pr.merged")))
              onDone();
          }}
        >
          {t("rv.pr.merge")}
        </button>
      )}
      {st && (
        <button
          type="button"
          className="sm ghost"
          onClick={async () => {
            const ok = await dialog.confirm({
              title: t("rv.pr.close.title"),
              description: t("rv.pr.closeConfirm"),
              confirmLabel: t("rv.pr.close.action"),
              cancelLabel: t("common.cancel"),
              variant: "destructive",
            });
            if (!ok) return;
            if (await act(() => api(`/api/pull-requests/${id}/close`, {}), t("rv.pr.closed")))
              onDone();
          }}
        >
          {t("rv.pr.close")}
        </button>
      )}
    </div>
  );
}
