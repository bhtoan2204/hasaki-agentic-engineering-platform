import { useI18n } from "../../i18n/index.tsx";
import { Empty } from "../../ui.tsx";
import { Panel, fmt } from "../analytics/shared.tsx";
import { EvaluationTable } from "./EvaluationTable.tsx";
function EvaluationQualityPlot({ rows, cost = false }: { rows?: any[]; cost?: boolean }) {
  const { t } = useI18n();
  const points = (rows ?? []).filter(
    (r) =>
      r.verified_success_rate != null &&
      (cost ? r.cost_per_verified_success != null : r.median_ms != null),
  );
  if (!points.length)
    return (
      <Empty>
        {t("an.eval.noMeasuredCoords")}
      </Empty>
    );
  const max = Math.max(
    ...points.map((r) => Number(cost ? r.cost_per_verified_success : r.median_ms)),
    1,
  );
  return (
    <svg
      viewBox="0 0 600 230"
      role="img"
      aria-label={
        cost
          ? t("an.eval.qualityVsCostAria")
          : t("an.eval.qualityVsLatencyAria")
      }
      style={{ width: "100%", maxHeight: 260 }}
    >
      <path d="M45 10 V200 H585" fill="none" stroke="var(--line)" />
      {[0, 0.5, 1].map((v) => (
        <g key={v}>
          <text x={4} y={200 - v * 180} fill="var(--ink-2)" fontSize={11}>
            {v * 100}%
          </text>
          <path d={`M45 ${200 - v * 180} H585`} stroke="var(--line)" strokeDasharray="3 5" />
        </g>
      ))}
      {points.map((r, i) => (
        <circle
          key={i}
          cx={50 + (Number(cost ? r.cost_per_verified_success : r.median_ms) / max) * 520}
          cy={200 - Number(r.verified_success_rate) * 180}
          r={6}
          fill={r.evidence_kind === "controlled_live" ? "var(--brand)" : "var(--st-wait)"}
        >
          <title>
            {r.provider_path} · {r.evidence_kind} · {fmt(r.verified_success_rate, "pct")} ·{" "}
            {fmt(cost ? r.cost_per_verified_success : r.median_ms, cost ? "usd" : "ms")}
          </title>
        </circle>
      ))}
      <text x={45} y={223} fontSize={12} fill="var(--ink-2)">
        {cost
          ? t("an.eval.reportedCostPerSuccess")
          : t("an.eval.medianCompletionTime")}
      </text>
    </svg>
  );
}
export function EvaluationScorecards({ data, common }: { data: any; common: any[] }) {
  const { t } = useI18n();
  return (
    <>
      {" "}
      <Panel
        title={t("an.eval.scorecardsTitle")}
      >
        <EvaluationTable rows={data.comparisons} columns={common} />
      </Panel>
      <div className="ins-grid">
        <Panel title={t("an.eval.qualityVsLatency")}>
          <EvaluationQualityPlot rows={data.comparisons} />
        </Panel>
        <Panel
          title={t("an.eval.qualityVsCost")}
        >
          <EvaluationQualityPlot rows={data.comparisons} cost />
        </Panel>
      </div>
    </>
  );
}
