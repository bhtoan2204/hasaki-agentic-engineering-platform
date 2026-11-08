import { useState } from "react";
import { api, useApi } from "../../api.ts";
import { act, Field, navigate } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { Panel, Notice } from "./shared.tsx";
const plans = ["claude", "codex", "cursor", "claude,codex", "codex,claude", "claude,codex,cursor"];
export function ProviderExperimentForm({ admin, onCreated }: { admin: boolean; onCreated: () => void }) {
  const { locale } = useI18n();
  const en = locale === "en";
  const suites = useApi<any[]>("/api/benchmark-suites");
  const [plan, setPlan] = useState("claude,codex"),
    [models, setModels] = useState<string[]>([]),
    [variant, setVariant] = useState("tools"),
    [reps, setReps] = useState(2),
    [limit, setLimit] = useState(3),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState("fixture"),
    [paid, setPaid] = useState(false);
  const queue = async (ab = false) => {
    const suite = suites.data?.[0];
    if (!suite) return;
    setBusy(true);
    try {
      await act(
        async () => {
          for (const context_variant of ab ? ["minimal", "pack", "tools"] : [variant]) {
            const provider_sequence = plan.split(",").map((provider, i) => ({ provider, model: models[i] || null }));
            const row: any = await api("/api/evaluation-runs", {
              suite_id: suite.id,
              request_key: crypto.randomUUID(),
              paid_approval: paid,
              configuration: {
                mode,
                adapter: "provider_fixture",
                provider: mode === "live" ? provider_sequence[0].provider : "fixture",
                provider_sequence,
                context_variant,
                repetitions: reps,
                case_limit: limit,
              },
            });
            await api(`/api/evaluation-runs/${row.id}/start`, {});
          }
          onCreated();
        },
        en ? "Evaluation queued" : "Đã xếp hàng đánh giá",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={en ? "Controlled provider experiments" : "Thử nghiệm agent có kiểm soát"}>
      <Notice>
        {en
          ? "Fixture controls exercise the workflow and validators, not model quality. Live calls remain blocked on workers without verified budget/isolation support."
          : "Fixture kiểm tra workflow và bộ xác minh, không đo chất lượng mô hình. Lượt gọi thật bị chặn trên worker chưa xác minh giới hạn chi phí và cô lập."}
      </Notice>
      {!suites.data?.length && (
        <p>
          {en ? "Publish the existing benchmark suite first." : "Hãy công bố bộ benchmark hiện có trước."}
          {admin && (
            <button
              className="sm"
              onClick={() =>
                act(async () => {
                  await api("/api/benchmark-suites/publish", {});
                  await suites.reload();
                })
              }
            >
              {en ? "Publish builtin suite" : "Công bố bộ chuẩn"}
            </button>
          )}
        </p>
      )}
      <div className="an-filter-grid">
        <Field label={en ? "Provider sequence" : "Chuỗi agent"}>
          <select
            aria-label={en ? "Provider sequence" : "Chuỗi agent"}
            value={plan}
            onChange={(e) => {
              setPlan(e.target.value);
              setModels([]);
            }}
          >
            {plans.map((p) => (
              <option key={p} value={p}>
                {p.split(",").join(" → ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label={en ? "Context variant" : "Biến thể ngữ cảnh"}>
          <select
            aria-label={en ? "Context variant" : "Biến thể ngữ cảnh"}
            value={variant}
            onChange={(e) => setVariant(e.target.value)}
          >
            <option value="minimal">A · {en ? "Minimal task" : "Nhiệm vụ tối thiểu"}</option>
            <option value="pack">B · {en ? "Context pack" : "Gói ngữ cảnh"}</option>
            <option value="tools">C · {en ? "Pack + tools" : "Gói + công cụ"}</option>
          </select>
        </Field>
        <Field label={en ? "Repetitions" : "Số lần lặp"}>
          <input
            aria-label={en ? "Repetitions" : "Số lần lặp"}
            type="number"
            min={1}
            max={3}
            value={reps}
            onChange={(e) => setReps(Number(e.target.value))}
          />
        </Field>
        <Field label={en ? "Cases" : "Số nhiệm vụ"}>
          <input
            aria-label={en ? "Cases" : "Số nhiệm vụ"}
            type="number"
            min={1}
            max={20}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
        </Field>
        {plan.split(",").map((provider, i) => (
          <Field key={i} label={`${provider} · ${en ? "configured model" : "mô hình cấu hình"}`}>
            <input
              value={models[i] ?? ""}
              placeholder={en ? "Default/unreported" : "Mặc định/chưa báo cáo"}
              onChange={(e) =>
                setModels((old) => {
                  const next = [...old];
                  next[i] = e.target.value;
                  return next;
                })
              }
            />
          </Field>
        ))}
        <Field label={en ? "Execution" : "Thực thi"}>
          <select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value);
              setPaid(false);
            }}
          >
            <option value="fixture">{en ? "Fixture controls" : "Điều khiển fixture"}</option>
            <option value="dry_run">{en ? "Dry run" : "Chạy thử cấu hình"}</option>
            {admin && (
              <option value="live">
                {en ? "Live capability check (may be blocked)" : "Kiểm tra chạy thật (có thể bị chặn)"}
              </option>
            )}
          </select>
        </Field>
      </div>
      {mode === "live" && (
        <label>
          <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} />
          {en
            ? "Record administrator approval; this does not bypass sandbox or budget requirements."
            : "Ghi nhận phê duyệt quản trị; không bỏ qua yêu cầu sandbox hoặc ngân sách."}
        </label>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="sm"
          disabled={busy || !suites.data?.length || (mode === "live" && !paid)}
          onClick={() => queue()}
        >
          {en ? "Queue evaluation" : "Xếp hàng đánh giá"}
        </button>
        <button
          className="sm ghost"
          disabled={busy || !suites.data?.length || mode !== "fixture"}
          onClick={() => queue(true)}
        >
          {en ? "Queue A/B/C context study" : "Xếp hàng nghiên cứu A/B/C"}
        </button>
        <button className="quiet sm" onClick={() => navigate("/insights/quality")}>
          {en ? "Existing benchmark runner & paired comparisons" : "Benchmark và so sánh cặp hiện có"}
        </button>
      </div>
    </Panel>
  );
}
