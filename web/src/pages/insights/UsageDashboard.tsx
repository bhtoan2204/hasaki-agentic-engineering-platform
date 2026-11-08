import { useI18n } from "../../i18n/index.tsx";
import { DataTable, Metric, Notice, Panel, Trend, fmt, runLink, type Row } from "./shared.tsx";
const fields: Array<[string, string]> = [
  ["input_tokens", "input"],
  ["output_tokens", "output"],
  ["cache_read_tokens", "cacheRead"],
  ["cache_creation_tokens", "cacheWrite"],
  ["reasoning_tokens", "reasoning"],
  ["reported_cost_usd", "cost"],
];
export function UsageDashboard({
  data,
  page,
  onPage,
  group,
  onGroup,
}: {
  data: Row;
  page: number;
  onPage: (n: number) => void;
  group: string;
  onGroup: (v: string) => void;
}) {
  const { t } = useI18n();
  const s = data.summary ?? {};
  return (
    <>
      <Notice>{t("an.billingHint")}</Notice>
      <div className="ins-stats">
        {fields.map(([k, label]) => (
          <Metric
            key={k}
            label={label}
            value={s[k]}
            style={k === "reported_cost_usd" ? "usd" : "number"}
            hint={t("an.missingCount") + ": " + fmt(s[`missing_${k}`])}
          />
        ))}
        <Metric label="costSuccess" value={s.cost_per_successful_run} style="usd" hint={t("an.subtotalHint")} />
        <Metric label="costVerified" value={s.cost_per_verified_task} style="usd" hint={t("an.subtotalHint")} />
        <Metric label="invocations" value={s.invocations} />
      </div>
      <div className="ins-grid">
        <Panel title={t("an.costTrend")} hint={t("an.subtotalHint")}>
          <Trend
            timezone={data.filters?.timezone}
            rows={data.trend ?? []}
            field="reported_cost_usd"
            label={t("an.costTrend")}
            currency
          />
        </Panel>
        <Panel title={t("an.coverage")}>
          <DataTable
            rows={fields.map(([k, label]) => ({
              label: t(`an.${label}`),
              reported: Number(s.invocations ?? 0) - Number(s[`missing_${k}`] ?? 0),
              missing: s[`missing_${k}`],
            }))}
            columns={[
              { key: "label", label: "metric" },
              { key: "reported", label: "reported", style: "number" },
              { key: "missing", label: "missingCount", style: "number" },
            ]}
          />
        </Panel>
      </div>
      <Panel title={t("an.usageBreakdown")} hint={t("an.subtotalHint")}>
        <label className="an-inline-label">
          {t("an.group")}
          <select aria-label={t("an.group")} value={group} onChange={(e) => onGroup(e.target.value)}>
            {["provider", "model", "user", "workflow", "repository", "project"].map((k) => (
              <option key={k} value={k}>
                {t(`an.${k}`)}
              </option>
            ))}
          </select>
        </label>
        {group === "repository" && <Notice>{t("an.membership")}</Notice>}
        <DataTable
          rows={data.breakdown ?? []}
          total={s.breakdown_total}
          page={page}
          onPage={onPage}
          columns={[
            { key: "dimension", label: group },
            ...fields.map(([key, label]) => ({
              key,
              label,
              style: (key === "reported_cost_usd" ? "usd" : "number") as "usd" | "number",
            })),
            { key: "missing_reported_cost_usd", label: "missingCount", style: "number" },
          ]}
        />
      </Panel>
      <Panel title={t("an.usageDetails")} hint={t("an.anomalyHint")}>
        <DataTable
          rows={data.details ?? []}
          total={s.invocations}
          page={page}
          onPage={onPage}
          columns={[
            { key: "run_id", label: "run", render: runLink },
            { key: "provider", label: "provider" },
            { key: "model", label: "model" },
            { key: "input_tokens", label: "input", style: "number" },
            { key: "output_tokens", label: "output", style: "number" },
            { key: "reported_cost_usd", label: "cost", style: "usd" },
            {
              key: "token_anomaly",
              label: "anomaly",
              render: (r) => (r.token_anomaly ? <span className="pill an-warning">{t("an.anomaly")}</span> : "—"),
            },
          ]}
        />
      </Panel>
    </>
  );
}
