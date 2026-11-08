import { useI18n } from "../../i18n/index.tsx";
import { Panel, fmt, BreakdownBars } from "../analytics/shared.tsx";
import { EvaluationTable } from "./EvaluationTable.tsx";
export function EvaluationEvidence({
  data,
  onPage,
}: {
  data: any;
  onPage: (page: number) => void;
}) {
  const { locale } = useI18n();
  const en = locale === "en";
  return (
    <>
      {" "}
      <Panel title={en ? "Failure distribution" : "Phân bố lỗi"}>
        <BreakdownBars
          rows={data.failures}
          field="samples"
          labelKey="category"
        />
      </Panel>
      <Panel
        title={
          en
            ? "Production observations — separate, non-causal"
            : "Quan sát sản xuất — tách biệt, không nhân quả"
        }
      >
        <EvaluationTable
          rows={data.production}
          columns={[
            {
              label: "Provider",
              value: (r) => `${r.provider} / ${r.model ?? "—"}`,
            },
            { label: en ? "Category" : "Loại", value: (r) => r.category },
            {
              label: en ? "Attempts" : "Lần thử",
              value: (r) => fmt(r.attempts),
            },
            {
              label: en ? "Verified coverage" : "Độ phủ xác minh",
              value: (r) => `${r.verified_coverage}/${r.attempts}`,
            },
            {
              label: en
                ? "Success among verified attempts"
                : "Thành công trong lần thử đã xác minh",
              value: (r) => fmt(r.verified_success_rate, "pct"),
            },
            {
              label: en ? "Cost / coverage" : "Chi phí / độ đầy đủ",
              value: (r) =>
                `${fmt(r.reported_cost_usd, "usd")} · ${r.cost_known}/${r.attempts}`,
            },
          ]}
        />
      </Panel>
      <Panel
        title={
          en
            ? "Evidence and verification artifacts"
            : "Bằng chứng và tài liệu xác minh"
        }
      >
        <EvaluationTable
          rows={data.details}
          columns={[
            {
              label: en ? "Task / repetition" : "Nhiệm vụ / lần lặp",
              value: (r) => `${r.task_id} · ${r.repetition}`,
            },
            {
              label: en ? "Provider route" : "Chuỗi agent",
              value: (r) => r.provider_path,
            },
            {
              label: en ? "Evidence / result" : "Bằng chứng / kết quả",
              value: (r) =>
                `${r.evidence_kind} · ${r.result_status ?? "pending"}`,
            },
            {
              label: en ? "Inspect" : "Xem",
              value: (r) => (
                <>
                  <a href={`#/runs/${r.workflow_run_id}`}>
                    #{r.evaluation_id} · workflow #{r.workflow_run_id}
                  </a>
                  {r.artifact_id && (
                    <>
                      {" "}
                      ·{" "}
                      <a
                        href={`/api/artifacts/${r.artifact_id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {en ? "Verification artifact" : "Tài liệu xác minh"}
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
            className="ghost xs"
            disabled={data.pagination.page <= 1}
            onClick={() => onPage(data.pagination.page - 1)}
          >
            {en ? "Previous" : "Trước"}
          </button>
          <span className="small">
            {data.pagination.page} · {data.pagination.total}
          </span>
          <button
            className="ghost xs"
            disabled={
              data.pagination.page * data.pagination.page_size >=
              data.pagination.total
            }
            onClick={() => onPage(data.pagination.page + 1)}
          >
            {en ? "Next" : "Sau"}
          </button>
        </div>
      </Panel>
    </>
  );
}
