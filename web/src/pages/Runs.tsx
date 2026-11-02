import { useState } from "react";
import { api, useApi, useLive, STATUS_COLORS } from "../api.ts";
import { act, ago, Badge, Empty, ErrorBox, Loading, navigate } from "../ui.tsx";

export function StepChips({ steps }: { steps: Array<{ key: string; status: string }> | null }) {
  return (
    <span className="chips">
      {(steps ?? []).map((s) => <span key={s.key} className="chip" title={`${s.key}: ${s.status}`} style={{ color: STATUS_COLORS[s.status] }} />)}
    </span>
  );
}

export function RunsTable({ runs }: { runs: any[] }) {
  if (!runs.length) return <Empty>Chưa có run nào.</Empty>;
  return (
    <table>
      <thead><tr><th>#</th><th>Run</th><th>Workflow</th><th>Status</th><th>Steps</th><th>Đang chờ</th><th>Cập nhật</th></tr></thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className="click" onClick={() => navigate(`/runs/${r.id}`)}>
            <td>{r.id}</td>
            <td>{r.title}<div className="muted small mono">{r.branch}</div></td>
            <td>{r.definition_key} <span className="muted">v{r.definition_version}</span></td>
            <td><Badge s={r.status} /></td>
            <td><StepChips steps={r.steps} /></td>
            <td>{r.open_questions > 0 && <Badge s="WAITING_INPUT">❓ {r.open_questions}</Badge>}</td>
            <td className="muted small">{ago(r.updated_at)} trước</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RunsPage() {
  const [status, setStatus] = useState("");
  const { data, error, loading, reload } = useApi<any[]>(`/api/runs${status ? `?status=${status}` : ""}`, [status]);
  const { data: wfs } = useApi<any[]>("/api/workflows");
  useLive(null, (p) => (!p || p.kind === "status") && reload());
  const [wf, setWf] = useState("");
  return (
    <div>
      <div className="row tight">
        <h2 className="grow">Workflow Runs</h2>
        <select style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Tất cả trạng thái</option>
          {["RUNNING", "WAITING", "PAUSED", "PENDING", "FAILED", "COMPLETED", "CANCELED"].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <div className="card row" style={{ marginTop: 8 }}>
        <b className="small">Chạy workflow:</b>
        <select style={{ width: "auto" }} value={wf} onChange={(e) => setWf(e.target.value)}>
          <option value="">— chọn workflow —</option>
          {(wfs ?? []).filter((w) => w.latest_version > 0).map((w) => <option key={w.key} value={w.key}>{w.name} (v{w.latest_version})</option>)}
        </select>
        <button className="sm" disabled={!wf} onClick={() => navigate(`/workflows/${wf}`)}>Mở & chạy…</button>
        <span className="muted small">Hoặc chạy từ một Work Item để gắn với task.</span>
      </div>
      {loading && !data ? <Loading /> : error ? <ErrorBox error={error} onRetry={reload} /> : <RunsTable runs={data ?? []} />}
    </div>
  );
}

export async function startRunFor(body: any) {
  const r = await act(() => api<any>("/api/runs", body));
  if (r) navigate(`/runs/${r.id}`);
}
