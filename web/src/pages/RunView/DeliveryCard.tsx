import { GitPullRequest } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { useI18n } from "../../i18n/index.tsx";
import { act, time } from "../../ui.tsx";
import { type DeliveryState } from "./shared.tsx";

export function DeliveryCard({ runId }: { runId: number }) {
  const { t } = useI18n();
  const { data, reload } = useApi<DeliveryState>(`/api/runs/${runId}/delivery`);
  if (!data || data.mode === "off" || !data.pull_requests?.length) return null;
  return (
    <div className="rv-card">
      <div className="rv-card-head">
        <h4>
          <GitPullRequest size={16} /> {t("dl.title")}
        </h4>
        <span className="small">{t(`dl.agg.${data.aggregate}`)}</span>
      </div>
      {data.pull_requests.map((p) => (
        <div key={p.id} className="small" style={{ margin: "4px 0" }}>
          <a href={p.url} target="_blank" rel="noreferrer">
            {p.repo}
          </a>{" "}
          · <b>{p.lifecycle}</b>
          {p.lifecycle_paused && <span className="muted"> · {t("dl.paused")}</span>}
          <div className="muted">
            {t("dl.heads", {
              verified: (p.published_sha ?? "?").slice(0, 12),
              remote: (p.remote_head_sha ?? "?").slice(0, 12),
            })}
            {p.observation?.pipeline && <> · CI {p.observation.pipeline.status}</>}
            {p.repair_count > 0 && <> · {t("dl.repairs", { n: p.repair_count })}</>}
            {p.synced_at && <> · {t("dl.synced", { at: time(p.synced_at) })}</>}
          </div>
          {(p.lifecycle_reasons ?? []).map((r: string) => (
            <div key={r} className="muted">
              {r}
            </div>
          ))}
          {p.observation?.repair_plan?.reason && (
            <div className="muted">{p.observation.repair_plan.reason}</div>
          )}
          <button
            type="button"
            className="ghost sm"
            onClick={async () =>
              (await act(() =>
                api(`/api/pull-requests/${p.id}/lifecycle`, { paused: !p.lifecycle_paused }),
              )) && reload()
            }
          >
            {p.lifecycle_paused ? t("dl.resume") : t("dl.pause")}
          </button>
        </div>
      ))}
    </div>
  );
}
