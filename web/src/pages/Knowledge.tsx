import { useEffect, useState } from "react";
import { api, useApi } from "../api.ts";
import { act, Badge, Empty, ErrorBox, Field, Loading, Markdown, navigate, Tabs, time } from "../ui.tsx";

const CATS: Array<[string, string]> = [
  ["", "Tất cả"],
  ["business_rule", "Business rules"],
  ["architecture_guideline", "Architecture"],
  ["coding_standard", "Coding conventions"],
  ["repository_convention", "Repo instructions"],
  ["domain_knowledge", "Domain"],
  ["security_policy", "Security"],
  ["agent_skill", "Skills"],
];
const SCOPES = ["GLOBAL", "ORGANIZATION", "PROJECT", "REPOSITORY", "WORKFLOW", "STEP"];
const SCOPE_HINT: Record<string, string> = {
  GLOBAL: "",
  ORGANIZATION: "vd hasaki",
  PROJECT: "vd OMS",
  REPOSITORY: "vd oms-api",
  WORKFLOW: "workflow key, vd feature-implementation",
  STEP: "workflow:step hoặc step key, vd feature-implementation:implement",
};

type Draft = {
  key: string; title: string; category: string; scope_type: string; scope_ref: string; conflict_key: string; priority: number; enforced: boolean; enabled: boolean;
  content: string; applicability: string; metadata: string; change_note: string;
};
const emptyDraft = (category = "business_rule"): Draft => ({
  key: "", title: "", category, scope_type: "GLOBAL", scope_ref: "", conflict_key: "", priority: 0, enforced: false, enabled: true, content: "",
  applicability: "{}", metadata: category === "agent_skill" ? '{\n  "required_tools": ["Read", "Grep"],\n  "output_contract": ""\n}' : "{}", change_note: "",
});

