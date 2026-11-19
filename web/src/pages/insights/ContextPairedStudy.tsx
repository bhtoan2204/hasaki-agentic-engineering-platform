import { useState } from "react";
import { api, useApi } from "../../api.ts";
import { act, ErrorBox, Field } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { Panel, fmt } from "../analytics/shared.tsx";
export function ContextPairedStudy() {
  const { t } = useI18n();
  const rows = useApi<any>("/api/evaluation-runs");
  const [a, setA] = useState(""),
    [b, setB] = useState(""),
    [report, setReport] = useState<any>(null);
  return (
    <Panel title={t("an.eval.pairedValueTitle")}>
      {rows.error && <ErrorBox error={rows.error} onRetry={rows.reload} />}
      <p className="muted small">
        {t("an.eval.pairedValueHint")}
      </p>
      <div className="grid2">
        {[
          [a, setA, t("an.eval.baselineEval")],
          [b, setB, t("an.eval.candidateEval")],
        ].map(([value, set, label], i) => (
          <Field key={i} label={label as string}>
            <select value={value as string} onChange={(e) => (set as typeof setA)(e.target.value)}>
              <option value="">—</option>
              {rows.data?.runs?.map((r: any) => (
                <option key={r.id} value={r.id}>
                  #{r.id} · {r.configuration.context_variant ?? "legacy"} · {r.status}
                </option>
              ))}
            </select>
          </Field>
        ))}
      </div>
      <button
        className="sm"
        disabled={!a || !b || a === b}
        onClick={() =>
          act(async () => {
            const pair: any = await api("/api/evaluation-comparisons", {
              baseline_id: Number(a),
              candidate_id: Number(b),
            });
            setReport(await api(`/api/evaluation-comparisons/${pair.id}`));
          })
        }
      >
        {t("an.eval.assessPaired")}
      </button>
      {report && (
        <>
          <h4>{report.context_report?.status ?? report.report.verdict}</h4>
          <p className="small">
            {t("an.eval.pairedTasks")}:{" "}
            {report.context_report?.distinct_paired_tasks ?? "—"} ·{" "}
            {t("an.eval.improvementsRegressions")}:{" "}
            {report.context_report?.improved ?? "—"} / {report.context_report?.regressed ?? "—"} · Δ{" "}
            {fmt(report.context_report?.paired_duration_delta_ms, "ms")}
          </p>
          <details>
            <summary>{t("an.eval.methodEvidence")}</summary>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                maxHeight: 300,
                overflow: "auto",
              }}
            >
              {JSON.stringify(report.context_report ?? report.report, null, 2)}
            </pre>
          </details>
        </>
      )}
    </Panel>
  );
}
