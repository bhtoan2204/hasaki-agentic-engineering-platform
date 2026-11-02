import { useState } from "react";
import { api, useApi } from "../api.ts";
import { act, ago, Badge, ErrorBox, Loading, navigate } from "../ui.tsx";

export function WorkflowsPage() {
  const { data, error, loading, reload } = useApi<any[]>("/api/workflows");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const create = async (from?: any) => {
    const spec = from
      ? { ...(from.draft_spec ?? from.versions[0].spec), name: name || `${from.name} (copy)` }
      : { name: name || key, description: "", steps: [{ key: "analyze", type: "agent", name: "Analyze", config: { instructions: "", output_contract: "{ summary }" } }] };
    const r = await act(() => api("/api/workflows", { key, spec, publish: false }));
    if (r) navigate(`/workflows/${key}`);
  };
  const duplicate = async (src: string) => {
    if (!key) return act(async () => { throw new Error("Nhập key cho workflow mới trước"); });
    create(await api(`/api/workflows/${src}`));
  };
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <div>
      <h2>Workflow Library</h2>
      <div className="muted">Workflow có version. Mở để chỉnh trên canvas, publish version mới; run đang chạy giữ version cũ.</div>
      <div className="card row" style={{ marginTop: 10 }}>
        <b className="small">Workflow mới:</b>
        <input style={{ maxWidth: 220 }} placeholder="key (lowercase-dashes)" value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} />
        <input style={{ maxWidth: 260 }} placeholder="Tên" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="sm" disabled={!key} onClick={() => create()}>Tạo trống</button>
        <span className="muted small">hoặc “Duplicate” một template bên dưới</span>
      </div>
      <table>
        <thead><tr><th>Workflow</th><th>Key</th><th>Version</th><th>Runs</th><th>Cập nhật</th><th></th></tr></thead>
        <tbody>
          {(data ?? []).map((w) => (
            <tr key={w.key} className="click" onClick={() => navigate(`/workflows/${w.key}`)}>
              <td><b>{w.name}</b>{w.is_template && <> <Badge s="PENDING">template</Badge></>}<div className="muted small">{w.description}</div></td>
              <td className="mono">{w.key}</td>
              <td>{w.latest_version ? `v${w.latest_version}` : <Badge s="PENDING">chưa publish</Badge>} {w.has_draft && <Badge s="WAITING">draft</Badge>}</td>
              <td>{w.run_count}</td>
              <td className="muted small">{ago(w.updated_at)} trước</td>
              <td><button className="xs ghost" onClick={(e) => (e.stopPropagation(), duplicate(w.key))}>Duplicate</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
