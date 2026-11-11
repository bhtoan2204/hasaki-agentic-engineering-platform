import { trustedProductionReturn } from "./routes.ts";
import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import { useApi } from "../../api.ts";
import { EmptyState, ErrorBox } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { DataTable, dateCell, fmt, Panel, type Row } from "../analytics/shared.tsx";

export function ProductionIncident({ fingerprint, query }: { fingerprint: string; query: string }) {
  const { t } = useI18n();
  const params = new URLSearchParams(query);
  const returnTo = trustedProductionReturn(params.get("return_to"));
  const { data, error, loading, refreshing, reload } = useApi<Row>(
    `/api/prod-errors/${fingerprint}`,
  );
  if (loading && !data)
    return (
      <div className="an-health-service-loading">
        <div />
        <div />
        <div />
      </div>
    );
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <EmptyState title={t("an.empty")} />;
  const g = data.group ?? {};
  const rows: Row[] = data.observations ?? [];
  return (
    <div className="an-service-details an-prod-incident">
      <div className="an-service-back-row">
        <a className="ghost sm" href={`#${returnTo}`}>
          <ArrowLeft size={14} />
          {t("an.backToHealth")}
        </a>
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
            {g.namespace} · {g.service}
          </div>
          <h2>{g.signature || fingerprint}</h2>
          <code>{fingerprint}</code>
        </div>
        <div className="an-incident-status">
          <span className={`pill sev-${g.severity}`}>{g.severity ?? t("an.unknown")}</span>
          <span className="pill">{t(`an.${g.lifecycle_status ?? "open"}`)}</span>
        </div>
      </header>
      <div className="an-health-service-kpis">
        <div>
          <span>{t("an.errorEvents")}</span>
          <b>{rows.length ? fmt(rows.reduce((n, r) => n + Number(r.event_count ?? 0), 0)) : "—"}</b>
        </div>
        <div>
          <span>{t("an.firstSeen")}</span>
          <b>{dateCell(g.first_seen_at ?? g.first_at)}</b>
        </div>
        <div>
          <span>{t("an.lastSeen")}</span>
          <b>{dateCell(g.observed_last_at ?? rows[0]?.window_end)}</b>
        </div>
        <div>
          <span>{t("an.recurringIncidents")}</span>
          <b>{rows.length ? (g.observed_recurring ? t("an.yes") : t("an.no")) : "—"}</b>
        </div>
      </div>
      <a
        className="btn ghost sm"
        href={`#/prod-errors/incidents?${new URLSearchParams({ ...Object.fromEntries(params), list_focus: fingerprint })}`}
      >
        {t("an.operationalErrors")}
      </a>
      <Panel title={t("an.incidentEvidence")}>
        <div className="an-incident-diagnostics">
          <p>{g.sample}</p>
          {g.detail?.err && <pre>{g.detail.err}</pre>}
          {g.detail?.stack && (
            <details>
              <summary>{t("an.stackTrace")}</summary>
              <pre>{g.detail.stack}</pre>
            </details>
          )}
        </div>
        <DataTable
          rows={rows}
          columns={[
            {
              key: "window_start",
              label: "from",
              render: (r) => dateCell(r.window_start),
            },
            {
              key: "window_end",
              label: "to",
              render: (r) => dateCell(r.window_end),
            },
            { key: "event_count", label: "events", style: "number" },
            { key: "baseline_count", label: "baseline", style: "number" },
            { key: "severity", label: "severity" },
            { key: "trigger", label: "source" },
          ]}
        />
        {!rows.length && <div className="an-chart-empty">{t("an.insufficientHistory")}</div>}
      </Panel>
      <Panel title={t("an.incidentLifecycleHistory")}>
        <DataTable
          rows={data.lifecycle ?? []}
          columns={[
            { key: "action", label: "status" },
            {
              key: "created_at",
              label: "time",
              render: (r) => dateCell(r.created_at),
            },
            { key: "username", label: "user" },
            { key: "evidence", label: "evidence" },
          ]}
        />
      </Panel>
      <Panel title={t("an.relatedWork")}>
        <div className="an-incident-links an-incident-related">
          {g.work_item_id && (
            <a href={`#/work-items/${g.work_item_id}`}>
              {g.work_item_code ?? `#${g.work_item_id}`} · {g.work_item_title ?? ""}
              <ExternalLink size={13} />
            </a>
          )}
          {g.run_id && (
            <a href={`#/runs/${g.run_id}`}>
              Run #{g.run_id} · {g.run_status}
              <ExternalLink size={13} />
            </a>
          )}
          {(g.pull_requests ?? []).map((p: Row) => (
            <a key={p.url} href={p.url} target="_blank" rel="noreferrer">
              {p.repo} · {p.title}
              <ExternalLink size={13} />
            </a>
          ))}
          {!g.work_item_id && !g.run_id && !(g.pull_requests ?? []).length && (
            <span className="muted">{t("an.noRelatedWork")}</span>
          )}
        </div>
      </Panel>
    </div>
  );
}
