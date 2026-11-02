import { useState } from "react";
import { api, useApi, useLive } from "../api.ts";
import { act, ago, Badge, Empty, ErrorBox, Field, JsonBlock, Loading, Markdown, navigate, time } from "../ui.tsx";
import { RunsTable } from "./Runs.tsx";

function HasakiPanel({ onImported }: { onImported: () => void }) {
  const { data: st, reload: reloadSt } = useApi<any>("/api/work/status");
  const { data: inbox, reload: reloadInbox } = useApi<any[]>("/api/work/inbox");
  const [token, setToken] = useState("");
  const [taskId, setTaskId] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    const r = await act(() => api<any>("/api/work/refresh", {}));
    setBusy(false);
    if (r) reloadInbox();
  };
  const pick = async (workId: number | string) => {
    const r = await act(() => api<any>(`/api/work/pick/${workId}`, {}), "Đã import — chưa chạy gì, chọn workflow để chạy");
    if (r) (reloadInbox(), onImported(), navigate(`/work-items/${r.work_item_id}`));
  };
  return (
    <div className="card">
      <div className="row tight">
        <h4 className="grow" style={{ margin: 0 }}>Hasaki Work</h4>
        {st && (st.loggedIn ? <Badge s="COMPLETED">đã đăng nhập</Badge> : <Badge s="FAILED">chưa đăng nhập</Badge>)}
      </div>
      {st?.expiresAt && <div className="muted small">hết hạn {time(st.expiresAt)}</div>}
      {st && !st.loggedIn && (
        <>
          <div className="row">
            {st.windowOpen ? <span className="muted small">Đăng nhập trong cửa sổ Chromium…</span> : <button className="sm" onClick={async () => (await act(() => api("/api/work/login-window", {}))) && reloadSt()}>Mở trình duyệt đăng nhập</button>}
          </div>
          <div className="row"><input placeholder="hoặc dán token (Bearer eyJ…)" value={token} onChange={(e) => setToken(e.target.value)} /><button className="sm" onClick={async () => (await act(() => api("/api/work/token", { token }), "Đã lưu token")) && (setToken(""), reloadSt())}>Lưu</button></div>
        </>
      )}
      {st?.loggedIn && (
        <>
          <div className="row"><button className="sm" disabled={busy} onClick={refresh}>{busy ? "Đang lấy…" : "Lấy task"}</button></div>
          <div className="row"><input placeholder="Task id (vd 14408473)" value={taskId} onChange={(e) => setTaskId(e.target.value)} /><button className="sm ghost" disabled={!taskId} onClick={() => pick(taskId)}>Import</button></div>
        </>
      )}
      {!!inbox?.length && (
        <div style={{ maxHeight: 260, overflow: "auto", marginTop: 8 }}>
          {inbox.map((r) => (
            <div key={r.work_id} className="row tight small" style={{ padding: "4px 0", borderBottom: "1px dashed var(--line)" }}>
              <div className="grow"><span className="mono muted">{r.code}</span> · <span className="muted">{r.project}</span><div>{r.name}</div></div>
              {r.work_item_id ? <a href={`#/work-items/${r.work_item_id}`}>{r.run_status ? <Badge s={r.run_status} /> : "imported"}</a> : <button className="xs ghost" onClick={() => pick(r.work_id)}>Import</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkItemsPage() {
  const [source, setSource] = useState("");
  const { data, error, loading, reload } = useApi<any[]>(`/api/work-items${source ? `?source=${source}` : ""}`, [source]);
  const { data: meta } = useApi<any>("/api/meta");
  useLive(null, (p) => (!p || p.kind === "status") && reload());
  const [form, setForm] = useState({ title: "", project: "", description: "" });
  const [paste, setPaste] = useState("");
  const [jiraKey, setJiraKey] = useState("");
  const importJson = async (src: string) => {
    let payload;
    try {
      payload = JSON.parse(paste);
    } catch {
      return act(async () => { throw new Error("JSON không hợp lệ"); });
    }
    const r = await act(() => api<any>("/api/work-items/import", { source: src, payload }), "Đã import — chưa chạy gì");
    if (r) (setPaste(""), navigate(`/work-items/${r.item?.id ?? r.work_item_id}`));
  };
  return (
    <div>
      <h2>Work Items</h2>
      <div className="muted">Yêu cầu kỹ thuật. Import không bao giờ tự chạy — bạn chọn workflow để chạy.</div>
      <div className="grid3" style={{ marginTop: 12 }}>
        <div className="card">
          <h4>Yêu cầu mới (manual)</h4>
          <input placeholder="Tiêu đề" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <div className="row"><input placeholder="Project (vd OMS)" value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} /></div>
          <Field label="Mô tả"><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <button className="sm" disabled={!form.title.trim()} onClick={async () => { const w = await act(() => api<any>("/api/work-items", form)); if (w) navigate(`/work-items/${w.id}`); }}>Tạo</button>
        </div>
        <div className="card">
          <h4>Import JSON</h4>
          <textarea className="code" rows={5} placeholder="Dán JSON task Hasaki hoặc Jira issue" value={paste} onChange={(e) => setPaste(e.target.value)} />
          <div className="row"><button className="sm ghost" disabled={!paste} onClick={() => importJson("hasaki_work")}>Hasaki</button><button className="sm ghost" disabled={!paste} onClick={() => importJson("jira")}>Jira</button></div>
          {meta?.jiraEnabled ? (
            <div className="row"><input placeholder="JIRA-123" value={jiraKey} onChange={(e) => setJiraKey(e.target.value)} /><button className="sm ghost" onClick={async () => { const r = await act(() => api<any>("/api/work-items/import", { source: "jira", key: jiraKey })); if (r) navigate(`/work-items/${r.item.id}`); }}>Fetch</button></div>
          ) : (
            <div className="muted small" style={{ marginTop: 6 }}>Jira API chưa cấu hình — dán JSON.</div>
          )}
        </div>
        <HasakiPanel onImported={reload} />
      </div>
      <div className="row tight" style={{ marginTop: 6 }}>
        <h3 className="grow">Tất cả work item</h3>
        <select style={{ width: "auto" }} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Mọi nguồn</option>
          {["manual", "hasaki_work", "jira", "legacy"].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      {loading && !data ? <Loading /> : error ? <ErrorBox error={error} onRetry={reload} /> : !data?.length ? <Empty>Chưa có work item.</Empty> : (
        <table>
          <thead><tr><th>Code</th><th>Tiêu đề</th><th>Nguồn</th><th>Project</th><th>Trạng thái</th><th>Runs</th><th>Run gần nhất</th><th>Cập nhật</th></tr></thead>
          <tbody>
            {data.map((w) => (
              <tr key={w.id} className="click" onClick={() => navigate(`/work-items/${w.id}`)}>
                <td className="mono">{w.code}</td><td>{w.title}</td><td>{w.source}</td><td>{w.project}</td><td><Badge s={w.status === "in_progress" ? "RUNNING" : w.status === "done" ? "COMPLETED" : "PENDING"}>{w.status}</Badge></td>
                <td>{w.run_count}</td><td>{w.last_run_status && <Badge s={w.last_run_status} />}</td><td className="muted small">{ago(w.updated_at)} trước</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function WorkItemDetail({ id }: { id: number }) {
  const { data: w, error, loading, reload } = useApi<any>(`/api/work-items/${id}`);
  const { data: wfs } = useApi<any[]>("/api/workflows");
  useLive(null, (p) => (!p || p.kind === "status") && reload());
  const [wf, setWf] = useState("feature-implementation");
  if (loading && !w) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const start = async (mode: "start" | "step" | "pending") => {
    const r = await act(() => api<any>(`/api/work-items/${id}/runs`, { workflow: wf, start: mode === "start" }));
    if (!r) return;
    if (mode === "step") await act(() => api(`/api/runs/${r.id}/start`, { step_mode: true }));
    navigate(`/runs/${r.id}`);
  };
  return (
    <div>
      <div className="small"><a href="#/work-items">Work Items</a> /</div>
      <h2>{w.title}</h2>
      <div className="muted"><span className="mono">{w.code}</span> · {w.source} · {w.project || "không có project"} · {w.status}</div>
      <div className="grid2" style={{ marginTop: 12 }}>
        <div className="card">
          <h4>Yêu cầu</h4>
          {w.description ? <Markdown text={w.description} /> : <span className="muted">(không có mô tả)</span>}
          {w.payload && Object.keys(w.payload).length > 0 && <details><summary>raw payload</summary><JsonBlock value={w.payload} /></details>}
        </div>
        <div className="card">
          <h4>Chạy workflow</h4>
          <Field label="Workflow">
            <select value={wf} onChange={(e) => setWf(e.target.value)}>
              {(wfs ?? []).filter((x) => x.latest_version > 0).map((x) => <option key={x.key} value={x.key}>{x.name} (v{x.latest_version}) — {x.description?.slice(0, 60)}</option>)}
            </select>
          </Field>
          <div className="row">
            <button onClick={() => start("start")}>▶ Start</button>
            <button className="ghost" onClick={() => start("step")} title="Run steps one at a time">⏯ Step mode</button>
            <button className="ghost" onClick={() => start("pending")}>Tạo (cấu hình trước)</button>
            <button className="ghost" onClick={async () => { const r = await act(() => api<any>(`/api/work-items/${id}/analyze`, {})); if (r) navigate(`/runs/${r.id}`); }}>Chỉ phân tích</button>
          </div>
          <Field label="Automation policy" hint="Chỉ dùng khi poller tự import task: tự chạy workflow này. Mặc định không có — không gì tự chạy.">
            <div className="row tight">
              <span className="grow small">{w.automation_policy ? <>Tự chạy <b>{w.automation_policy.workflow}</b></> : "Không có"}</span>
              <button className="xs ghost" onClick={async () => (await act(() => api(`/api/work-items/${id}`, { automation_policy: { workflow: wf } }), "Saved")) && reload()}>Dùng workflow đang chọn</button>
              {w.automation_policy && <button className="xs ghost" onClick={async () => (await act(() => api(`/api/work-items/${id}`, { automation_policy: null }))) && reload()}>Xoá</button>}
            </div>
          </Field>
          <Field label="Trạng thái">
            <select value={w.status} onChange={async (e) => (await act(() => api(`/api/work-items/${id}`, { status: e.target.value }))) && reload()}>
              {["open", "in_progress", "done", "archived"].map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
        </div>
      </div>
      <h3>Lịch sử thực thi</h3>
      <RunsTable runs={w.runs} />
      {w.pull_requests.length > 0 && (
        <>
          <h3>Pull requests</h3>
          {w.pull_requests.map((p: any) => <div key={p.id} className="small"><b>{p.repo}</b> · <a href={p.url} target="_blank" rel="noopener">{p.title}</a> <span className="muted mono">{p.source_branch} → {p.target_branch}</span></div>)}
        </>
      )}
      {w.legacy && (w.legacy.questions.length > 0 || w.legacy.events.length > 0) && (
        <details>
          <summary>Lịch sử cũ (trước workflow) — {w.legacy.questions.length} câu hỏi, {w.legacy.events.length} sự kiện</summary>
          {w.legacy.questions.map((q: any) => <div key={q.id} className="q"><b>{q.question}</b><div className="muted">→ {q.answer ?? "(chưa trả lời)"}</div></div>)}
          {w.legacy.events.map((e: any) => <div key={e.id} className="small"><span className="muted">{time(e.created_at)}</span> <b>{e.kind}</b> {e.content}</div>)}
        </details>
      )}
    </div>
  );
}
