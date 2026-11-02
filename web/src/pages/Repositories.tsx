import { useEffect, useState } from "react";
import { api, useApi } from "../api.ts";
import { act, Badge, ErrorBox, Field, Loading, navigate } from "../ui.tsx";

const LISTS = ["projects", "services", "tags", "owners", "dependencies", "allowed_actions"] as const;

export function RepositoriesPage({ name }: { name?: string }) {
  const { data, error, loading, reload } = useApi<any[]>("/api/repositories");
  const [form, setForm] = useState<any>(null);
  const [rank, setRank] = useState({ text: "", project: "" });
  const [ranked, setRanked] = useState<any>(null);
  useEffect(() => {
    if (!data) return;
    const r = name ? data.find((x) => x.name === name) : null;
    setForm(
      r
        ? { ...r, ...Object.fromEntries(LISTS.map((k) => [k, r[k].join(", ")])) }
        : { name: "", description: "", architecture: "", enabled: true, ...Object.fromEntries(LISTS.map((k) => [k, k === "allowed_actions" ? "read, write, pull_request" : ""])) },
    );
  }, [data, name]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const save = async () => {
    const body = { ...form, ...Object.fromEntries(LISTS.map((k) => [k, String(form[k]).split(",").map((x: string) => x.trim()).filter(Boolean)])) };
    if (await act(() => api(`/api/repositories/${encodeURIComponent(form.name)}`, body), "Đã lưu")) (reload(), navigate(`/repositories/${form.name}`));
  };
  return (
    <div>
      <h2>Repositories</h2>
      <div className="muted">Registry dùng cho repository discovery và tập repo được phép (theo project). Agent không bao giờ sửa repo ngoài tập được phép của run.</div>
      <div className="grid2" style={{ gridTemplateColumns: "1.3fr 1fr", alignItems: "start", marginTop: 12 }}>
        <table>
          <thead><tr><th>Repo</th><th>Projects</th><th>Services / tags</th><th>Actions</th></tr></thead>
          <tbody>
            {data!.map((r) => (
              <tr key={r.name} className="click" style={{ background: r.name === name ? "var(--sel)" : undefined, opacity: r.enabled ? 1 : 0.5 }} onClick={() => navigate(`/repositories/${r.name}`)}>
                <td><b className="mono">{r.name}</b>{!r.enabled && <> <Badge s="CANCELED">off</Badge></>}<div className="muted small">{r.description}</div></td>
                <td className="small">{r.projects.join(", ") || <span className="muted">—</span>}</td>
                <td className="small">{[...r.services, ...r.tags].join(", ")}</td>
                <td className="small">{r.allowed_actions.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div>
          {form && (
            <div className="card">
              <div className="row tight"><h4 className="grow" style={{ margin: 0 }}>{name ? `Sửa ${name}` : "Thêm repo"}</h4>{name && <button className="xs ghost" onClick={() => navigate("/repositories")}>+ mới</button>}</div>
              <Field label="Tên (thư mục trong reposRoot)"><input value={form.name} disabled={!!name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <div className="grid2">
                {LISTS.map((k) => <Field key={k} label={`${k} (phân cách bằng dấu phẩy)`}><input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></Field>)}
              </div>
              <Field label="Mô tả (dùng để gợi ý repo)"><textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
              <Field label="Kiến trúc / ghi chú"><textarea rows={3} value={form.architecture} onChange={(e) => setForm({ ...form, architecture: e.target.value })} /></Field>
              <label className="small"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
              <div className="row"><button disabled={!form.name} onClick={save}>Lưu</button></div>
            </div>
          )}
          <div className="card">
            <h4>Thử gợi ý repo</h4>
            <div className="row tight"><input placeholder="mô tả yêu cầu" value={rank.text} onChange={(e) => setRank({ ...rank, text: e.target.value })} /><input style={{ maxWidth: 110 }} placeholder="project" value={rank.project} onChange={(e) => setRank({ ...rank, project: e.target.value })} /></div>
            <div className="row"><button className="sm ghost" onClick={async () => setRanked(await act(() => api("/api/repositories/rank", rank)))}>Xếp hạng</button></div>
            {ranked && (
              <div style={{ marginTop: 6 }}>
                {ranked.ambiguous && <div className="small" style={{ color: "var(--warn)" }}>⚠️ Không rõ ràng — workflow sẽ hỏi bạn chọn</div>}
                {ranked.ranked.map((r: any) => <div key={r.repo} className="small"><b>{r.repo}</b> {r.score} <span className="muted">{r.reasons.join(" · ")}</span></div>)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
