import { useI18n } from "../../i18n/index.tsx";
import { Panel, fmt } from "../analytics/shared.tsx";
import { EvaluationTable } from "./EvaluationTable.tsx";
function EvaluationQualityPlot({
  rows,
  cost = false,
}: {
  rows: any[];
  cost?: boolean;
}) {
  const { locale } = useI18n();
  const en = locale === "en";
  const points = rows.filter(
    (r) =>
      r.verified_success_rate != null &&
      (cost ? r.cost_per_verified_success != null : r.median_ms != null),
  );
  if (!points.length)
    return (
      <p className="muted small">
        {en
          ? "No measured coordinates with sufficient coverage"
          : "Chưa có số đo đủ độ đầy đủ"}
      </p>
    );
  const max = Math.max(
    ...points.map((r) =>
      Number(cost ? r.cost_per_verified_success : r.median_ms),
    ),
    1,
  );
  return (
    <svg
      viewBox="0 0 600 230"
      role="img"
      aria-label={
        cost
          ? en
            ? "Verified quality versus reported cost"
            : "Chất lượng đã xác minh theo chi phí báo cáo"
          : en
            ? "Verified quality versus latency"
            : "Chất lượng đã xác minh theo độ trễ"
      }
      style={{ width: "100%", maxHeight: 260 }}
    >
      <path d="M45 10 V200 H585" fill="none" stroke="var(--line)" />
      {[0, 0.5, 1].map((v) => (
        <g key={v}>
          <text x={4} y={200 - v * 180} fill="var(--ink-2)" fontSize={11}>
            {v * 100}%
          </text>
          <path
            d={`M45 ${200 - v * 180} H585`}
            stroke="var(--line)"
            strokeDasharray="3 5"
          />
        </g>
      ))}
      {points.map((r, i) => (
        <circle
          key={i}
          cx={
            50 +
            (Number(cost ? r.cost_per_verified_success : r.median_ms) / max) *
              520
          }
          cy={200 - Number(r.verified_success_rate) * 180}
          r={6}
          fill={
            r.evidence_kind === "controlled_live"
              ? "var(--brand)"
              : "var(--st-wait)"
          }
        >
          <title>
            {r.provider_path} · {r.evidence_kind} ·{" "}
            {fmt(r.verified_success_rate, "pct")} ·{" "}
            {fmt(
              cost ? r.cost_per_verified_success : r.median_ms,
              cost ? "usd" : "ms",
            )}
          </title>
        </circle>
      ))}
      <text x={45} y={223} fontSize={12} fill="var(--ink-2)">
        {cost
          ? en
            ? "Reported cost per verified success"
            : "Chi phí báo cáo mỗi thành công đã xác minh"
          : en
            ? "Median completion time"
            : "Thời gian hoàn tất trung vị"}
      </text>
    </svg>
  );
}
export function EvaluationScorecards({
  data,
  common,
}: {
  data: any;
  common: any[];
}) {
  const { locale } = useI18n();
  const en = locale === "en";
  return (
    <>
      {" "}
      <Panel
        title={
          en
            ? "Provider and model benchmark scorecards"
            : "Bảng điểm benchmark theo agent và mô hình"
        }
      >
        <EvaluationTable rows={data.comparisons} columns={common} />
      </Panel>
      <div className="ins-grid">
        <Panel title={en ? "Quality vs latency" : "Chất lượng và độ trễ"}>
          <EvaluationQualityPlot rows={data.comparisons} />
        </Panel>
        <Panel
          title={
            en
              ? "Quality vs known reported cost"
              : "Chất lượng và chi phí báo cáo đã biết"
          }
        >
          <EvaluationQualityPlot rows={data.comparisons} cost />
        </Panel>
      </div>
    </>
  );
}
