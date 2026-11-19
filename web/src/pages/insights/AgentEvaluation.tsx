import { ContextPairedStudy } from "./ContextPairedStudy.tsx";
import { FlaskConical, RefreshCw } from "lucide-react";
import { useApi } from "../../api.ts";
import { PageHeader, ErrorBox, navigate } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { AnalyticsFilters, defaultFilters } from "../analytics/AnalyticsFilters.tsx";
import { Notice, AnalyticsSkeleton, fmt } from "../analytics/shared.tsx";
import { EvaluationScorecards } from "./EvaluationScorecards.tsx";
import { EvaluationDimensions } from "./EvaluationDimensions.tsx";
import { EvaluationEvidence } from "./EvaluationEvidence.tsx";
import { ProviderExperimentForm } from "./ProviderExperimentForm.tsx";
import { EvaluationRecommendations } from "./EvaluationRecommendations.tsx";
import "../analytics/analytics.css";
export function AgentEvaluation() {
  const { t } = useI18n();
  const p = new URLSearchParams(location.hash.split("?")[1] ?? "");
  for (const [k, v] of Object.entries(defaultFilters())) if (v && !p.has(k)) p.set(k, v);
  const query = p.toString(),
    response = useApi<any>(`/api/agent-evaluation?${query}`),
    options = useApi<any>("/api/analytics/options");
  const change = (params: URLSearchParams) => navigate(`/insights/evaluation?${params}`);
  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(query);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    change(next);
  };
  const data = response.data;
  const title = t("an.eval.title");
  const common = [
    {
      label: t("an.eval.providerRoute"),
      value: (r: any) => r.provider_path,
    },
    {
      label: t("an.eval.configuredModels"),
      value: (r: any) => (
        <>
          {r.model_path}
          <br />
          <span className="muted small">
            {t("an.eval.reported")}
            {r.reported_model_sets
              ?.flat()
              .map((m: any) => `${m.provider}/${m.model}`)
              .join(", ") || "—"}
          </span>
        </>
      ),
    },
    {
      label: t("an.eval.evidence"),
      value: (r: any) => r.evidence_kind,
    },
    {
      label: t("an.eval.categoryCohort"),
      value: (r: any) => (
        <>
          <span>
            {r.category} · {r.context_variant}
          </span>
          <br />
          <button className="quiet xs" onClick={() => filter("cohort", r.constraints_hash)}>
            {r.constraints_hash?.slice(0, 12)}
          </button>
        </>
      ),
    },
    {
      label: t("an.eval.verifiedGraded"),
      value: (r: any) =>
        `${r.successes} / ${r.graded} (${r.distinct_tasks} ${t("an.eval.tasks")})`,
    },
    {
      label: t("an.eval.verifiedSuccess"),
      value: (r: any) => fmt(r.verified_success_rate, "pct"),
    },
    {
      label: "p50 / p95",
      value: (r: any) => `${fmt(r.median_ms, "ms")} / ${fmt(r.p95_ms, "ms")}`,
    },
    {
      label: t("an.eval.reportedCostCoverage"),
      value: (r: any) =>
        `${fmt(r.reported_cost_usd, "usd")} · ${r.cost_samples}/${r.samples} ${t("an.eval.cases")}; ${r.cost_attempts_known ?? 0}/${r.phase_attempts ?? 0} ${t("an.eval.completeAttempts")}`,
    },
    {
      label: t("an.eval.tokensCoverage"),
      value: (r: any) =>
        `${fmt(r.input_tokens)} / ${fmt(r.output_tokens)} · ${t("an.in")} ${r.token_samples}/${r.samples}; ${t("an.eval.tokensOut")} ${r.output_token_samples}/${r.samples}`,
    },
  ];
  return (
    <div className="ins an">
      <PageHeader
        icon={FlaskConical}
        title={title}
        subtitle={t("an.eval.subtitle")}
        actions={
          <button className="sm ghost" onClick={response.reload}>
            <RefreshCw size={14} />
            {t("an.refresh")}
          </button>
        }
      />
      <div className="tabs">
        {["health", "usage", "performance", "workflows"].map((tab) => (
          <a key={tab} className="tab" href={`#/insights/${tab}?${query}`}>
            {
              {
                health: t("an.eval.tab.health"),
                usage: t("an.eval.tab.usage"),
                performance: t("an.eval.tab.performance"),
                workflows: t("an.eval.tab.workflows"),
              }[tab]
            }
          </a>
        ))}
        <span className="tab active">{title}</span>
      </div>
      <AnalyticsFilters query={query} options={options.data} onApply={change} />
      <div className="an-filter-grid" style={{ marginBottom: 16 }}>
        <label>
          {t("an.eval.taskCategory")}
          <input
            aria-label={t("an.eval.taskCategory")}
            value={p.get("category") ?? ""}
            onChange={(e) => filter("category", e.target.value)}
          />
        </label>
        <label>
          {t("an.eval.difficulty")}
          <select
            value={p.get("difficulty") ?? ""}
            onChange={(e) => filter("difficulty", e.target.value)}
          >
            <option value="">{t("an.eval.all")}</option>
            {["easy", "medium", "hard"].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          {t("an.eval.context")}
          <select
            value={p.get("context_variant") ?? ""}
            onChange={(e) => filter("context_variant", e.target.value)}
          >
            <option value="">{t("an.eval.all")}</option>
            {["minimal", "pack", "tools", "legacy"].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          {t("an.eval.controlCohort")}
          <input value={p.get("cohort") ?? ""} onChange={(e) => filter("cohort", e.target.value)} />
        </label>
      </div>
      <Notice>
        {t("an.eval.fixtureControlsRankingNotice")}
      </Notice>
      {response.error && <ErrorBox error={response.error} onRetry={response.reload} />}
      {!data && !response.error && <AnalyticsSkeleton />}
      {data && (
        <>
          <EvaluationScorecards data={data} common={common} />
          <EvaluationDimensions data={data} common={common} />
          <EvaluationEvidence data={data} onPage={(n) => filter("page", String(n))} />
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
