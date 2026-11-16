import { LineChart, RefreshCw, Siren } from "lucide-react";
import { useApi, useLive } from "../../api.ts";
import {
  EmptyState,
  ErrorBox,
  PageHeader,
  Button,
  Tabs,
  navigate,
} from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import {
  AnalyticsFilters,
  defaultFilters,
} from "../analytics/AnalyticsFilters.tsx";
import { AnalyticsSkeleton, type Row } from "../analytics/shared.tsx";
import { UsageDashboard } from "./UsageDashboard.tsx";
import { PerformanceDashboard } from "./PerformanceDashboard.tsx";
import { WorkflowDashboard } from "./WorkflowDashboard.tsx";
import "../analytics/analytics.css";
export const ANALYTICS_TABS = ["usage", "performance", "workflows"] as const;
type Tab = (typeof ANALYTICS_TABS)[number];
function DashboardBody({
  tab,
  query,
  onChange,
}: {
  tab: Tab;
  query: string;
  onChange: (p: URLSearchParams) => void;
}) {
  const { t } = useI18n();
  const params = new URLSearchParams(query);
  const page = Number(params.get("page") || 1);
  const { data, error, loading, reload } = useApi<Row>(
    `/api/analytics/${tab}?${query}`,
  );
  useLive(null, (p) => {
    if (p?.kind === "status" || p?.kind === "refresh") reload();
  });
  const onPage = (n: number) => {
    const p = new URLSearchParams(query);
    p.set("page", String(n));
    onChange(p);
  };
  if (loading && !data) return <AnalyticsSkeleton />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <EmptyState title={t("an.empty")} />;
  return (
    <>
      <div className="an-refresh">
        <span className="muted small">
          {data.filters.timezone} · {t(`an.${data.filters.bucket}`)}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={reload}
          icon={<RefreshCw size={14} />}
        >
          {t("an.refresh")}
        </Button>
      </div>
      {tab === "usage" && (
        <UsageDashboard
          data={data}
          page={page}
          onPage={onPage}
          group={params.get("group_by") || "provider"}
          onGroup={(v) => {
            const p = new URLSearchParams(query);
            p.set("group_by", v);
            p.delete("page");
            onChange(p);
          }}
        />
      )}
      {tab === "performance" && (
        <PerformanceDashboard data={data} page={page} onPage={onPage} />
      )}
      {tab === "workflows" && (
        <WorkflowDashboard data={data} page={page} onPage={onPage} />
      )}
    </>
  );
}
export function AnalyticsInsights({ tabParam }: { tabParam?: string }) {
  const { t } = useI18n();
  const tab = (
    ANALYTICS_TABS.includes(tabParam?.split("?")[0] as Tab)
      ? tabParam!.split("?")[0]
      : "usage"
  ) as Tab;
  const raw = location.hash.includes("?")
    ? location.hash.slice(location.hash.indexOf("?") + 1)
    : "";
  const params = new URLSearchParams(raw);
  for (const [k, v] of Object.entries(defaultFilters()))
    if (v && !params.has(k)) params.set(k, v);
  const query = params.toString();
  const {
    data: options,
    error: optionsError,
    reload: reloadOptions,
  } = useApi<Row>("/api/analytics/options");
  const change = (p: URLSearchParams) => navigate(`/insights/${tab}?${p}`);
  return (
    <div className="ins an">
      <PageHeader
        icon={LineChart}
        title={t("an.title")}
        subtitle={t("an.subtitle")}
        actions={
          <>
            <a className="btn ghost sm" href="#/prod-errors">
              <Siren size={14} />
              {t("an.operationalErrors")}
            </a>
            <a className="btn ghost sm" href="#/insights/evaluation">
              {t("an.agentEvaluation")}
            </a>
            <a className="btn ghost sm" href="#/insights/quality">
              {t("an.advanced")}
            </a>
          </>
        }
      />
      <Tabs<Tab>
        value={tab}
        tabs={ANALYTICS_TABS.map((k) => [k, t(`an.${k}`)])}
        onChange={(k) => {
          const p = new URLSearchParams(query);
          p.delete("page");
          p.delete("view");
          p.delete("return_query");
          navigate(`/insights/${k}?${p}`);
        }}
      />
      {optionsError && (
        <ErrorBox error={optionsError} onRetry={reloadOptions} />
      )}
      <AnalyticsFilters query={query} options={options} onApply={change} />
      <DashboardBody key={tab} tab={tab} query={query} onChange={change} />
    </div>
  );
}
