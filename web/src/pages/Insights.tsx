import { useState } from "react";
import { useApi, useLive } from "../api.ts";
import { Badge, Empty, ErrorBox, JsonBlock, Loading, navigate, time } from "../ui.tsx";

function Table({ rows, cols }: { rows: any[]; cols: Array<[string, string, ((r: any) => any)?]> }) {
  if (!rows?.length) return <Empty>Chưa có dữ liệu.</Empty>;
  return (
    <table>
      <thead><tr>{cols.map(([, h]) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(([k, h, f]) => <td key={h} className={typeof r[k] === "number" ? "mono" : ""}>{f ? f(r) : String(r[k] ?? "")}</td>)}</tr>)}</tbody>
    </table>
  );
}

/** Observability: cost/tokens per workflow, step-type durations & failures, tool / integration / skill usage. */
export function InsightsPage() {
  const [days, setDays] = useState(30);
  const { data, error, loading, reload } = useApi<any>(`/api/metrics/summary?days=${days}`, [days]);
  const { data: tools } = useApi<any[]>("/api/tools");
  useLive(null, (p) => p?.kind === "status" && reload());
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <div>
      <div className="row tight">
        <h2 className="grow">Insights</h2>
        <select style={{ width: "auto" }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 30, 90].map((d) => <option key={d} value={d}>{d} ngày</option>)}
        </select>
      </div>
      <div className="muted">Chi phí, token, thời gian, lỗi và mức dùng tool/skill — lấy từ metrics của từng attempt trong PostgreSQL.</div>
      {data.evaluation && <HarnessEvaluation e={data.evaluation} />}
      <h3>So sánh theo profile</h3>
      <Table rows={data.by_profile} cols={[["profile", "Profile"], ["runs", "Runs"], ["completed", "Completed"], ["avg_wall_min", "Avg wall (min)"], ["claude_attempts_per_run", "Claude steps/run"], ["turns_per_run", "Turns/run"], ["cost_per_run", "≈ Cost/run ($)"]]} />
      <h3>Theo workflow</h3>
      <Table rows={data.by_workflow} cols={[["definition_key", "Workflow"], ["runs", "Runs"], ["completed", "Completed"], ["failed", "Failed"], ["cost_usd", "Cost ($)"], ["tokens", "Tokens (in+out)"]]} />
      <h3>Theo loại bước</h3>
      <Table rows={data.by_step_type} cols={[["type", "Step type"], ["attempts", "Attempts"], ["failed", "Failed"], ["avg_seconds", "Avg (s)"], ["cost_usd", "Cost ($)"]]} />
      <div className="grid2">
        <div><h3>Tool (Claude Code + platform)</h3><Table rows={data.tools} cols={[["tool", "Tool"], ["calls", "Calls"], ["attempts", "Attempts"]]} /></div>
        <div><h3>Integration tools</h3><Table rows={data.integrations} cols={[["name", "Tool"], ["calls", "Calls"], ["failed", "Failed"], ["avg_ms", "Avg ms"]]} /></div>
        <div><h3>Skills / knowledge đã nạp</h3><Table rows={data.skills} cols={[["key", "Key", (r) => <a href={`#/knowledge/${r.key}`}>{r.key}</a>], ["loads", "Loads"]]} /></div>
        <div><h3>Tool bị policy chặn</h3><Table rows={data.denied} cols={[["tool", "Tool"], ["reason", "Reason"], ["times", "Times"]]} /></div>
      </div>
      <h3>Lỗi gần đây</h3>
      <Table rows={data.failures} cols={[["run_id", "Run", (r) => <a onClick={() => navigate(`/runs/${r.run_id}/${r.step_key}`)} style={{ cursor: "pointer" }}>#{r.run_id} · {r.step_key}</a>], ["type", "Type"], ["finished_at", "At", (r) => time(r.finished_at)], ["error", "Error"]]} />
      <h3>Integration tool registry</h3>
      <div className="muted small">Agent khám phá qua list_tools → describe_tool → call_tool (không nạp schema từ đầu).</div>
      <Table rows={tools ?? []} cols={[["name", "Name"], ["summary", "Summary"], ["read_only", "Mode", (r) => (r.read_only ? <Badge s="COMPLETED">read-only</Badge> : <Badge s="WAITING">write</Badge>)], ["available", "Available", (r) => (r.available === true ? "✓" : <span className="muted small">{String(r.available)}</span>)], ["input_schema", "Schema", (r) => <details><summary>schema</summary><JsonBlock value={r.input_schema} /></details>]]} />
    </div>
  );
}

/** Harness evaluation — whether coding steps passed the platform's own verification; separate from run status. */
function HarnessEvaluation({ e }: { e: any }) {
  const v = e.verification ?? {};
  const h = e.human_intervention ?? {};
  const stat = (label: string, value: any, hint?: string) => (
    <div className="card" style={{ margin: 0 }} title={hint}>
      <div className="muted small">{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value ?? "—"}</div>
    </div>
  );
  return (
    <>
      <h3>Harness evaluation</h3>
      <div className="muted small">Đánh giá chất lượng (tách biệt với trạng thái run): coding step có qua verification của platform không, mất bao nhiêu lần sửa, lỗi nào lặp lại, bao nhiêu run cần người can thiệp.</div>
      <div className="grid3" style={{ gridTemplateColumns: "repeat(5, 1fr)", marginTop: 8 }}>
        {stat("Verification pass", v.pass_rate_pct != null ? `${v.pass_rate_pct}%` : null, `${v.passed ?? 0}/${v.verified ?? 0} coding attempts đã kiểm`)}
        {stat("Pass ngay lần đầu", v.first_try_pass_rate_pct != null ? `${v.first_try_pass_rate_pct}%` : null)}
        {stat("Repairs / attempt", v.avg_repairs)}
        {stat("Dừng: hết lượt / không tiến triển", `${v.repair_budget_exhausted ?? 0} / ${v.stopped_no_progress ?? 0}`)}
        {stat("Run cần người", h.rate_pct != null ? `${h.rate_pct}%` : null, `${h.with_human ?? 0}/${h.runs ?? 0} runs · ${h.answers ?? 0} câu trả lời · ${h.reexecutions ?? 0} re-execute`)}
      </div>
      {e.repeated_failures?.length > 0 && (
        <>
          <div className="small muted" style={{ marginTop: 8 }}>Lỗi verification lặp lại</div>
          <Table rows={e.repeated_failures} cols={[["signature", "Failure signature"], ["times", "Times"], ["runs", "Runs"]]} />
        </>
      )}
    </>
  );
}
