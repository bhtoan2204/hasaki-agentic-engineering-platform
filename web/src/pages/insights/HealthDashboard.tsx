import { useState } from "react";
import { useI18n } from "../../i18n/index.tsx";
import { api } from "../../api.ts";
import { ErrorBox } from "../../ui.tsx";
import { BreakdownBars, DataTable, Metric, Notice, Panel, Trend, dateCell, type Row } from "./shared.tsx";
function IncidentEvidence({ row, canManage, onUpdated }: { row: Row; canManage: boolean; onUpdated: () => void }) {
  const { t, status } = useI18n();
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = async (action: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/prod-errors/${row.fingerprint}/lifecycle`, { action, evidence });
      onUpdated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="an-evidence">
      <summary>{t("an.evidence")}</summary>
      {row.work_item_id && (
        <a href={`#/work-items/${row.work_item_id}`}>{row.work_item_code ?? `#${row.work_item_id}`}</a>
      )}
      {row.runs?.map((r: Row) => (
        <div key={r.id} className="an-run-evidence">
          <a href={`#/runs/${r.id}`}>Run #{r.id}</a> · {status(r.status)} · {t("an.verification")}:{" "}
          {r.verified == null ? "—" : t(r.verified ? "an.passed" : "an.notPassed")}
          {r.pull_requests?.map((p: Row) => (
            <a key={p.url} href={/^https?:\/\//.test(p.url) ? p.url : undefined} target="_blank" rel="noreferrer">
              {p.repo}: {p.title}
            </a>
          ))}
          {r.changes?.map((change: Row) => (
            <div key={change.repo} className="mono small">
              {change.repo} · {change.commits?.map((c: Row) => c.hash?.slice(0, 8)).join(", ") || "—"}
            </div>
          ))}
        </div>
      ))}
      {row.lifecycle_events?.map((event: Row, i: number) => (
        <div key={i} className="an-run-evidence">
          <b>
            {t(
              `an.${event.action === "resolve" ? "resolved" : event.action === "acknowledge" ? "acknowledged" : "open"}`,
            )}
          </b>{" "}
          · {dateCell(event.created_at)}
          <p>{event.evidence}</p>
        </div>
      ))}
      {canManage && (
        <fieldset disabled={busy}>
          <legend>{t("an.lifecycle")}</legend>
          <p className="muted small">{t("an.operatorHint")}</p>
          {row.lifecycle_status !== "resolved" && (
            <>
              <input
                aria-label={t("an.evidence")}
                placeholder={t("an.evidencePlaceholder")}
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
              />
              <div className="row">
                <button
                  className="ghost sm"
                  disabled={row.lifecycle_status === "acknowledged"}
                  onClick={() => update("acknowledge")}
                >
                  {t("an.ackAction")}
                </button>
                <button className="sm" disabled={evidence.trim().length < 8} onClick={() => update("resolve")}>
                  {t("an.resolveAction")}
                </button>
              </div>
            </>
          )}
          {row.lifecycle_status === "resolved" && (
            <button className="ghost sm" onClick={() => update("reopen")}>
              {t("an.reopenAction")}
            </button>
          )}
        </fieldset>
      )}
      {error && <ErrorBox error={error} />}
    </details>
  );
}
export function HealthDashboard({
  data,
  page,
  onPage,
  onUpdated,
}: {
  data: Row;
  page: number;
  onPage: (n: number) => void;
  onUpdated: () => void;
}) {
  const { t } = useI18n();
  const s = data.summary ?? {};
  return (
    <>
      <Notice>{t("an.healthHint")}</Notice>
      <div className="ins-stats">
        <Metric label="observed" value={s.total_errors} tone="err" />
        <Metric label="fingerprints" value={s.fingerprints} />
        <Metric label="new" value={s.new_errors} />
        <Metric label="resolved" value={s.resolved} tone="ok" />
        <Metric label="unresolved" value={s.unresolved} tone="wait" />
        <Metric label="recurring" value={s.recurring} tone="err" />
        <Metric
          label="acknowledge"
          value={s.acknowledge_ms}
          style="ms"
          hint={t("an.missingLifecycle", { n: s.missing_acknowledged ?? 0 })}
        />
        <Metric
          label="resolve"
          value={s.resolve_ms}
          style="ms"
          hint={t("an.missingLifecycle", { n: s.missing_resolved ?? 0 })}
        />
      </div>
      <Notice>{t("an.historyHint", { n: s.snapshots_missing_hourly ?? 0, p: s.partial_hours ?? 0 })}</Notice>
      <div className="ins-grid">
        <Panel title={t("an.errorTrend")}>
          <Trend timezone={data.filters?.timezone} rows={data.trend ?? []} field="events" label={t("an.errorTrend")} />
        </Panel>
        <Panel title={t("an.severity")}>
          <BreakdownBars rows={data.severity ?? []} field="events" labelKey="severity" />
        </Panel>
      </div>
      <Panel title={t("an.frequency")}>
        <DataTable
          rows={data.services ?? []}
          columns={[
            { key: "service", label: "service" },
            { key: "source_provider", label: "provider" },
            { key: "fingerprints", label: "fingerprints", style: "number" },
            { key: "events", label: "events", style: "number" },
          ]}
        />
      </Panel>
      <Panel title={t("an.incidents")}>
        <DataTable
          rows={data.details ?? []}
          total={s.fingerprints}
          page={page}
          onPage={onPage}
          columns={[
            {
              key: "fingerprint",
              label: "fingerprint",
              render: (r) => (
                <div className="an-signature">
                  <a className="mono" href={`#/prod-errors`}>
                    {r.fingerprint}
                  </a>
                  <div>{r.signature}</div>
                </div>
              ),
            },
            { key: "service", label: "service" },
            { key: "severity", label: "severity" },
            { key: "events", label: "events", style: "number" },
            {
              key: "lifecycle_status",
              label: "status",
              render: (r) => <span className="pill">{t(`an.${r.lifecycle_status}`)}</span>,
            },
            { key: "first_at", label: "firstSeen", render: (r) => dateCell(r.first_at ?? r.first_seen_at) },
            { key: "last_at", label: "lastSeen", render: (r) => dateCell(r.last_at) },
            {
              key: "evidence",
              label: "evidence",
              render: (r) => <IncidentEvidence row={r} canManage={data.can_manage_incidents} onUpdated={onUpdated} />,
            },
          ]}
        />
      </Panel>
    </>
  );
}
