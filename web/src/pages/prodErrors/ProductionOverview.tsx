import { ServiceVolumeBar } from "../../components/ServiceVolumeBar.tsx";
import { ServiceIdentityCell } from "../../components/ServiceIdentityCell.tsx";
import { useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Info } from "lucide-react";
import { useI18n } from "../../i18n/index.tsx";
import {
  BreakdownBars,
  DataTable,
  dateCell,
  fmt,
  number,
  Panel,
  type Row,
} from "../analytics/shared.tsx";

const COLORS = [
  "#28a5a0",
  "#3973c6",
  "#ab69b6",
  "#db8842",
  "#7b8fa8",
  "#71a84b",
  "#dd6f75",
  "#7f6bc0",
  "#be9e37",
  "#46717c",
];
const idOf = (r: Row) => `${r.namespace ?? "unknown"}\u001f${r.service ?? "unknown"}`;
function CompareMetric({
  row,
  label,
  style = "number",
  caution = false,
}: {
  row: Row;
  label: string;
  style?: "number" | "ms";
  caution?: boolean;
}) {
  const { t } = useI18n();
  const delta = number(row.delta),
    pct = number(row.delta_pct);
  const Icon = delta != null && delta < 0 ? ArrowDownRight : ArrowUpRight;
  return (
    <div className="an-health-kpi">
      <div className="an-health-kpi-label">{label}</div>
      <strong>{fmt(row.current, style)}</strong>
      <div className="an-health-kpi-compare">
        <span>
          {t("an.previousPeriod")}: {fmt(row.previous, style)}
        </span>
        <span
          className={
            caution || delta == null
              ? "muted"
              : delta === 0
                ? ""
                : delta < 0
                  ? "an-delta-down"
                  : "an-delta-up"
          }
        >
          {caution || delta == null ? (
            "—"
          ) : (
            <>
              <Icon size={14} />
              {delta > 0 ? "+" : ""}
              {fmt(delta, style)} (
              {pct == null ? "—" : `${pct > 0 ? "+" : ""}${fmt(pct, "number")}%`})
            </>
          )}
        </span>
      </div>
      {caution && <span className="an-kpi-caution">{t("an.coverageWarning")}</span>}
    </div>
  );
}