export function KnowledgePage({ itemKey }: { itemKey?: string }) {
  const [cat, setCat] = useState("");
  const { data, error, loading, reload } = useApi<any[]>(`/api/knowledge${cat ? `?category=${cat}` : ""}`, [cat]);
  return (
    <div>
      <h2>Knowledge & Skills</h2>
      <div className="muted">Business rule, architecture guideline, convention và agent skill. Mỗi bước nhận đúng các item áp dụng theo scope (GLOBAL &lt; ORG &lt; PROJECT &lt; REPO &lt; WORKFLOW &lt; STEP) hoặc được gán trong workflow editor.</div>
      <div className="grid2" style={{ gridTemplateColumns: "minmax(320px, 1fr) 1.4fr", marginTop: 12, alignItems: "start" }}>
        <div>
          <Tabs tabs={CATS} value={cat} onChange={setCat} />
          <div className="row tight" style={{ marginBottom: 8 }}>
            <button className="sm" onClick={() => navigate("/knowledge/~new")}>+ Item mới</button>
            <RepoImport onDone={reload} />
          </div>
          {loading && !data ? <Loading /> : error ? <ErrorBox error={error} onRetry={reload} /> : !data?.length ? <Empty>Chưa có item.</Empty> : (
            <table>
              <tbody>
                {data.map((k) => (
                  <tr key={k.key} className="click" style={{ background: k.key === itemKey ? "var(--sel)" : undefined, opacity: k.enabled ? 1 : 0.55 }} onClick={() => navigate(`/knowledge/${k.key}`)}>
                    <td>
                      <b>{k.title}</b> {k.enforced && <Badge s="FAILED">enforced</Badge>} {!k.enabled && <Badge s="CANCELED">off</Badge>}
                      <div className="muted small"><span className="mono">{k.key}</span> · {k.category} · {k.scope_type}{k.scope_ref && `:${k.scope_ref}`} · v{k.current_version}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>{itemKey ? <KnowledgeEditor key={itemKey} itemKey={itemKey} defaultCategory={cat || "business_rule"} onSaved={reload} /> : <Empty>Chọn một item để xem/sửa, hoặc tạo mới.</Empty>}</div>
      </div>
    </div>
  );
}

/** Scan repositories (CLAUDE.md, skills, cursor rules, wiki docs): preview first, then import. */
function RepoImport({ onDone }: { onDone: () => void }) {
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dry: boolean) => {
    setBusy(true);
    const r = await act(() => api<any>("/api/knowledge/import-repos", { dry_run: dry }), dry ? undefined : "Đã import từ repository");
    setBusy(false);
    if (!r) return;
    if (dry) setPreview(r);
    else (setPreview(null), onDone());
  };
  return (
    <>
      <button className="sm ghost" disabled={busy} onClick={() => run(true)}>{busy ? "Đang quét…" : "⟳ Quét repository"}</button>
      {preview && (
        <div className="card" style={{ width: "100%", marginTop: 8 }}>
          <div className="row tight">
            <b className="grow">{preview.created} mới · {preview.updated} cập nhật · {preview.unchanged} không đổi</b>
            <button className="sm" disabled={busy || !(preview.created + preview.updated)} onClick={() => run(false)}>Import</button>
            <button className="xs ghost" onClick={() => setPreview(null)}>✕</button>
          </div>
          <div style={{ maxHeight: 260, overflow: "auto", marginTop: 6 }}>
            {preview.candidates.filter((c: any) => c.action !== "unchanged").map((c: any) => (
              <div key={c.key} className="small"><Badge s={c.action === "create" ? "READY" : "WAITING"}>{c.action}</Badge> <span className="mono">{c.key}</span> <span className="muted">{c.category} · {c.repos.join(", ")}</span></div>
            ))}
            {preview.skipped.map((s: any) => <div key={s.path} className="small err">bỏ qua {s.path} — {s.reason}</div>)}
          </div>
        </div>
      )}
    </>
  );
}

function KnowledgeEditor({ itemKey, defaultCategory, onSaved }: { itemKey: string; defaultCategory: string; onSaved: () => void }) {
  const isNew = itemKey === "~new";
  const { data: item, error, reload } = useApi<any>(isNew ? null : `/api/knowledge/${itemKey}`);
  const { data: usage } = useApi<any>(isNew ? null : `/api/knowledge/${itemKey}/usage`);
  const [d, setD] = useState<Draft>(emptyDraft(defaultCategory));
  const [tab, setTab] = useState<"edit" | "preview" | "versions" | "usage">("edit");
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  useEffect(() => {
    if (!item) return;
    const v = item.versions[0];
    setD({
      key: item.key, title: item.title, category: item.category, scope_type: item.scope_type, scope_ref: item.scope_ref, conflict_key: item.conflict_key ?? "",
      priority: item.priority, enforced: item.enforced, enabled: item.enabled, content: v?.content ?? "",
      applicability: JSON.stringify(v?.applicability ?? {}, null, 2), metadata: JSON.stringify(v?.metadata ?? {}, null, 2), change_note: "",
    });
  }, [item]);
  if (error) return <ErrorBox error={error} />;
  if (!isNew && !item) return <Loading />;
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const save = async () => {
    let applicability, metadata;
    try {
      applicability = JSON.parse(d.applicability || "{}");
      metadata = JSON.parse(d.metadata || "{}");
    } catch {
      return act(async () => { throw new Error("Applicability / metadata phải là JSON hợp lệ"); });
    }
    const body = { ...d, conflict_key: d.conflict_key || null, applicability, metadata };
    const r = await act(() => api<any>(isNew ? "/api/knowledge" : `/api/knowledge/${itemKey}`, body), isNew ? "Đã tạo" : "Đã lưu (nội dung đổi → version mới)");
    if (r) {
      onSaved();
      if (isNew) navigate(`/knowledge/${r.key}`);
      else reload();
    }
  };
  const shown = viewVersion ? item.versions.find((v: any) => v.version === viewVersion) : null;
  return (
    <div className="card">
      <div className="row tight">
        <h4 className="grow" style={{ margin: 0 }}>{isNew ? "Knowledge item mới" : d.title}</h4>
        {!isNew && <span className="muted small">v{item.current_version} · cập nhật {time(item.updated_at)}</span>}
      </div>
      <Tabs
        tabs={[["edit", "Sửa"], ["preview", "Preview"], ...(!isNew ? ([["versions", `Versions (${item.versions.length})`], ["usage", `Đã dùng (${usage?.used.length ?? 0})`]] as Array<[any, string]>) : [])]}
        value={tab}
        onChange={setTab}
      />
      {tab === "edit" && (
        <>
          <div className="grid2">
            <Field label="Key"><input value={d.key} disabled={!isNew} onChange={(e) => set({ key: e.target.value })} /></Field>
            <Field label="Title"><input value={d.title} onChange={(e) => set({ title: e.target.value })} /></Field>
            <Field label="Category"><select value={d.category} disabled={!isNew} onChange={(e) => set({ category: e.target.value })}>{CATS.slice(1).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Scope"><select value={d.scope_type} onChange={(e) => set({ scope_type: e.target.value, scope_ref: e.target.value === "GLOBAL" ? "" : d.scope_ref })}>{SCOPES.map((s) => <option key={s}>{s}</option>)}</select></Field>
            {d.scope_type !== "GLOBAL" && <Field label="Scope ref"><input placeholder={SCOPE_HINT[d.scope_type]} value={d.scope_ref} onChange={(e) => set({ scope_ref: e.target.value })} /></Field>}
            <Field label="Conflict key" hint="Item cùng conflict key cạnh tranh; scope hẹp hơn thắng."><input value={d.conflict_key} onChange={(e) => set({ conflict_key: e.target.value })} /></Field>
            <Field label="Priority"><input type="number" value={d.priority} onChange={(e) => set({ priority: Number(e.target.value) })} /></Field>
          </div>
          <div className="row tight">
            <label className="small"><input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled</label>
            <label className="small"><input type="checkbox" checked={d.enforced} onChange={(e) => set({ enforced: e.target.checked })} /> Enforced (scope hẹp hơn không ghi đè được)</label>
          </div>
          <Field label={d.category === "agent_skill" ? "Skill instructions (Markdown)" : "Nội dung (Markdown)"}><textarea rows={10} value={d.content} onChange={(e) => set({ content: e.target.value })} /></Field>
          <div className="grid2">
            <Field label="Applicability (JSON)" hint="step_types, step_keys, repos, projects, workflows, keywords"><textarea className="code" rows={5} value={d.applicability} onChange={(e) => set({ applicability: e.target.value })} /></Field>
            <Field label="Metadata (JSON)" hint="skills: required_tools, output_contract"><textarea className="code" rows={5} value={d.metadata} onChange={(e) => set({ metadata: e.target.value })} /></Field>
          </div>
          <div className="row">
            {!isNew && <input style={{ maxWidth: 320 }} placeholder="change note" value={d.change_note} onChange={(e) => set({ change_note: e.target.value })} />}
            <button onClick={save}>{isNew ? "Tạo" : "Lưu"}</button>
          </div>
        </>
      )}
      {tab === "preview" && <Markdown text={d.content || "_(trống)_"} />}
      {tab === "versions" && (
        <div>
          {item.versions.map((v: any) => (
            <div key={v.version} className="row tight" style={{ padding: "3px 0" }}>
              <button className={viewVersion === v.version ? "xs" : "xs ghost"} onClick={() => setViewVersion(viewVersion === v.version ? null : v.version)}>v{v.version}</button>
              <span className="small muted">{time(v.created_at)}</span> <span className="small">{v.change_note}</span>
            </div>
          ))}
          {shown && <div className="card" style={{ marginTop: 8 }}><Markdown text={shown.content} /></div>}
          <h3>Audit</h3>
          {item.audit.map((a: any) => <div key={a.id} className="small"><span className="muted">{time(a.created_at)}</span> <b>{a.action}</b> <span className="mono">{JSON.stringify(a.detail)}</span></div>)}
        </div>
      )}
      {tab === "usage" && usage && (
        <div>
          <h3>Được gán trong workflow</h3>
          {usage.assigned.length ? usage.assigned.map((a: any, i: number) => (
            <div key={i} className="small"><a href={`#/workflows/${a.workflow}`}>{a.workflow}</a> <span className="muted">({a.version === "draft" ? "draft" : `v${a.version}`})</span> {a.step ? <>· bước <b>{a.step}</b></> : "· mọi bước"}</div>
          )) : <div className="muted small">Không được gán trực tiếp (chỉ áp dụng theo scope).</div>}
          <h3>Thực sự được áp dụng trong các lần chạy</h3>
          {usage.used.length ? usage.used.map((u: any, i: number) => (
            <div key={i} className="small"><a href={`#/runs/${u.run_id}/${u.step_key}`}>Run #{u.run_id} · {u.step_name}</a> <span className="muted">{u.definition_key} · v{u.version} · {time(u.created_at)}</span></div>
          )) : <div className="muted small">Chưa bước nào nhận item này.</div>}
        </div>
      )}
    </div>
  );
}
