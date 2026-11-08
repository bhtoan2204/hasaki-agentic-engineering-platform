import { useI18n } from "../../i18n/index.tsx";
import { Panel, fmt } from "../analytics/shared.tsx";
import { EvaluationTable } from "./EvaluationTable.tsx";
export function EvaluationDimensions({
  data,
  common,
}: {
  data: any;
  common: any[];
}) {
  const { locale } = useI18n();
  const en = locale === "en";
  return (
    <>
      {" "}
      <Panel
        title={
          en ? "Context effectiveness (A/B/C)" : "Hiệu quả ngữ cảnh (A/B/C)"
        }
        hint={
          en
            ? "Descriptive measured cohorts only. Use the paired comparison runner before concluding measurable benefit. Retrieval accuracy is unknown without labeled retrieved evidence."
            : "Chỉ mô tả nhóm được đo. Dùng so sánh cặp trước khi kết luận lợi ích. Độ chính xác truy xuất chưa rõ nếu thiếu nhãn bằng chứng."
        }
      >
        <EvaluationTable
          rows={data.context}
          columns={[
            ...common.slice(0, 6),
            {
              label: en ? "Requirement coverage" : "Độ phủ yêu cầu",
              value: (r) => fmt(r.requirement_coverage, "pct"),
            },
            {
              label: en ? "Retrieval accuracy" : "Độ chính xác truy xuất",
              value: (r) => fmt(r.retrieval_accuracy, "pct"),
            },
            {
              label: en ? "Tools / retries" : "Công cụ / thử lại",
              value: (r) => `${fmt(r.tool_calls)} / ${fmt(r.retries)}`,
            },
          ]}
        />
      </Panel>
      <Panel
        title={
          en
            ? "Task difficulty and objective quality"
            : "Độ khó nhiệm vụ và chất lượng khách quan"
        }
      >
        <EvaluationTable
          rows={data.difficulty}
          columns={[
            { label: en ? "Difficulty" : "Độ khó", value: (r) => r.difficulty },
            {
              label: en ? "Evidence" : "Bằng chứng",
              value: (r) => r.evidence_kind,
            },
            {
              label: en ? "Acceptance tests" : "Kiểm thử chấp nhận",
              value: (r) => fmt(r.acceptance_pass_rate, "pct"),
            },
            {
              label: en ? "Build checks" : "Kiểm tra build",
              value: (r) => fmt(r.build_success_rate, "pct"),
            },
            {
              label: en ? "Regression failures" : "Lỗi hồi quy",
              value: (r) => fmt(r.regression_failures),
            },
            {
              label: en
                ? "Invalid changes / security"
                : "Thay đổi sai / bảo mật",
              value: (r) =>
                `${fmt(r.invalid_modifications)} / ${fmt(r.security_violations)}`,
            },
            {
              label: en ? "Human interventions" : "Can thiệp con người",
              value: (r) => fmt(r.human_interventions),
            },
          ]}
        />
        <p className="muted small">
          {en
            ? "Unnecessary modifications remain unknown without a labeled necessity oracle. Structural SQL/proto checks are not semantic compilation."
            : "Thay đổi không cần thiết chưa rõ nếu thiếu bộ xác minh có nhãn. Kiểm tra cấu trúc SQL/proto không phải biên dịch ngữ nghĩa."}
        </p>
      </Panel>
      <Panel
        title={
          en
            ? "Handoff and runtime effectiveness"
            : "Hiệu quả bàn giao và thời gian thực thi"
        }
      >
        <EvaluationTable
          rows={data.comparisons}
          columns={[
            common[0],
            common[2],
            {
              label: en ? "Planned switches" : "Chuyển theo kế hoạch",
              value: (r) => fmt(r.planned_switches),
            },
            {
              label: en ? "Recovery handoffs" : "Bàn giao phục hồi",
              value: (r) => fmt(r.recovery_handoffs),
            },
            {
              label: en ? "Provider execution" : "Thực thi nhà cung cấp",
              value: (r) => fmt(r.active_execution_ms, "ms"),
            },
            {
              label: en
                ? "Queue / human / tool"
                : "Hàng đợi / con người / công cụ",
              value: (r) =>
                `${fmt(r.queue_ms, "ms")} / ${fmt(r.human_ms, "ms")} / ${fmt(r.tool_ms, "ms")}`,
            },
            {
              label: en
                ? "Cache read / write / reasoning"
                : "Cache đọc / ghi / suy luận",
              value: (r) =>
                `${fmt(r.cache_read_tokens)} / ${fmt(r.cache_creation_tokens)} / ${fmt(r.reasoning_tokens)}`,
            },
          ]}
        />
      </Panel>
    </>
  );
}