export function ObservedTrend({
  rows,
  previous = [],
  from,
  to,
  bucket,
  timezone,
  field = "events",
  seriesMode = false,
  hidden = [],
  serviceColors = new Map<string, string>(),
}: {
  rows: Row[];
  previous?: Row[];
  from: string;
  to: string;
  bucket: string;
  timezone: string;
  field?: string;
  seriesMode?: boolean;
  hidden?: string[];
  serviceColors?: Map<string, string>;
}) {
  const { t } = useI18n();
  const begin = Date.parse(from),
    end = Date.parse(to),
    span = end - begin;
  const step = bucket === "hour" ? 3600000 : 86400000;
  const data: Row[] = [
    ...rows.map((x): Row => ({ ...x, period: "current" })),
    ...previous.map((x): Row => ({ ...x, period: "previous" })),
  ].filter((x) => !x.series || !hidden.includes(x.series));
  const values = data.map((x) => number(x[field])).filter((x): x is number => x != null);
  if (!data.length || !values.length || !(span > 0))
    return <div className="an-chart-empty">{t("an.insufficientHistory")}</div>;
  const max = Math.max(1, ...values),
    W = 900,
    H = 220,
    padX = 28,
    padY = 16;
  const x = (bucketValue: string, period: string) => {
    let ms = Date.parse(bucketValue);
    if (period === "previous") ms += span;
    return padX + Math.max(0, Math.min(1, (ms - begin) / span)) * (W - 2 * padX);
  };
  const y = (value: unknown) => H - padY - (Math.max(0, Number(value)) / max) * (H - 2 * padY);
  const groups = new Map<string, Row[]>();
  for (const r of data) {
    const key = seriesMode ? (r.series ?? `${r.namespace}\u001f${r.service}`) : r.period;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const paths: Array<{ key: string; d: string; color: string; dash: boolean }> = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => Date.parse(a.bucket) - Date.parse(b.bucket));
    let segment: Row[] = [];
    const finish = () => {
      if (segment.length) {
        paths.push({
          key: `${key}-${paths.length}`,
          d: segment
            .map(
              (r, i) =>
                `${i ? "L" : "M"}${x(r.bucket, r.period).toFixed(1)},${y(r[field]).toFixed(1)}`,
            )
            .join(" "),
          color: key === "previous" ? "var(--muted)" : (serviceColors.get(key) ?? "var(--brand)"),
          dash: key === "previous",
        });
        segment = [];
      }
    };
    for (const row of list) {
      const value = number(row[field]);
      if (value == null) {
        finish();
        continue;
      }
      const last = segment.at(-1);
      if (last && Math.abs(Date.parse(row.bucket) - Date.parse(last.bucket)) > step * 1.6) finish();
      segment.push(row);
    }
    finish();
  }
  const label = (v: string) =>
    new Date(v).toLocaleString(undefined, {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <>
      <svg
        className="an-health-line"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t("an.productionTrend")}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line
              x1={padX}
              x2={W - padX}
              y1={H - padY - v * (H - 2 * padY)}
              y2={H - padY - v * (H - 2 * padY)}
              className="an-chart-grid"
            />
            <text x={2} y={H - padY - v * (H - 2 * padY) + 4} className="an-chart-axis">
              {Math.round(max * v).toLocaleString()}
            </text>
          </g>
        ))}
        {paths.map((p) => (
          <path
            key={p.key}
            d={p.d}
            fill="none"
            stroke={p.color}
            strokeWidth="2.5"
            strokeDasharray={p.dash ? "6 5" : undefined}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {data.map((r, i) =>
          number(r[field]) == null ? null : (
            <circle
              key={`${r.period}-${r.series ?? "all"}-${i}`}
              cx={x(r.bucket, r.period)}
              cy={y(r[field])}
              r="3.5"
              fill={
                r.period === "previous"
                  ? "var(--muted)"
                  : (serviceColors.get(r.series ?? "") ?? "var(--brand)")
              }
            >
              <title>{`${label(r.bucket)} · ${r.period === "previous" ? t("an.previousPeriod") : ""} ${fmt(r[field])} ${seriesMode ? r.service : ""}`}</title>
            </circle>
          ),
        )}
      </svg>
      <div className="an-trend-axis">
        <span>{label(from)}</span>
        <span>{label(to)}</span>
      </div>
      <details className="an-chart-data">
        <summary>{t("an.errorTrend")}</summary>
        <DataTable
          rows={data}
          columns={[
            { key: "bucket", label: "from", render: (r) => dateCell(r.bucket) },
            { key: "service", label: "service" },
            { key: field, label: "events", style: "number" },
          ]}
        />
      </details>
      <div className="an-chart-legend">
        <i className="an-legend-current" />
        {t("an.currentPeriod")}{" "}
        {previous.length > 0 && (
          <>
            <i className="an-legend-previous" />
            {t("an.previousPeriod")}
          </>
        )}
      </div>
    </>
  );
}

function ServiceDonut({ rows, onSelect }: { rows: Row[]; onSelect: (r: Row) => void }) {
  const { t } = useI18n();
  const sorted = [...rows]
    .filter((r) => number(r.events) != null)
    .sort((a, b) => Number(b.events) - Number(a.events));
  const leading = sorted.slice(0, 8),
    rest = sorted.slice(8);
  if (rest.length)
    leading.push({
      service: t("an.otherServices"),
      namespace: "",
      events: rest.reduce((a, r) => a + Number(r.events), 0),
      error_share_pct: rest.reduce((a, r) => a + (number(r.error_share_pct) ?? 0), 0),
      aggregate: rest,
    });
  const totalEvents = leading.reduce((a, r) => a + Number(r.events ?? 0), 0);
  if (!totalEvents) return <div className="an-chart-empty">{t("an.noServiceData")}</div>;
  let cursor = 0;
  const parts = leading.map((r, i) => {
    const start = cursor;
    cursor += (Number(r.events) / totalEvents) * 100;
    return `${COLORS[i % COLORS.length]} ${start.toFixed(3)}% ${cursor.toFixed(3)}%`;
  });
  return (
    <div className="an-health-donut-layout">
      <div
        className="an-health-donut"
        style={{ background: `conic-gradient(${parts.join(",")})` }}
        role="img"
        aria-label={t("an.errorsByService")}
      >
        <div>
          <b>{fmt(totalEvents)}</b>
          <span>{t("an.errorEvents")}</span>
        </div>
      </div>
      <div className="an-health-donut-legend">
        {leading.map((r, i) => (
          <button
            key={r.aggregate ? "others" : idOf(r)}
            onClick={() => (r.aggregate ? undefined : onSelect(r))}
            title={`${r.service} · ${r.namespace}: ${fmt(r.events)} (${fmt(r.error_share_pct, "number")}%)`}
          >
            <i style={{ background: COLORS[i % COLORS.length] }} />
            <span>
              {r.service}
              {r.namespace ? <small>{r.namespace}</small> : null}
            </span>
            <b>{fmt(r.error_share_pct, "number")}%</b>
            <small>{fmt(r.events)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ProductionOverview({
  data,
  page,
  onPage,
  query,
  onChange,
  servicesOnly = false,
}: {
  servicesOnly?: boolean;
  data: Row;
  page: number;
  onPage: (n: number) => void;
  query: string;
  onChange: (p: URLSearchParams) => void;
}) {
  const { t } = useI18n();
  const s = data.summary ?? {};
  const compare = s.comparisons ?? {};
  const [barMetric, setBarMetric] = useState<"events" | "fingerprints">("events");
  const [severityMetric, setSeverityMetric] = useState<"events" | "fingerprints">("events");
  const [hiddenServices, setHiddenServices] = useState<string[]>([]);
  const [servicePage, setServicePage] = useState(1);
  const canCompareCoverage =
    Number(s.current_coverage?.successful_scans_in_range) ===
      Number(s.previous_coverage?.successful_scans_in_range) &&
    Number(s.current_coverage?.scans_in_range) === Number(s.previous_coverage?.scans_in_range) &&
    Number(s.current_coverage?.failed_scans_in_range) ===
      Number(s.previous_coverage?.failed_scans_in_range) &&
    Number(s.current_coverage?.window_coverage_ms) ===
      Number(s.previous_coverage?.window_coverage_ms);
  const serviceColors = useMemo(
    () =>
      new Map<string, string>(
        (data.services ?? []).map(
          (r: Row, i: number) => [idOf(r), COLORS[i % COLORS.length]] as [string, string],
        ),
      ),
    [data.services],
  );
  const serviceSelect = (r: Row) => {
    if (r.aggregate) return;
    const p = new URLSearchParams(query);
    p.set("namespace", r.namespace);
    p.set("service", r.service);
    p.delete("page");
    const returnQuery = new URLSearchParams(query);
    p.set("view", "service");
    p.set("return_query", returnQuery.toString());
    p.set("return_tab", servicesOnly ? "services" : "overview");
    onChange(p);
  };
  const allServiceRows: Row[] = data.services ?? [];
  const currentServiceRows = allServiceRows.slice(0, 10);
  const serviceTableRows = allServiceRows.slice((servicePage - 1) * 25, servicePage * 25);
  const onServicePage = (n: number) => setServicePage(n);
  const serviceTrendKeys = (data.services ?? []).slice(0, 5).map(idOf);
  const serviceTrendRows = (data.serviceTrends ?? [])
    .filter((r: Row) => serviceTrendKeys.includes(`${r.namespace}\u001f${r.service}`))
    .map((r: Row) => ({ ...r, series: `${r.namespace}\u001f${r.service}` }));
  const severityField = severityMetric === "events" ? "events" : "fingerprints";
  const freshness = data.freshness ?? {};
  const openIncident = (fp: string) => {
    const ret = encodeURIComponent(
      `/prod-errors/${servicesOnly ? "services" : "overview"}?${query}`,
    );
    location.hash = `/prod-errors/incident/${fp}?return_to=${ret}`;
  };
  return (
    <>
      <div className="an-health-freshness" data-state={freshness.status}>
        <Info size={16} />
        <span>
          {t(
            `an.${freshness.status === "current" ? "dataFresh" : freshness.status === "partial" ? "dataPartial" : freshness.status === "stale" ? "dataStale" : freshness.status === "never" ? "noScan" : freshness.status === "scanning" ? "scanning" : "scanFailed"}`,
          )}
        </span>
        <span>
          {t("an.currentDataWindow")}: {dateCell(data.range.from)} – {dateCell(data.range.to)}
        </span>
        <span>
          {t("an.lastSuccessfulScan")}: {dateCell(freshness.last_successful_scan?.finished_at)}
        </span>
        <span>
          {t("an.latestObserved")}: {dateCell(freshness.latest_observation_at)}
        </span>
        <span>
          {t("an.scanCoverage")}: {freshness.successful_scans_in_range ?? 0}/
          {freshness.scans_in_range ?? 0}
        </span>
        <span>
          {t("an.observedCoverage")}:{" "}
          {fmt(
            Math.min(
              100,
              (Number(freshness.window_coverage_ms ?? 0) /
                Math.max(1, Date.parse(data.range.to) - Date.parse(data.range.from))) *
                100,
            ),
            "number",
          )}
          %
        </span>
        <span>{freshness.data_source}</span>
        {freshness.latest_scan?.error && (
          <span className="an-freshness-error">{freshness.latest_scan.error}</span>
        )}
      </div>
      {!canCompareCoverage && (
        <div className="an-notice an-health-coverage-warning">
          <Info size={15} />
          {t("an.coverageWarning")}
        </div>
      )}
      {!servicesOnly && (
        <>
          <div className="ins-stats an-health-kpis">
            <CompareMetric
              row={compare.total_errors ?? { current: s.total_errors }}
              label={t("an.totalErrorEvents")}
              caution={!canCompareCoverage}
            />
            <CompareMetric
              row={compare.fingerprints ?? { current: s.fingerprints }}
              label={t("an.uniqueIncidents")}
              caution={!canCompareCoverage}
            />
            <CompareMetric
              row={compare.new_incidents ?? { current: s.new_incidents }}
              label={t("an.newIncidents")}
              caution={!canCompareCoverage}
            />
            <CompareMetric
              row={compare.active_incidents ?? { current: s.active_incidents }}
              label={t("an.activeIncidents")}
              caution={!canCompareCoverage}
            />
            <CompareMetric
              row={compare.resolved_incidents ?? { current: s.resolved_incidents }}
              label={t("an.resolvedIncidents")}
              caution={!canCompareCoverage}
            />
            <CompareMetric
              row={
                compare.critical_high_incidents ?? {
                  current: s.critical_high_incidents,
                }
              }
              label={t("an.criticalHighIncidents")}
              caution={!canCompareCoverage}
            />
            <CompareMetric
              row={
                compare.recurring_incidents ?? {
                  current: s.recurring_incidents,
                }
              }
              label={t("an.recurringIncidents")}
              caution={!canCompareCoverage}
            />
            <CompareMetric
              row={compare.affected_services ?? { current: s.affected_services }}
              label={t("an.affectedServices")}
              caution={!canCompareCoverage}
            />
            <CompareMetric
              row={compare.acknowledge_ms ?? { current: s.acknowledge_ms }}
              label={t("an.acknowledge")}
              style="ms"
              caution={!canCompareCoverage}
            />
            <CompareMetric
              row={compare.resolve_ms ?? { current: s.resolve_ms }}
              label={t("an.resolve")}
              style="ms"
              caution={!canCompareCoverage}
            />
          </div>
          <div className="an-notice">
            <Info size={15} />
            {t("an.healthHint")}{" "}
            {t("an.partialObservations", {
              n: s.snapshots_missing_hourly ?? 0,
              p: s.partial_hours ?? 0,
            })}
          </div>
        </>
      )}
      <div className="ins-grid">
        <Panel title={t("an.errorsByService")} hint={t("an.errorShare")}>
          <ServiceDonut rows={allServiceRows} onSelect={serviceSelect} />
          <div className="muted small">{t("an.notFailureRate")}</div>
        </Panel>
        <Panel title={t("an.topServices")}>
          <div className="an-health-toggle" role="group" aria-label={t("an.metric")}>
            <button
              className={barMetric === "events" ? "on" : ""}
              onClick={() => setBarMetric("events")}
            >
              {t("an.metricEvents")}
            </button>
            <button
              className={barMetric === "fingerprints" ? "on" : ""}
              onClick={() => setBarMetric("fingerprints")}
            >
              {t("an.metricFingerprints")}
            </button>
          </div>
          <ul className="an-health-bars">
            {currentServiceRows.map((r: Row, i: number) => {
              const value = Number(r[barMetric] ?? 0),
                max = Math.max(...currentServiceRows.map((x: Row) => Number(x[barMetric] ?? 0)), 1);
              return (
                <li key={idOf(r)}>
                  <ServiceVolumeBar
                    service={r.service}
                    namespace={r.namespace}
                    value={value}
                    percentage={number(r.error_share_pct)}
                    scale={Math.max(value ? 1 : 0, (value / max) * 100)}
                    color={COLORS[i % COLORS.length]}
                    formattedValue={fmt(value)}
                    formattedPercentage={
                      r.error_share_pct == null ? "—" : `${fmt(r.error_share_pct)}%`
                    }
                    onSelect={() => serviceSelect(r)}
                  />
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>
      <Panel title={t("an.serviceDetails")} hint={t("an.errorShare")}>
        <DataTable
          rows={serviceTableRows}
          total={allServiceRows.length}
          page={servicePage}
          onPage={onServicePage}
          columns={[
            {
              key: "service_link",
              label: "service",
              width: "45%",
              minWidth: "min(12rem, 45cqi)",
              render: (r) => (
                <ServiceIdentityCell
                  service={r.service}
                  namespace={r.namespace}
                  onSelect={() => serviceSelect(r)}
                />
              ),
            },
            {
              key: "events",
              label: "events",
              style: "number",
              minWidth: "4rem",
            },
            {
              key: "error_share_pct",
              label: "errorShare",
              align: "right",
              minWidth: "5rem",
              render: (r) => `${fmt(r.error_share_pct, "number")}%`,
            },
            {
              key: "fingerprints",
              responsivePriority: "secondary",
              label: "fingerprints",
              style: "number",
            },
            {
              key: "new_incidents",
              responsivePriority: "secondary",
              label: "newIncidents",
              style: "number",
            },
            {
              key: "unresolved_incidents",
              responsivePriority: "secondary",
              label: "unresolved",
              style: "number",
            },
            {
              key: "critical_high_errors",
              responsivePriority: "secondary",
              label: "criticalHighErrors",
              style: "number",
            },
            {
              key: "recurring_incidents",
              responsivePriority: "secondary",
              label: "recurringIncidents",
              style: "number",
            },
            {
              key: "change_pct",
              responsivePriority: "secondary",
              align: "right",
              label: "change",
              render: (r) =>
                r.change_pct == null
                  ? "—"
                  : `${r.change_pct > 0 ? "+" : ""}${fmt(r.change_pct, "number")}%`,
            },
            {
              key: "last_observed_error",
              responsivePriority: "secondary",
              label: "lastObservedError",
              render: (r) => dateCell(r.last_observed_error),
            },
          ]}
        />
      </Panel>
      {!servicesOnly && (
        <>
          <Panel title={t("an.productionTrend")} hint={data.semantics?.event_count}>
            <ObservedTrend
              rows={data.trend ?? []}
              previous={data.previousTrend ?? []}
              from={data.range.from}
              to={data.range.to}
              bucket={data.filters.bucket}
              timezone={data.filters.timezone}
            />
          </Panel>
          <div className="ins-grid">
            <Panel title={t("an.severityMetric")}>
              <div className="an-health-toggle" role="group" aria-label={t("an.metric")}>
                <button
                  className={severityMetric === "events" ? "on" : ""}
                  onClick={() => setSeverityMetric("events")}
                >
                  {t("an.metricEvents")}
                </button>
                <button
                  className={severityMetric === "fingerprints" ? "on" : ""}
                  onClick={() => setSeverityMetric("fingerprints")}
                >
                  {t("an.metricFingerprints")}
                </button>
              </div>
              <BreakdownBars rows={data.severity ?? []} field={severityField} labelKey="severity" />
            </Panel>
            <Panel title={t("an.lifecycleChart")}>
              {Number(
                data.lifecycle?.statuses?.reduce(
                  (n: number, r: Row) => n + Number(r.incidents ?? 0),
                  0,
                ),
              ) > 0 ? (
                <div className="an-lifecycle-stack">
                  {data.lifecycle?.statuses?.map((r: Row, i: number) => (
                    <div
                      key={r.status}
                      style={{
                        flex: Number(r.incidents),
                        background: COLORS[[2, 1, 0][i]],
                      }}
                      title={`${r.status}: ${fmt(r.incidents)}`}
                    >
                      <span>
                        {t(
                          `an.${r.status === `open` ? "openIncidents" : r.status === `acknowledged` ? "acknowledgedIncidents" : "resolvedIncidents"}`,
                        )}
                      </span>
                      <b>{fmt(r.incidents)}</b>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="an-chart-empty">{t("an.noIncidents")}</div>
              )}
              <div className="an-chart-legend">
                {t("an.recurringIncidents")}: {fmt(data.lifecycle?.recurring_incidents)} ·{" "}
                {t("an.reopenedIncidents")}: {fmt(data.lifecycle?.reopened_incidents)}
              </div>
            </Panel>
          </div>
        </>
      )}
      <Panel title={t("an.serviceErrorTrends")}>
        <div
          className="an-health-toggle an-service-select"
          role="group"
          aria-label={t("an.serviceErrorTrends")}
        >
          {serviceTrendKeys.map((key: string, i: number) => {
            const row = (data.services ?? []).find((r: Row) => idOf(r) === key);
            const hidden = hiddenServices.includes(key);
            return (
              <button
                key={key}
                className={hidden ? "muted" : "on"}
                onClick={() =>
                  setHiddenServices((s) => (hidden ? s.filter((x) => x !== key) : [...s, key]))
                }
              >
                <i style={{ background: COLORS[i % COLORS.length] }} />
                {row?.service} · {row?.namespace}
              </button>
            );
          })}
        </div>
        <ObservedTrend
          rows={serviceTrendRows}
          from={data.range.from}
          to={data.range.to}
          bucket={data.filters.bucket}
          timezone={data.filters.timezone}
          seriesMode
          hidden={hiddenServices}
          serviceColors={serviceColors}
        />
      </Panel>
      {!servicesOnly && (
        <>
          <Panel title={t("an.remediationOutcomes")} hint={data.semantics?.remediation}>
            <div className="an-remediation-grid">
              {[
                ["linkedIncidents", data.remediation?.linked_incidents],
                ["workItemsWithRuns", data.remediation?.work_items_with_runs],
                ["completedRuns", data.remediation?.completed_runs],
                ["verifiedFixes", data.remediation?.fixes_verified],
                ["prsCreated", data.remediation?.prs_created],
                ["prsMerged", data.remediation?.merged_prs],
              ].map(([key, value]) => (
                <div key={String(key)}>
                  <span>{t(`an.${key}`)}</span>
                  <b>{value == null ? "—" : fmt(value)}</b>
                  {key === "prsCreated" && value != null && (
                    <small>{t("an.resolutionInferredNo")}</small>
                  )}
                </div>
              ))}
            </div>
          </Panel>
          <Panel title={t("an.topFingerprints")}>
            <DataTable
              rows={(data.topFingerprints ?? []).map((r: Row) => ({
                ...r,
                fingerprint_link: (
                  <button className="link-button mono" onClick={() => openIncident(r.fingerprint)}>
                    {r.fingerprint}
                  </button>
                ),
              }))}
              columns={[
                {
                  key: "fingerprint_link",
                  label: "fingerprint",
                  render: (r) => (
                    <span className="an-fingerprint-cell">
                      {r.fingerprint_link}
                      <small>{r.signature}</small>
                    </span>
                  ),
                },
                { key: "service", label: "service" },
                { key: "severity", label: "severity" },
                { key: "events", label: "events", style: "number" },
                { key: "recurring", label: "recurring" },
              ]}
            />
          </Panel>
          <Panel title={t("an.incidentsForService")}>
            <DataTable
              rows={data.details ?? []}
              total={s.fingerprints ?? 0}
              page={page}
              onPage={onPage}
              columns={[
                {
                  key: "fingerprint",
                  label: "fingerprint",
                  render: (r) => (
                    <div className="an-signature">
                      <button
                        className="link-button mono"
                        onClick={() => openIncident(r.fingerprint)}
                      >
                        {r.fingerprint}
                      </button>
                      <div>{r.signature}</div>
                    </div>
                  ),
                },
                { key: "namespace", label: "namespace" },
                { key: "service", label: "service" },
                { key: "severity", label: "severity" },
                { key: "events", label: "events", style: "number" },
                {
                  key: "lifecycle_status",
                  label: "status",
                  render: (r) => <span className="pill">{t(`an.${r.lifecycle_status}`)}</span>,
                },
                {
                  key: "first_at",
                  label: "firstSeen",
                  render: (r) => dateCell(r.first_at ?? r.first_seen_at),
                },
                {
                  key: "last_at",
                  label: "lastSeen",
                  render: (r) => dateCell(r.last_at),
                },
                {
                  key: "links",
                  label: "evidence",
                  render: (r) => (
                    <IncidentLinks row={r} onOpen={() => openIncident(r.fingerprint)} />
                  ),
                },
              ]}
            />
          </Panel>
        </>
      )}
    </>
  );
}

function IncidentLinks({ row, onOpen }: { row: Row; onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <div className="an-incident-links">
      <button className="ghost xs" onClick={onOpen}>
        {t("an.openIncident")}
      </button>
      {row.work_item_id && (
        <a href={`#/work-items/${row.work_item_id}`}>
          {row.work_item_code ?? `#${row.work_item_id}`}
        </a>
      )}
      {row.runs?.map((r: Row) => (
        <a key={r.id} href={`#/runs/${r.id}`}>
          Run #{r.id} · {r.status}
          {r.verified === true ? " ✓" : ""}
        </a>
      ))}
    </div>
  );
}
