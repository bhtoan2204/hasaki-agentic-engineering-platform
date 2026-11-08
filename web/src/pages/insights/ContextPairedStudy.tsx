import { useState } from "react";
import { api, useApi } from "../../api.ts";
import { act, Field } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { Panel, fmt } from "./shared.tsx";
export function ContextPairedStudy() {
  const { locale } = useI18n();
  const en = locale === "en";
  const rows = useApi<any>("/api/evaluation-runs");
  const [a, setA] = useState(""),
    [b, setB] = useState(""),
    [report, setReport] = useState<any>(null);
  return (
    <Panel title={en ? "Paired context value assessment" : "Đánh giá giá trị ngữ cảnh theo cặp"}>
      <p className="muted small">
        {en
          ? "Hold task, fixture, provider/model route and budgets fixed. Fixture results test the harness only. Live evidence needs repeated, completed trials before measurable benefit can be concluded."
          : "Giữ nguyên nhiệm vụ, fixture, chuỗi agent/mô hình và ngân sách. Fixture chỉ kiểm tra bộ đo. Bằng chứng thật cần lượt lặp hoàn tất trước khi kết luận lợi ích đo được."}
      </p>
      <div className="grid2">
        {[
          [a, setA, en ? "Baseline evaluation" : "Đánh giá cơ sở"],
          [b, setB, en ? "Candidate evaluation" : "Đánh giá ứng viên"],
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
        {en ? "Assess paired context value" : "Đánh giá giá trị theo cặp"}
      </button>
      {report && (
        <>
          <h4>{report.context_report?.status ?? report.report.verdict}</h4>
          <p className="small">
            {en ? "Paired tasks" : "Nhiệm vụ theo cặp"}: {report.context_report?.distinct_paired_tasks ?? "—"} ·{" "}
            {en ? "Quality improvements / regressions" : "Cải thiện / hồi quy chất lượng"}:{" "}
            {report.context_report?.improved ?? "—"} / {report.context_report?.regressed ?? "—"} · Δ{" "}
            {fmt(report.context_report?.paired_duration_delta_ms, "ms")}
          </p>
          <details>
            <summary>{en ? "Method and evidence" : "Phương pháp và bằng chứng"}</summary>
            <pre style={{ whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto" }}>
              {JSON.stringify(report.context_report ?? report.report, null, 2)}
            </pre>
          </details>
        </>
      )}
    </Panel>
  );
}
