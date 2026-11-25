import { useI18n } from "../../i18n/index.tsx";
import { Panel, fmt, BreakdownBars } from "../analytics/shared.tsx";
import { EvaluationTable, type EvaluationAnalytics } from "./EvaluationTable.tsx";
export function EvaluationEvidence({
  data,
  onPage,
}: {
  data: EvaluationAnalytics;
  onPage: (page: number) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {" "}
      <Panel title={t("an.eval.failureDist")}>
        <BreakdownBars rows={data.failures} field="samples" labelKey="category" />
      </Panel>
      <Panel title={t("an.eval.prodObservations")}>
        <EvaluationTable
          rows={data.production}
          columns={[
            {
              label: "Provider",
              value: (r) => `${r.provider} / ${r.model ?? "—"}`,
            },
            { label: t("an.eval.category"), value: (r) => r.category },
            {
              label: t("an.eval.attempts"),
              value: (r) => fmt(r.attempts),
            },
            {
              label: t("an.eval.verifiedCoverage"),
              value: (r) => `${r.verified_coverage}/${r.attempts}`,
            },
            {
              label: t("an.eval.successAmongVerified"),
              value: (r) => fmt(r.verified_success_rate, "pct"),
            },
            {
              label: t("an.eval.costCoverage"),
              value: (r) => `${fmt(r.reported_cost_usd, "usd")} · ${r.cost_known}/${r.attempts}`,
            },
          ]}
        />
      </Panel>
      <Panel title={t("an.eval.evidenceArtifactsTitle")}>
        <EvaluationTable
          rows={data.details}
          columns={[
            {
              label: t("an.eval.taskRepetition"),
              value: (r) => `${r.task_id} · ${r.repetition}`,
            },
            {
              label: t("an.eval.providerRoute"),
              value: (r) => r.provider_path,
            },
            {
              label: t("an.eval.evidenceResult"),
              value: (r) => `${r.evidence_kind} · ${r.result_status ?? "pending"}`,
            },
            {
              label: t("an.eval.inspect"),
              value: (r) => (
                <>
                  <a href={`#/runs/${r.workflow_run_id}`}>
                    #{r.evaluation_id} · workflow #{r.workflow_run_id}
                  </a>
                  {r.artifact_id && (
                    <>
                      {" "}
                      ·{" "}
                      <a href={`/api/artifacts/${r.artifact_id}`} target="_blank" rel="noreferrer">
                        {t("an.eval.verificationArtifact")}
                      </a>
                    </>
                  )}
                </>
              ),
            },
          ]}
        />
        <div className="row">
          <button
            type="button"
            className="ghost xs"
            disabled={data.pagination.page <= 1}
            onClick={() => onPage(data.pagination.page - 1)}
          >
            {t("an.previous")}
          </button>
          <span className="small">
            {data.pagination.page} · {data.pagination.total}
          </span>
          <button
            type="button"
            className="ghost xs"
            disabled={data.pagination.page * data.pagination.page_size >= data.pagination.total}
            onClick={() => onPage(data.pagination.page + 1)}
          >
            {t("an.next")}
          </button>
        </div>
      </Panel>
    </>
  );
}
