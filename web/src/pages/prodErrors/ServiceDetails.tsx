import { ArrowLeft, RefreshCw } from "lucide-react";
import { useApi } from "../../api.ts";
import { EmptyState, ErrorBox } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import {
  BreakdownBars,
  DataTable,
  dateCell,
  fmt,
  Panel,
  type Row,
} from "../analytics/shared.tsx";
import { navigate } from "../../ui.tsx";
import { ObservedTrend } from "./ProductionOverview.tsx";

export function ServiceDetails({ query }: { query: string }) {
  const { t } = useI18n();
  const params = new URLSearchParams(query);
  const { data, error, loading, refreshing, reload } = useApi<Row>(
    `/api/analytics/health-service?${query}`,
  );
  const back = () => {
    const fallback = new URLSearchParams(query);
    for (const key of ["view", "return_query", "return_tab", "page"])
      fallback.delete(key);
    const original = params.get("return_query") ?? fallback.toString();
    navigate(
      `/prod-errors/${params.get("return_tab") === "services" ? "services" : "overview"}?${original ?? query}`,
    );
  };
  const page = Number(params.get("page") ?? 1);
  const changePage = (next: number) => {
    const p = new URLSearchParams(query);
    p.set("page", String(next));
    navigate(`/prod-errors/service?${p}`);
  };
  if (loading && !data)
    return (
      <div className="an-health-service-loading" aria-label={t("an.loading")}>
        <div />
        <div />
        <div />
      </div>
    );
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <EmptyState title={t("an.empty")} />;
  const s = data.summary ?? {},
    service = data.service;
  if (!service)
    return (
      <>
        <button className="ghost sm" onClick={back}>
          <ArrowLeft size={14} />
          {t("an.backToHealth")}
        </button>
        <EmptyState title={t("an.noServiceData")} />
      </>
    );
  const rows = [
    ["totalErrorEvents", s.total_errors, "number"],
    ["errorShare", service.error_share_pct, "percent"],
    ["fingerprints", service.fingerprints, "number"],
    ["criticalHighIncidents", service.critical_high_incidents, "number"],
    ["unresolved", service.unresolved_incidents, "number"],
    ["recurringIncidents", service.recurring_incidents, "number"],
    ["change", service.change_pct, "percent"],
    ["lastObservedError", service.last_observed_error, "date"],
  ] as const;
  const incidentLink = (fingerprint: string) => {
    location.hash = `/prod-errors/incident/${fingerprint}?return_to=${encodeURIComponent(`/prod-errors/service?${query}`)}`;
  };
  return (
    <div className="an-service-details">
      {error && <ErrorBox error={error} onRetry={reload} />}
      <div className="an-service-back-row">
        <button className="ghost sm" onClick={back}>
          <ArrowLeft size={14} />
          {t("an.backToHealth")}
        </button>
        {refreshing && (
          <span className="muted small">
            <RefreshCw size={13} className="spin" />
            {t("an.retrying")}
          </span>
        )}
      </div>
      <header className="an-service-heading">
        <div>
          <div className="eyebrow">
            {service.environment ?? "—"} ·{" "}
            {service.namespace ?? t("an.unknownNamespace")}
          </div>
          <h2>{service.service}</h2>
        </div>
        <span>
          {t("an.lastObservedError")}: {dateCell(service.last_observed_error)}
        </span>
      </header>
      {service.change_comparable === false && (
        <div className="an-notice an-health-coverage-warning">
          {t("an.serviceCoverageChangeUnknown")}
        </div>
      )}
      <div className="an-health-service-kpis">
        {rows.map(([key, value, style]) => (
          <div key={key}>
            <span>{t(`an.${key}`)}</span>
            <b>
              {style === "date"
                ? dateCell(value)
                : style === "percent"
                  ? `${fmt(value)}${value == null ? "" : "%"}`
                  : fmt(value)}
            </b>
            {key === "change" && service.change_events != null && (
              <small>
                {service.change_events > 0 ? "+" : ""}
                {fmt(service.change_events)} {t("an.errorEvents")}
              </small>
            )}
          </div>
        ))}
      </div>
      <div className="ins-grid">
        <Panel title={t("an.serviceErrorTrends")}>
          <ObservedTrend
            rows={data.trend ?? []}
            previous={data.previousTrend ?? []}
            from={data.range.from}
            to={data.range.to}
            bucket={data.filters.bucket}
            timezone={data.filters.timezone}
          />
        </Panel>
        <Panel title={t("an.severityMetric")}>
          <BreakdownBars
            rows={data.severity ?? []}
            field="events"
            labelKey="severity"
          />
        </Panel>
      </div>
      <Panel title={t("an.topFingerprints")}>
        <DataTable
          rows={(data.topFingerprints ?? []).map((r: Row) => ({
            ...r,
            open: (
              <button
                className="link-button mono"
                onClick={() => incidentLink(r.fingerprint)}
              >
                {r.fingerprint}
              </button>
            ),
          }))}
          columns={[
            {
              key: "open",
              label: "fingerprint",
              render: (r) => (
                <div className="an-signature">
                  {r.open}
                  <div>{r.signature}</div>
                </div>
              ),
            },
            { key: "severity", label: "severity" },
            { key: "events", label: "events", style: "number" },
            { key: "recurring", label: "recurring" },
            {
              key: "last_at",
              label: "lastSeen",
              render: (r) => dateCell(r.last_at),
            },
          ]}
        />
      </Panel>
      <Panel title={t("an.incidentsForService")}>
        <DataTable
          rows={(data.details ?? []).map((r: Row) => ({
            ...r,
            open: (
              <button
                className="link-button mono"
                onClick={() => incidentLink(r.fingerprint)}
              >
                {r.fingerprint}
              </button>
            ),
          }))}
          total={s.fingerprints ?? 0}
          page={page}
          onPage={changePage}
          columns={[
            {
              key: "open",
              label: "fingerprint",
              render: (r) => (
                <div className="an-signature">
                  {r.open}
                  <div>{r.signature}</div>
                </div>
              ),
            },
            { key: "severity", label: "severity" },
            { key: "events", label: "events", style: "number" },
            { key: "lifecycle_status", label: "status" },
            {
              key: "first_at",
              label: "firstSeen",
              render: (r) => dateCell(r.first_at),
            },
            {
              key: "last_at",
              label: "lastSeen",
              render: (r) => dateCell(r.last_at),
            },
          ]}
        />
      </Panel>
    </div>
  );
}
