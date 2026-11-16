import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { Activity, Info } from "lucide-react";
import { EmptyState, Skeleton, SkeletonRows, StatCard, time } from "../../ui.tsx";
import { uiLocale, useI18n } from "../../i18n/index.tsx";

export type Row = Record<string, any>;
export const number = (v: unknown) =>
  v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
export const fmt = (v: unknown, style: "number" | "usd" | "ms" | "pct" = "number") => {
  const n = number(v);
  if (n == null) return "—";
  const locale = uiLocale() === "vi" ? "vi-VN" : "en-GB";
  if (style === "ms")
    return n >= 60000
      ? `${(n / 60000).toLocaleString(locale, { maximumFractionDigits: 1 })} min`
      : `${(n / 1000).toLocaleString(locale, { maximumFractionDigits: 2 })} s`;
  if (style === "pct") return `${(n * 100).toLocaleString(locale, { maximumFractionDigits: 1 })}%`;
  return n.toLocaleString(locale, {
    maximumFractionDigits: style === "usd" ? 4 : 1,
    ...(style === "usd" ? { style: "currency", currency: "USD" } : {}),
  });
};
export const ratio = (a: unknown, b: unknown) =>
  number(a) != null && Number(b) > 0 ? Number(a) / Number(b) : null;
export function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="card ins-panel an-panel">
      <div className="ins-panel-head">
        <h3>{title}</h3>
        {hint && (
          <span className="an-info" tabIndex={0} title={hint} aria-label={hint}>
            <Info size={16} />
          </span>
        )}
      </div>
      {children}
    </section>
  );
}
export function Metric({
  label,
  value,
  style,
  hint,
  tone = "brand",
}: {
  label: string;
  value: unknown;
  style?: "number" | "usd" | "ms" | "pct";
  hint?: string;
  tone?: "brand" | "err" | "wait" | "ok" | "run";
}) {
  const { t } = useI18n();
  return (
    <StatCard
      icon={Activity}
      label={t(`an.${label}`)}
      value={fmt(value, style)}
      hint={hint}
      tone={tone}
    />
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="an-notice">
      <Info size={16} />
      <span>{children}</span>
    </div>
  );
}
export function AnalyticsSkeleton() {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t("an.loading")}>
      <div className="ins-stats">
        {[1, 2, 3, 4, 5, 6].map((k) => (
          <Skeleton key={k} h={110} />
        ))}
      </div>
      <Skeleton h={220} />
      <SkeletonRows rows={4} />
    </div>
  );
}
export interface Column {
  key: string;
  label: string;
  render?: (row: Row) => ReactNode;
  style?: "number" | "usd" | "ms" | "pct";
  align?: "left" | "right" | "center";
  width?: string;
  minWidth?: string;
  maxWidth?: string;
  responsivePriority?: "primary" | "secondary";
}
export function DataTable({
  rows,
  columns,
  page,
  onPage,
  total,
}: {
  rows: Row[];
  columns: Column[];
  page?: number;
  onPage?: (n: number) => void;
  total?: number;
}) {
  const { t } = useI18n();
  const count = total ?? Number(rows[0]?.total_rows ?? rows.length);
  const [expanded, setExpanded] = useState(false);
  const tableId = useId();
  const prioritised = columns.some((c) => c.responsivePriority === "secondary");
  const cellStyle = (c: Column): CSSProperties => ({
    textAlign: c.align ?? (c.style ? "right" : "left"),
    width: c.width,
    minWidth: c.minWidth,
    maxWidth: c.maxWidth,
  });
  return (
    <>
      {rows.length ? (
        <div className="data-table" data-expanded={expanded}>
          {prioritised && (
            <button
              type="button"
              className="ghost sm table-column-toggle"
              aria-expanded={expanded}
              aria-controls={tableId}
              onClick={() => setExpanded((v) => !v)}
            >
              {t(expanded ? "an.summaryColumns" : "an.allColumns")}
            </button>
          )}
          <div className="table-wrap" tabIndex={0} role="region" aria-label={t("an.tableScroll")}>
            <table id={tableId} className={`ins-table${prioritised ? " prioritised-table" : ""}`}>
              <colgroup>
                {columns.map((c) => (
                  <col
                    key={c.key}
                    style={{ width: c.width }}
                    data-priority={c.responsivePriority}
                  />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th
                      scope="col"
                      key={c.key}
                      style={cellStyle(c)}
                      data-priority={c.responsivePriority}
                    >
                      {t(`an.${c.label}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        style={cellStyle(c)}
                        className={c.style || c.align === "right" ? "numeric-cell" : undefined}
                        data-priority={c.responsivePriority}
                      >
                        {c.render ? (
                          c.render(r)
                        ) : c.style ? (
                          fmt(r[c.key], c.style)
                        ) : r[c.key] == null ? (
                          <span className="muted">—</span>
                        ) : (
                          String(r[c.key])
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <EmptyState title={t("an.empty")}>{t("an.emptyHint")}</EmptyState>
      )}
      {onPage && (
        <div className="an-pagination">
          <span className="muted">
            {t("an.rows", { n: count })} · {t("an.page", { n: page ?? 1 })}
          </span>
          <button
            className="ghost sm"
            disabled={(page ?? 1) <= 1}
            onClick={() => onPage((page ?? 1) - 1)}
          >
            {t("an.previous")}
          </button>
          <button
            className="ghost sm"
            disabled={(page ?? 1) * 25 >= count}
            onClick={() => onPage((page ?? 1) + 1)}
          >
            {t("an.next")}
          </button>
        </div>
      )}
    </>
  );
}
export const runLink = (r: Row) => (
  <a href={`#/runs/${r.run_id}${r.step_key ? `/${r.step_key}` : ""}`}>
    #{r.run_id}
    {r.step_key ? ` · ${r.step_key}` : ""}
  </a>
);
export const dateCell = (value: unknown) => (value ? time(String(value)) : "—");

/** Small multiples retain gaps for missing values; null is never plotted at zero. */
export function Trend({
  rows,
  field,
  label,
  currency = false,
  timezone = "UTC",
}: {
  rows: Row[];
  field: string;
  label: string;
  currency?: boolean;
  timezone?: string;
}) {
  const { t } = useI18n();
  const values = rows.map((r) => number(r[field]));
  const max = Math.max(...values.filter((v): v is number => v != null), 0);
  if (!rows.length || values.every((v) => v == null))
    return <EmptyState title={t("an.empty")}>{t("an.emptyHint")}</EmptyState>;
  const bucketLabel = (v: string) =>
    new Date(v).toLocaleString(uiLocale() === "vi" ? "vi-VN" : "en-GB", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "shortOffset",
    });
  const visible = rows;
  return (
    <>
      <div className="an-trend" role="img" aria-label={label}>
        {visible.map((r, i) => {
          const n = number(r[field]);
          return (
            <div
              key={i}
              className="an-trend-column"
              title={`${bucketLabel(r.bucket)}: ${fmt(n, currency ? "usd" : "number")}`}
            >
              <div
                className={n == null ? "an-trend-missing" : "an-trend-bar"}
                style={{
                  height: n == null ? "8px" : `${max > 0 ? Math.max(1, (n / max) * 100) : 1}%`,
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="an-trend-axis">
        <span>{bucketLabel(rows[0].bucket)}</span>
        <span>{bucketLabel(rows.at(-1)!.bucket)}</span>
      </div>
      <details className="an-chart-data">
        <summary>{label}</summary>
        <DataTable
          rows={rows}
          columns={[
            { key: "bucket", label: "from" },
            {
              key: field,
              label: currency ? "cost" : "events",
              style: currency ? "usd" : "number",
            },
          ]}
        />
      </details>
    </>
  );
}
export function BreakdownBars({
  rows,
  field,
  labelKey = "dimension",
}: {
  rows: Row[];
  field: string;
  labelKey?: string;
}) {
  const { t } = useI18n();
  if (!rows.length) return <EmptyState title={t("an.empty")} />;
  const max = Math.max(...rows.map((r) => Number(r[field] ?? 0)), 1);
  return (
    <ul className="ins-bars">
      {rows.map((r, i) => {
        const n = Number(r[field] ?? 0);
        const width = n > 0 ? Math.max(2, (100 * n) / max) : 0;
        return (
          <li className="ins-bar" key={i}>
            <span className="mono">{r[labelKey] ?? t("an.unknown")}</span>
            <div className="ins-bar-track" aria-hidden>
              <span className="ins-bar-fill" style={{ width: `${width}%` }} />
            </div>
            <span className="ins-bar-value">{fmt(r[field])}</span>
          </li>
        );
      })}
    </ul>
  );
}
