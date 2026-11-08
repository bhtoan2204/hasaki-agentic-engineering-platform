import { ContextPairedStudy } from "./ContextPairedStudy.tsx";
import { FlaskConical, RefreshCw } from "lucide-react";
import { useApi } from "../../api.ts";
import { PageHeader, ErrorBox, navigate } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { AnalyticsFilters, defaultFilters } from "./AnalyticsFilters.tsx";
import { Notice, AnalyticsSkeleton, fmt } from "./shared.tsx";
import { EvaluationScorecards } from "./EvaluationScorecards.tsx";
import { EvaluationDimensions } from "./EvaluationDimensions.tsx";
import { EvaluationEvidence } from "./EvaluationEvidence.tsx";
import { ProviderExperimentForm } from "./ProviderExperimentForm.tsx";
import { EvaluationRecommendations } from "./EvaluationRecommendations.tsx";
import "./analytics.css";
export function AgentEvaluation() {
  const { locale } = useI18n();
  const en = locale === "en";
  const p = new URLSearchParams(location.hash.split("?")[1] ?? "");
  for (const [k, v] of Object.entries(defaultFilters()))
    if (v && !p.has(k)) p.set(k, v);
  const query = p.toString(),
    response = useApi<any>(`/api/agent-evaluation?${query}`),
    options = useApi<any>("/api/analytics/options");
  const change = (params: URLSearchParams) =>
    navigate(`/insights/evaluation?${params}`);
  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(query);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    change(next);
  };
  const data = response.data;
  const title = en ? "Agent Evaluation" : "Đánh giá agent";
  const common = [
    {
      label: en ? "Provider route" : "Chuỗi agent",
      value: (r: any) => r.provider_path,
    },
    {
      label: en ? "Configured models" : "Mô hình cấu hình",
      value: (r: any) => (
        <>
          {r.model_path}
          <br />
          <span className="muted small">
            {en ? "Reported: " : "Báo cáo: "}
            {r.reported_model_sets
              ?.flat()
              .map((m: any) => `${m.provider}/${m.model}`)
              .join(", ") || "—"}
          </span>
        </>
      ),
    },
    {
      label: en ? "Evidence" : "Bằng chứng",
      value: (r: any) => r.evidence_kind,
    },
    {
      label: en ? "Category / cohort" : "Loại / nhóm",
      value: (r: any) => (
        <>
          <span>
            {r.category} · {r.context_variant}
          </span>
          <br />
          <button
            className="quiet xs"
            onClick={() => filter("cohort", r.constraints_hash)}
          >
            {r.constraints_hash?.slice(0, 12)}
          </button>
        </>
      ),
    },
    {
      label: en ? "Verified / graded" : "Xác minh / chấm",
      value: (r: any) =>
        `${r.successes} / ${r.graded} (${r.distinct_tasks} ${en ? "tasks" : "nhiệm vụ"})`,
    },
    {
      label: en ? "Verified success" : "Thành công đã xác minh",
      value: (r: any) => fmt(r.verified_success_rate, "pct"),
    },
    {
      label: "p50 / p95",
      value: (r: any) => `${fmt(r.median_ms, "ms")} / ${fmt(r.p95_ms, "ms")}`,
    },
    {
      label: en ? "Reported cost / coverage" : "Chi phí báo cáo / độ đầy đủ",
      value: (r: any) =>
        `${fmt(r.reported_cost_usd, "usd")} · ${r.cost_samples}/${r.samples} ${en ? "cases" : "nhiệm vụ"}; ${r.cost_attempts_known ?? 0}/${r.phase_attempts ?? 0} ${en ? "complete attempts" : "lần thử đầy đủ"}`,
    },
    {
      label: en ? "Tokens in / out / coverage" : "Token vào / ra / độ đầy đủ",
      value: (r: any) =>
        `${fmt(r.input_tokens)} / ${fmt(r.output_tokens)} · ${en ? "in" : "vào"} ${r.token_samples}/${r.samples}; ${en ? "out" : "ra"} ${r.output_token_samples}/${r.samples}`,
    },
  ];
  return (
    <div className="ins an">
      <PageHeader
        icon={FlaskConical}
        title={title}
        subtitle={
          en
            ? "Controlled benchmarks and clearly separated production observations"
            : "Benchmark có kiểm soát và quan sát sản xuất được tách biệt"
        }
        actions={
          <button className="sm ghost" onClick={response.reload}>
            <RefreshCw size={14} />
            {en ? "Refresh" : "Làm mới"}
          </button>
        }
      />
      <div className="tabs">
        {["health", "usage", "performance", "workflows"].map((tab) => (
          <a key={tab} className="tab" href={`#/insights/${tab}?${query}`}>
            {
              {
                health: en ? "Production health" : "Sức khỏe sản xuất",
                usage: en ? "AI usage" : "Sử dụng AI",
                performance: en ? "Performance" : "Hiệu năng",
                workflows: en ? "Workflows" : "Workflow",
              }[tab]
            }
          </a>
        ))}
        <span className="tab active">{title}</span>
      </div>
      <AnalyticsFilters query={query} options={options.data} onApply={change} />
      <div className="an-filter-grid" style={{ marginBottom: 16 }}>
        <label>
          {en ? "Task category" : "Loại nhiệm vụ"}
          <input
            aria-label={en ? "Task category" : "Loại nhiệm vụ"}
            value={p.get("category") ?? ""}
            onChange={(e) => filter("category", e.target.value)}
          />
        </label>
        <label>
          {en ? "Difficulty" : "Độ khó"}
          <select
            value={p.get("difficulty") ?? ""}
            onChange={(e) => filter("difficulty", e.target.value)}
          >
            <option value="">{en ? "All" : "Tất cả"}</option>
            {["easy", "medium", "hard"].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          {en ? "Context" : "Ngữ cảnh"}
          <select
            value={p.get("context_variant") ?? ""}
            onChange={(e) => filter("context_variant", e.target.value)}
          >
            <option value="">{en ? "All" : "Tất cả"}</option>
            {["minimal", "pack", "tools", "legacy"].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          {en ? "Control cohort" : "Nhóm kiểm soát"}
          <input
            value={p.get("cohort") ?? ""}
            onChange={(e) => filter("cohort", e.target.value)}
          />
        </label>
      </div>
      <Notice>
        {en
          ? "Fixture controls are not model rankings. Compare only the same cohort, category and context policy. Unknown usage/cost stays unknown; estimates are not API bills. Production observations are not causal benchmark conclusions."
          : "Fixture không xếp hạng mô hình. Chỉ so sánh cùng nhóm, loại nhiệm vụ và chính sách ngữ cảnh. Chi phí/token chưa báo cáo vẫn chưa rõ; ước tính không phải hóa đơn API. Quan sát sản xuất không phải kết luận nhân quả."}
      </Notice>
      {response.error && (
        <ErrorBox error={response.error} onRetry={response.reload} />
      )}
      {!data && !response.error && <AnalyticsSkeleton />}
      {data && (
        <>
          <EvaluationScorecards data={data} common={common} />
          <EvaluationDimensions data={data} common={common} />
          <EvaluationEvidence
            data={data}
            onPage={(n) => filter("page", String(n))}
          />
        </>
      )}
      <ContextPairedStudy />
      <EvaluationRecommendations />
      <ProviderExperimentForm
        admin={!!options.data?.can_manage_incidents}
        onCreated={response.reload}
      />
    </div>
  );
}
