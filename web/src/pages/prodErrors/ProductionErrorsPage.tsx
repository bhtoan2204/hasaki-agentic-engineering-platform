import { RefreshCw, Siren } from "lucide-react";
import { useApi, useLive } from "../../api.ts";
import { EmptyState, ErrorBox, PageHeader, Button, Tabs, navigate } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { AnalyticsFilters, defaultFilters } from "../analytics/AnalyticsFilters.tsx";
import { AnalyticsSkeleton, type Row } from "../analytics/shared.tsx";
import { ProdErrorsPage } from "../ProdErrors.tsx";
import { ProductionOverview } from "./ProductionOverview.tsx";
import { ServiceDetails } from "./ServiceDetails.tsx";
import { ProductionIncident } from "./ProductionIncident.tsx";
import "../Insights.css";
import "../analytics/analytics.css";
import "./production-errors.css";

const TABS = ["overview", "incidents", "services", "settings"] as const;
type Tab = (typeof TABS)[number];
function ProductionAnalytics({
  query,
  tab,
  change,
}: {
  query: string;
  tab: Tab;
  change: (p: URLSearchParams) => void;
}) {
  const { t } = useI18n();
  const { data, error, loading, refreshing, reload } = useApi<Row>(
    `/api/analytics/health?${query}`,
  );
  useLive(null, (p) => {
    if (p?.kind === "status" || p?.kind === "refresh") reload();
  });
  if (loading && !data) return <AnalyticsSkeleton />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <EmptyState title={t("an.empty")} />;
  return (
    <>
      {error && <ErrorBox error={error} onRetry={reload} />}
      <div className="an-refresh">
        <span className="muted small">
          {data.filters.timezone} · {t(`an.${data.filters.bucket}`)}
        </span>
        <Button
          variant="secondary"
          size="sm"
          loading={refreshing}
          icon={<RefreshCw size={14} />}
          onClick={reload}
        >
          {t("an.refresh")}
        </Button>
      </div>
      <ProductionOverview
        data={data}
        query={query}
        servicesOnly={tab === "services"}
        page={Number(new URLSearchParams(query).get("page") || 1)}
        onChange={change}
        onPage={(n) => {
          const p = new URLSearchParams(query);
          p.set("page", String(n));
          change(p);
        }}
      />
    </>
  );
}
export function ProductionErrorsPage({
  route,
  fingerprint,
  query: raw = "",
}: {
  route?: string;
  fingerprint?: string;
  query?: string;
}) {
  const { t } = useI18n();
  const params = new URLSearchParams(raw);
  for (const [k, v] of Object.entries(defaultFilters())) if (v && !params.has(k)) params.set(k, v);
  const query = params.toString();
  const detail = route === "service";
  const incident = route === "incident" || (!!route && !TABS.includes(route as Tab) && !detail);
  const tab: Tab = detail
    ? params.get("return_tab") === "services"
      ? "services"
      : "overview"
    : incident
      ? "incidents"
      : TABS.includes(route as Tab)
        ? (route as Tab)
        : "overview";
  const analytical = !incident && (detail || tab === "overview" || tab === "services");
  const {
    data: options,
    error,
    reload,
  } = useApi<Row>(analytical ? "/api/analytics/options" : null);
  const change = (p: URLSearchParams) => {
    const service = p.get("view") === "service";
    navigate(`/prod-errors/${service || detail ? "service" : tab}?${p}`);
  };
  const range = (days: number) => {
    const p = new URLSearchParams(query);
    const to = new Date();
    p.set("to", to.toISOString());
    p.set("from", new Date(to.getTime() - days * 86400000).toISOString());
    p.set("bucket", days > 1 ? "day" : "hour");
    p.delete("page");
    change(p);
  };
  return (
    <div className="ins an pe-workspace">
      <PageHeader icon={Siren} title={t("pe.title")} subtitle={t("an.productionWorkspace")} />
      <Tabs<Tab>
        value={tab}
        tabs={TABS.map((k) => [k, t(`an.productionTab.${k}`)])}
        onChange={(k) => {
          const p = new URLSearchParams(query);
          for (const key of ["view", "return_query", "return_tab", "page"]) p.delete(key);
          navigate(`/prod-errors/${k}?${p}`);
        }}
      />
      {analytical && (
        <>
          {error && <ErrorBox error={error} onRetry={reload} />}
          <AnalyticsFilters domain="production" query={query} options={options} onApply={change} />
          {!detail && (
            <div className="an-range-buttons" aria-label={t("an.customRange")}>
              {[
                [1 / 24, "range1h"],
                [6 / 24, "range6h"],
                [1, "range24h"],
                [7, "range7d"],
                [30, "range30d"],
              ].map(([n, key]) => (
                <button key={key} className="ghost xs" onClick={() => range(Number(n))}>
                  {t(`an.${key}`)}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {incident ? (
        <ProductionIncident
          key={fingerprint || route}
          fingerprint={fingerprint || route!}
          query={query}
        />
      ) : detail ? (
        <ServiceDetails query={query} />
      ) : tab === "incidents" || tab === "settings" ? (
        <ProdErrorsPage
          focus={params.get("list_focus") ?? undefined}
          settings={tab === "settings"}
          query={query}
        />
      ) : (
        <ProductionAnalytics query={query} tab={tab} change={change} />
      )}
    </div>
  );
}
