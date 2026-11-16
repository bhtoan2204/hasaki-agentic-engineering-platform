import { useState } from "react";
import { api, useApi } from "../../api.ts";
import { act, ErrorBox, Field } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { Panel, fmt } from "../analytics/shared.tsx";
export function EvaluationRecommendations() {
  const { locale } = useI18n();
  const en = locale === "en";
  const rows = useApi<any[]>("/api/agent-recommendations"),
    policies = useApi<any[]>("/api/agent-optimization");
  const [category, setCategory] = useState(""),
    [cohort, setCohort] = useState(""),
    [active, setActive] = useState<any>(null),
    [consent, setConsent] = useState(false),
    [cost, setCost] = useState(false);
  const generate = () =>
    act(async () => {
      const range = new URLSearchParams(location.hash.split("?")[1] ?? "");
      const r = await api("/api/agent-recommendations", {
        ...Object.fromEntries(
          ["from", "to", "timezone"].filter((k) => range.has(k)).map((k) => [k, range.get(k)]),
        ),
        category,
        ...(cohort ? { cohort } : {}),
      });
      setActive(r);
      await rows.reload();
    });
  const show = active ?? rows.data?.[0],
    d = show?.decision;
  return (
    <Panel
      title={en ? "Evidence-backed recommendations" : "Khuyến nghị dựa trên bằng chứng"}
      hint={
        en
          ? "Controlled, completed live benchmarks only; fixture controls and production observations never establish model superiority."
          : "Chỉ dùng benchmark thật hoàn tất có kiểm soát; fixture và quan sát sản xuất không chứng minh mô hình vượt trội."
      }
    >
      <div className="grid2">
        <Field label={en ? "Task category" : "Loại nhiệm vụ"}>
          <input
            aria-label={en ? "Recommendation task category" : "Loại nhiệm vụ khuyến nghị"}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder={en ? "Exact labeled category" : "Nhãn loại nhiệm vụ chính xác"}
          />
        </Field>
        <Field label={en ? "Control cohort (optional)" : "Nhóm kiểm soát (tùy chọn)"}>
          <input value={cohort} onChange={(e) => setCohort(e.target.value)} />
        </Field>
      </div>
      <button className="sm" disabled={!category.trim()} onClick={generate}>
        {en ? "Generate recommendation" : "Tạo khuyến nghị"}
      </button>
      {rows.error && <ErrorBox error={rows.error} onRetry={rows.reload} />}
      {!show && (
        <p className="muted">
          {en
            ? "Insufficient evidence. Create a snapshot to inspect the supporting samples."
            : "Chưa đủ bằng chứng. Tạo bản chụp để xem mẫu hỗ trợ."}
        </p>
      )}
      {show && (
        <>
          <h4>
            {d.status === "RECOMMENDED"
              ? `${en ? "Recommended" : "Khuyến nghị"}: ${d.plan.map((p: any) => p.provider).join(" → ")}`
              : en
                ? "Insufficient evidence / unavailable"
                : "Chưa đủ bằng chứng / chưa khả dụng"}
          </h4>
          <p className="small">
            {en ? "Confidence" : "Độ tin cậy"}: {d.confidence} · {en ? "Samples" : "Số mẫu"}:{" "}
            {d.samples ?? 0} · {en ? "Distinct tasks" : "Nhiệm vụ khác nhau"}:{" "}
            {d.distinct_tasks ?? 0} · {en ? "Verified success" : "Thành công đã xác minh"}:{" "}
            {fmt(d.success_rate, "pct")} · {en ? "Median" : "Trung vị"}: {fmt(d.median_ms, "ms")} ·{" "}
            {en ? "Cost availability" : "Độ đầy đủ chi phí"}: {d.cost_availability ?? "Unknown"}
          </p>
          <p className="muted small">{d.reason}</p>
          <details>
            <summary>
              {en
                ? "Supporting evidence and recommendation version"
                : "Bằng chứng và phiên bản khuyến nghị"}
            </summary>
            <p className="mono small">
              {show.version} · {show.evidence_hash}
            </p>
            {d.evidence?.map((e: any, i: number) => (
              <p key={i} className="small">
                {e.plan?.map((p: any) => p.provider).join(" → ")} · {e.samples} / {e.tasks} ·{" "}
                {e.evaluation_ids?.map((id: number) => (
                  <a
                    style={{ marginRight: 8 }}
                    key={id}
                    href={`/api/evaluation-runs/${id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    evaluation #{id}
                  </a>
                ))}
              </p>
            ))}
            <a href={`/api/agent-recommendations/${show.id}`} target="_blank" rel="noreferrer">
              {en ? "Immutable evidence snapshot" : "Bản chụp bằng chứng bất biến"}
            </a>
          </details>
          {d.status === "RECOMMENDED" && d.plan?.length === 1 && (
            <div style={{ marginTop: 12 }}>
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                {en
                  ? "Opt in for future unconfigured coding steps only. Running workflows are unchanged."
                  : "Áp dụng cho bước lập trình chưa cấu hình trong tương lai. Không đổi workflow đang chạy."}
              </label>
              <label>
                <input type="checkbox" checked={cost} onChange={(e) => setCost(e.target.checked)} />
                {en
                  ? "Allow a default when provider cost is unknown"
                  : "Cho phép mặc định khi chưa rõ chi phí"}
              </label>
              <button
                className="sm"
                onClick={() =>
                  act(async () => {
                    await api("/api/agent-optimization", {
                      recommendation_id: show.id,
                      category: show.category,
                      step_type: "coding_agent",
                      enabled: consent,
                      allow_unknown_cost: cost,
                    });
                    await policies.reload();
                  })
                }
              >
                {en ? "Save future-default policy" : "Lưu chính sách mặc định tương lai"}
              </button>
            </div>
          )}
        </>
      )}
      {policies.data?.map((p) => (
        <p key={p.id} className="small">
          {p.category} · {p.enabled ? (en ? "Enabled" : "Đã bật") : en ? "Disabled" : "Đã tắt"}{" "}
          <button
            className="quiet xs"
            onClick={() =>
              act(async () => {
                await api("/api/agent-optimization", {
                  recommendation_id: p.recommendation_id,
                  category: p.category,
                  step_type: p.step_type,
                  enabled: false,
                });
                await policies.reload();
              })
            }
          >
            {en ? "Disable" : "Tắt"}
          </button>
        </p>
      ))}
    </Panel>
  );
}
