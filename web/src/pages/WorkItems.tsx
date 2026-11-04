import { useMemo, useState } from "react";
import {
  ChevronRight, CircleHelp, Clock, Download, FileJson, FileText, FolderGit2, GitPullRequest, History, KeyRound, ListTodo, LogIn, PenLine, Pencil, Play, Plus,
  RefreshCw, ScanSearch, Settings2, Sparkles, StepForward, Workflow, Zap,
} from "lucide-react";
import { api, useApi, useLive } from "../api.ts";
import { act, ago, Badge, Drawer, EmptyState, ErrorBox, Field, JsonBlock, Loading, Markdown, navigate, PageHeader, SearchInput, Segmented, SkeletonRows, time } from "../ui.tsx";
import { RunsTable } from "./Runs.tsx";
import { ProfilePreview, type ProfileChoice } from "./ProfilePreview.tsx";
import "./WorkItems.css";

const WI_STATUS: Record<string, { label: string }> = {
  open: { label: "Mở" },
  in_progress: { label: "Đang làm" },
  done: { label: "Xong" },
  archived: { label: "Lưu trữ" },
};
const wiBadge = (s: string) => (s === "in_progress" ? "RUNNING" : s === "done" ? "COMPLETED" : "PENDING");
function WiStatus({ s }: { s: string }) {
  return <Badge s={wiBadge(s)}>{WI_STATUS[s]?.label ?? s}</Badge>;
}
const SOURCE_LABELS: Record<string, string> = { manual: "Manual", hasaki_work: "Hasaki Work", jira: "Jira", legacy: "Legacy" };

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
    <section className="card wi-hasaki">
      <div className="card-head">
        <span className="wi-hicon"><Sparkles size={16} strokeWidth={2} /></span>
        <h4>Hasaki Work</h4>
        {st && (st.loggedIn ? <Badge s="COMPLETED">đã đăng nhập</Badge> : <Badge s="FAILED">chưa đăng nhập</Badge>)}
      </div>
      {st?.expiresAt && <div className="muted small wi-hexp"><Clock size={12} strokeWidth={2} /> hết hạn {time(st.expiresAt)}</div>}
      {st && !st.loggedIn && (
        <div className="stack wi-hlogin">
          {st.windowOpen ? <span className="muted small"><span className="spinner" /> Đăng nhập trong cửa sổ Chromium…</span> : (
            <button className="sm" onClick={async () => (await act(() => api("/api/work/login-window", {}))) && reloadSt()}><LogIn size={14} strokeWidth={2} />Mở trình duyệt đăng nhập</button>
          )}
          <div className="wi-inline">
            <input aria-label="Token" placeholder="hoặc dán token (Bearer eyJ…)" value={token} onChange={(e) => setToken(e.target.value)} />
            <button className="sm ghost" onClick={async () => (await act(() => api("/api/work/token", { token }), "Đã lưu token")) && (setToken(""), reloadSt())}><KeyRound size={14} strokeWidth={2} />Lưu</button>
          </div>
        </div>
      )}
      {st?.loggedIn && (
        <div className="stack wi-hlogin">
          <button className="sm" disabled={busy} onClick={refresh}><RefreshCw size={14} strokeWidth={2} className={busy ? "wi-spin" : undefined} />{busy ? "Đang lấy…" : "Lấy task"}</button>
          <div className="wi-inline">
            <input aria-label="Task id" placeholder="Task id (vd 14408473)" value={taskId} onChange={(e) => setTaskId(e.target.value)} />
            <button className="sm ghost" disabled={!taskId} onClick={() => pick(taskId)}><Download size={14} strokeWidth={2} />Import</button>
          </div>
        </div>
      )}
      {!!inbox?.length && (
        <>
          <div className="wi-hsub">Hộp task <span className="muted">· {inbox.length}</span></div>
          <div className="wi-hinbox">
            {inbox.map((r) => (
              <div key={r.work_id} className="wi-hitem">
                <div className="wi-hitem-main">
                  <div className="wi-hitem-meta"><span className="mono">{r.code}</span>{r.project && <span>· {r.project}</span>}</div>
                  <div className="wi-hitem-name">{r.name}</div>
                </div>
                {r.work_item_id ? (
                  <a className="wi-hitem-link" href={`#/work-items/${r.work_item_id}`}>{r.run_status ? <Badge s={r.run_status} label /> : <span className="pill chip-brand">imported</span>}</a>
                ) : (
                  <button className="xs ghost" onClick={() => pick(r.work_id)}>Import</button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
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
  const [panel, setPanel] = useState<"" | "create" | "import">("");
  const [q, setQ] = useState("");
  const [statusF, setStatusF] = useState("");
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

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const w of data ?? []) c[w.status] = (c[w.status] ?? 0) + 1;
    return c;
  }, [data]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data ?? []).filter((w) => (!statusF || w.status === statusF) && (!s || [w.code, w.title, w.project].some((v) => v && String(v).toLowerCase().includes(s))));
  }, [data, q, statusF]);

  return (
    <div className="wi-page">
      <PageHeader
        icon={ListTodo}
        title="Work Items"
        subtitle="Yêu cầu kỹ thuật. Import không bao giờ tự chạy — bạn chọn workflow để chạy."
        crumbs={[["Overview", "#/overview"], ["Work Items"]]}
        actions={
          <>
            <button className="ghost icon" aria-label="Làm mới danh sách" title="Làm mới" onClick={reload}><RefreshCw size={16} strokeWidth={2} /></button>
            <button className="ghost" onClick={() => setPanel("import")}><FileJson size={15} strokeWidth={2} />Import JSON / Jira</button>
            <button onClick={() => setPanel("create")}><Plus size={16} strokeWidth={2.2} />Yêu cầu mới</button>
          </>
        }
      />

      <div className="wi-layout">
        <div className="wi-main">
          <div className="wi-toolbar">
            <SearchInput value={q} onChange={setQ} placeholder="Tìm code, tiêu đề, project…" width="min(320px, 100%)" />
            <div className="wi-scroll">
              <Segmented<string>
                label="Nguồn"
                value={source}
                onChange={setSource}
                options={[["", "Mọi nguồn"], ...["manual", "hasaki_work", "jira", "legacy"].map((s) => [s, SOURCE_LABELS[s]] as [string, string])]}
              />
            </div>
          </div>
          <div className="wi-statusbar" role="group" aria-label="Lọc theo trạng thái">
            {([["", "Tất cả", data?.length ?? 0], ...Object.entries(WI_STATUS).map(([k, v]) => [k, v.label, counts[k] ?? 0])] as Array<[string, string, number]>).map(([k, label, n]) => (
              <button key={k || "all"} type="button" className={`wi-sf${statusF === k ? " on" : ""}`} aria-pressed={statusF === k} onClick={() => setStatusF(k)}>
                {k && <i className={`wi-dot wi-dot-${k}`} />}{label}<span className="wi-sf-n">{n}</span>
              </button>
            ))}
          </div>

          {loading && !data ? <SkeletonRows rows={6} /> : error ? <ErrorBox error={error} onRetry={reload} /> : !data?.length ? (
            <EmptyState icon={ListTodo} title="Chưa có work item" action={<button onClick={() => setPanel("create")}><Plus size={16} strokeWidth={2.2} />Tạo yêu cầu đầu tiên</button>}>
              Tạo yêu cầu thủ công, import JSON/Jira hoặc lấy task từ Hasaki Work.
            </EmptyState>
          ) : !shown.length ? (
            <EmptyState icon={ScanSearch} title="Không có work item phù hợp">Thử từ khoá khác hoặc bỏ bộ lọc.</EmptyState>
          ) : (
            <div className="wi-list">
              {shown.map((w) => (
                <a key={w.id} className="wi-row" href={`#/work-items/${w.id}`}>
                  <i className={`wi-bar wi-dot-${w.status}`} aria-hidden />
                  <div className="wi-row-main">
                    <div className="wi-row-meta">
                      <span className="mono wi-code">{w.code}</span>
                      <span className="wi-src">{SOURCE_LABELS[w.source] ?? w.source}</span>
                      {w.project && <span className="wi-proj"><FolderGit2 size={12} strokeWidth={2} />{w.project}</span>}
                    </div>
                    <div className="wi-row-title">{w.title}</div>
                  </div>
                  <div className="wi-row-side">
                    <WiStatus s={w.status} />
                    <div className="wi-row-runs">
                      <span className="muted small"><Workflow size={12} strokeWidth={2} /> {w.run_count} run</span>
                      {w.last_run_status && <Badge s={w.last_run_status} label />}
                    </div>
                    <span className="muted small wi-row-time"><Clock size={12} strokeWidth={2} />{ago(w.updated_at)} trước</span>
                  </div>
                  <ChevronRight size={18} strokeWidth={1.9} className="wi-chev" aria-hidden />
                </a>
              ))}
            </div>
          )}
        </div>

        <aside className="wi-aside">
          <HasakiPanel onImported={reload} />
          <div className="wi-note">
            <Zap size={15} strokeWidth={2} />
            <span>Import chỉ tạo work item. Mở work item để xem mô tả và chọn workflow chạy.</span>
          </div>
        </aside>
      </div>

      {panel === "create" && (
        <Drawer title="Yêu cầu mới (manual)" onClose={() => setPanel("")}>
          <Field label="Tiêu đề"><input autoFocus placeholder="Tiêu đề" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Project"><input placeholder="Project (vd OMS)" value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} /></Field>
          <Field label="Mô tả"><textarea rows={8} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <div className="row">
            <button disabled={!form.title.trim()} onClick={async () => { const w = await act(() => api<any>("/api/work-items", form)); if (w) navigate(`/work-items/${w.id}`); }}><Plus size={15} strokeWidth={2.2} />Tạo</button>
            <button className="ghost" onClick={() => setPanel("")}>Huỷ</button>
          </div>
        </Drawer>
      )}
      {panel === "import" && (
        <Drawer title="Import JSON / Jira" onClose={() => setPanel("")}>
          <Field label="JSON"><textarea className="code" rows={10} placeholder="Dán JSON task Hasaki hoặc Jira issue" value={paste} onChange={(e) => setPaste(e.target.value)} /></Field>
          <div className="row">
            <button className="ghost" disabled={!paste} onClick={() => importJson("hasaki_work")}><Download size={14} strokeWidth={2} />Import Hasaki</button>
            <button className="ghost" disabled={!paste} onClick={() => importJson("jira")}><Download size={14} strokeWidth={2} />Import Jira</button>
          </div>
          <div className="divider" />
          {meta?.jiraEnabled ? (
            <Field label="Lấy từ Jira API">
              <div className="wi-inline">
                <input placeholder="JIRA-123" value={jiraKey} onChange={(e) => setJiraKey(e.target.value)} />
                <button className="ghost" onClick={async () => { const r = await act(() => api<any>("/api/work-items/import", { source: "jira", key: jiraKey })); if (r) navigate(`/work-items/${r.item.id}`); }}>Fetch</button>
              </div>
            </Field>
          ) : (
            <div className="muted small">Jira API chưa cấu hình — dán JSON.</div>
          )}
        </Drawer>
      )}
    </div>
  );
}

/** View / edit the request description (tasks often arrive with an empty note). Edits are kept across re-imports. */
function DescriptionEditor({ id, description, source, onSaved }: { id: number; description: string; source?: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(description ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await act(() => api(`/api/work-items/${id}`, { description: text }), "Đã lưu mô tả");
    setBusy(false);
    if (r) (setEditing(false), onSaved());
  };
  return (
    <div>
      <div className="card-head">
        <span className="wi-hicon"><FileText size={16} strokeWidth={2} /></span>
        <h4>Yêu cầu</h4>
        {source === "manual" && !editing && <span className="pill" title="Đã sửa tay — import lại từ Hasaki Work/Jira sẽ không ghi đè"><PenLine size={12} strokeWidth={2} /> đã sửa tay</span>}
        {!editing && (
          <button className="sm ghost" onClick={() => (setText(description ?? ""), setEditing(true))}>
            {description ? <><Pencil size={13} strokeWidth={2} />Sửa</> : <><Plus size={14} strokeWidth={2.2} />Thêm mô tả</>}
          </button>
        )}
      </div>
      {editing ? (
        <div>
          <textarea rows={10} autoFocus placeholder="Mô tả yêu cầu: hiện tượng, kết quả mong đợi, đối tượng (mã đơn...), repo/màn hình liên quan… (Markdown)" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row">
            <button className="sm" disabled={busy} onClick={save}>{busy ? "Đang lưu…" : "Lưu"}</button>
            <button className="sm ghost" onClick={() => setEditing(false)}>Huỷ</button>
            <span className="muted small">Agent sẽ dùng mô tả này ở các lần chạy sau.</span>
          </div>
        </div>
      ) : description ? (
        <div className="wi-desc"><Markdown text={description} /></div>
      ) : (
        <div className="wi-desc-empty">
          <CircleHelp size={18} strokeWidth={1.9} />
          <span>Không có mô tả — bấm “Thêm mô tả” để bổ sung trước khi chạy workflow.</span>
        </div>
      )}
    </div>
  );
}

export function WorkItemDetail({ id }: { id: number }) {
  const { data: w, error, loading, reload } = useApi<any>(`/api/work-items/${id}`);
  const { data: wfs } = useApi<any[]>("/api/workflows");
  useLive(null, (p) => (!p || p.kind === "status") && reload());
  const [wf, setWf] = useState("feature-implementation");
  const [profile, setProfile] = useState<ProfileChoice>("AUTO");
  if (loading && !w) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const start = async (mode: "start" | "step" | "pending") => {
    const r = await act(() => api<any>(`/api/work-items/${id}/runs`, { workflow: wf, start: mode === "start", profile }));
    if (!r) return;
    if (mode === "step") await act(() => api(`/api/runs/${r.id}/start`, { step_mode: true }));
    navigate(`/runs/${r.id}`);
  };
  const selectedWf = (wfs ?? []).find((x) => x.key === wf);
  return (
    <div className="wi-page">
      <PageHeader
        icon={ListTodo}
        title={w.title}
        crumbs={[["Work Items", "#/work-items"], [w.code || `#${id}`]]}
      >
        <div className="wi-hmeta">
          <span className="mono wi-code">{w.code}</span>
          <WiStatus s={w.status} />
          <span className="wi-src">{SOURCE_LABELS[w.source] ?? w.source}</span>
          <span className="wi-proj"><FolderGit2 size={12} strokeWidth={2} />{w.project || "không có project"}</span>
        </div>
      </PageHeader>

      <div className="wi-detail">
        <div className="wi-detail-main">
          <section className="card">
            <DescriptionEditor id={id} description={w.description} source={w.description_source} onSaved={reload} />
            {w.payload && Object.keys(w.payload).length > 0 && <details className="wi-raw"><summary>raw payload</summary><JsonBlock value={w.payload} /></details>}
          </section>

          <section className="wi-section">
            <div className="wi-section-head"><History size={16} strokeWidth={2} /><h4>Lịch sử thực thi</h4><span className="muted small">{w.runs.length} run</span></div>
            <RunsTable runs={w.runs} />
          </section>

          {w.pull_requests.length > 0 && (
            <section className="card">
              <div className="card-head"><span className="wi-hicon"><GitPullRequest size={16} strokeWidth={2} /></span><h4>Pull requests</h4></div>
              <div className="wi-prs">
                {w.pull_requests.map((p: any) => (
                  <div key={p.id} className="wi-pr">
                    <div className="wi-pr-main"><b>{p.repo}</b> · <a href={p.url} target="_blank" rel="noopener">{p.title}</a></div>
                    <span className="muted mono small">{p.source_branch} → {p.target_branch}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {w.legacy && (w.legacy.questions.length > 0 || w.legacy.events.length > 0) && (
            <details className="card flat wi-legacy">
              <summary>Lịch sử cũ (trước workflow) — {w.legacy.questions.length} câu hỏi, {w.legacy.events.length} sự kiện</summary>
              {w.legacy.questions.map((q: any) => <div key={q.id} className="q"><b>{q.question}</b><div className="muted">→ {q.answer ?? "(chưa trả lời)"}</div></div>)}
              {w.legacy.events.map((e: any) => <div key={e.id} className="small"><span className="muted">{time(e.created_at)}</span> <b>{e.kind}</b> {e.content}</div>)}
            </details>
          )}
        </div>

        <aside className="wi-detail-side">
          <section className="card hero wi-launch">
            <div className="wi-launch-head">
              <span className="wi-launch-icon"><Play size={18} strokeWidth={2.2} /></span>
              <div>
                <h4>Chạy workflow</h4>
                <div className="muted small">Chọn workflow và profile, rồi bắt đầu.</div>
              </div>
            </div>
            <Field label="Workflow">
              <select value={wf} onChange={(e) => setWf(e.target.value)}>
                {(wfs ?? []).filter((x) => x.latest_version > 0).map((x) => <option key={x.key} value={x.key}>{x.name} (v{x.latest_version}) — {x.description?.slice(0, 60)}</option>)}
              </select>
            </Field>
            {selectedWf?.description && <div className="wi-wfdesc">{selectedWf.description}</div>}
            <ProfilePreview workflow={wf} workItemId={id} value={profile} onChange={setProfile} />
            <button className="wi-start" onClick={() => start("start")}><Play size={16} strokeWidth={2.2} />Start</button>
            <div className="wi-launch-alt">
              <button className="ghost sm" onClick={() => start("step")} title="Run steps one at a time"><StepForward size={14} strokeWidth={2} />Step mode</button>
              <button className="ghost sm" onClick={() => start("pending")}><Settings2 size={14} strokeWidth={2} />Tạo (cấu hình trước)</button>
              <button className="ghost sm" onClick={async () => { const r = await act(() => api<any>(`/api/work-items/${id}/analyze`, {})); if (r) navigate(`/runs/${r.id}`); }}><ScanSearch size={14} strokeWidth={2} />Chỉ phân tích</button>
            </div>
          </section>

          <section className="card">
            <div className="card-head"><span className="wi-hicon"><Settings2 size={16} strokeWidth={2} /></span><h4>Thiết lập</h4></div>
            <Field label="Automation policy" hint="Chỉ dùng khi poller tự import task: tự chạy workflow này. Mặc định không có — không gì tự chạy.">
              <div className="wi-policy">
                <span className="grow small">{w.automation_policy ? <>Tự chạy <b>{w.automation_policy.workflow}</b></> : "Không có"}</span>
                <button className="xs ghost" onClick={async () => (await act(() => api(`/api/work-items/${id}`, { automation_policy: { workflow: wf } }), "Saved")) && reload()}>Dùng workflow đang chọn</button>
                {w.automation_policy && <button className="xs ghost" onClick={async () => (await act(() => api(`/api/work-items/${id}`, { automation_policy: null }))) && reload()}>Xoá</button>}
              </div>
            </Field>
            <Field label="Trạng thái">
              <select value={w.status} onChange={async (e) => (await act(() => api(`/api/work-items/${id}`, { status: e.target.value }))) && reload()}>
                {["open", "in_progress", "done", "archived"].map((s) => <option key={s} value={s}>{WI_STATUS[s].label} ({s})</option>)}
              </select>
            </Field>
          </section>
        </aside>
      </div>
    </div>
  );
}
