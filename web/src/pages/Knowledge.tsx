import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft, BookMarked, BookOpen, Building2, Code2, Eye, FileText, FolderGit2, FolderKanban, Globe, History, Landmark, Layers, Lock, Plus, Power,
  ScanSearch, ScrollText, Shield, Sparkles, SquarePen, Workflow, Footprints, Zap, type LucideIcon,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import { act, Badge, Drawer, EmptyState, ErrorBox, Field, JsonBlock, Markdown, navigate, PageHeader, SearchInput, SkeletonRows, Tabs, time } from "../ui.tsx";
import "./Knowledge.css";

const CATS: Array<[string, string]> = [
  ["", "Tất cả"],
  ["business_rule", "Business rules"],
  ["architecture_guideline", "Architecture"],
  ["coding_standard", "Coding conventions"],
  ["repository_convention", "Repo instructions"],
  ["domain_knowledge", "Domain"],
  ["security_policy", "Security"],
  ["agent_skill", "Skills"],
  ["task_memory", "Task memory"],
];
const CAT_ICON: Record<string, LucideIcon> = {
  "": Layers, business_rule: Landmark, architecture_guideline: Building2, coding_standard: Code2, repository_convention: FolderGit2,
  domain_knowledge: BookMarked, security_policy: Shield, agent_skill: Sparkles, task_memory: History,
};
const catLabel = (c: string) => CATS.find(([k]) => k === c)?.[1] ?? c;
const SCOPES = ["GLOBAL", "ORGANIZATION", "PROJECT", "REPOSITORY", "WORKFLOW", "STEP"];
const SCOPE_HINT: Record<string, string> = {
  GLOBAL: "",
  ORGANIZATION: "vd hasaki",
  PROJECT: "vd OMS",
  REPOSITORY: "vd oms-api",
  WORKFLOW: "workflow key, vd feature-implementation",
  STEP: "workflow:step hoặc step key, vd feature-implementation:implement",
};
const SCOPE_STYLE: Record<string, { color: string; icon: LucideIcon }> = {
  GLOBAL: { color: "var(--brand)", icon: Globe },
  ORGANIZATION: { color: "var(--st-run)", icon: Building2 },
  PROJECT: { color: "var(--st-wait)", icon: FolderKanban },
  REPOSITORY: { color: "var(--st-ok)", icon: FolderGit2 },
  WORKFLOW: { color: "var(--rose-ink)", icon: Workflow },
  STEP: { color: "var(--st-idle)", icon: Footprints },
};

function ScopeBadge({ type, scopeRef }: { type: string; scopeRef?: string }) {
  const s = SCOPE_STYLE[type] ?? { color: "var(--muted)", icon: Globe };
  const I = s.icon;
  return (
    <span className="kn-scope" style={{ color: s.color }} title={`Scope ${type}${scopeRef ? `: ${scopeRef}` : ""}`}>
      <I size={12} strokeWidth={2.2} />{type}{scopeRef ? <span className="kn-scope-ref">:{scopeRef}</span> : null}
    </span>
  );
}
/** Load mode follows the context planner: metadata.load === "on_demand" → index only, anything else → inline. */
const loadMode = (metadata: any) => (metadata?.load === "on_demand" ? "on_demand" : "inline");
function LoadChip({ metadata }: { metadata: any }) {
  const m = loadMode(metadata);
  return <span className={`kn-load is-${m}`} title={m === "on_demand" ? "Chỉ đưa vào index, agent nạp khi cần" : "Nạp đầy đủ vào prompt"}>{m === "on_demand" ? <Eye size={11} /> : <Zap size={11} />}{m === "on_demand" ? "on-demand" : "inline"}</span>;
}

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
  // Category counts need the unfiltered list; only fetched separately while a category filter is active.
  const all = useApi<any[]>(cat ? "/api/knowledge" : null, [cat]);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("");
  const counts = useMemo(() => {
    const src = cat ? all.data : data;
    const m: Record<string, number> = {};
    for (const k of src ?? []) m[k.category] = (m[k.category] ?? 0) + 1;
    return src ? ({ ...m, "": src.length } as Record<string, number>) : null;
  }, [cat, all.data, data]);
  const reloadAll = () => {
    reload();
    if (cat) all.reload();
  };
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter(
      (k) =>
        (!scope || k.scope_type === scope) &&
        (!needle || [k.title, k.key, k.scope_ref, k.metadata?.description].some((x) => String(x ?? "").toLowerCase().includes(needle))),
    );
  }, [data, q, scope]);

  return (
    <div className="kn">
      <PageHeader
        icon={BookOpen}
        title="Knowledge & Skills"
        subtitle="Business rule, architecture guideline, convention và agent skill. Mỗi bước nhận đúng các item áp dụng theo scope (GLOBAL < ORG < PROJECT < REPO < WORKFLOW < STEP) hoặc được gán trong workflow editor."
        actions={
          <>
            <RepoImport onDone={reloadAll} />
            <button onClick={() => navigate("/knowledge/~new")}><Plus size={15} strokeWidth={2.2} />Item mới</button>
          </>
        }
      />
      <nav className="kn-cats" aria-label="Danh mục">
        {CATS.map(([k, label]) => {
          const I = CAT_ICON[k] ?? Layers;
          return (
            <button key={k} type="button" className={`kn-cat${k === cat ? " on" : ""}`} aria-pressed={k === cat} onClick={() => setCat(k)}>
              <I size={15} strokeWidth={2} />
              <span>{label}</span>
              {counts && <span className="kn-cat-count">{counts[k] ?? 0}</span>}
            </button>
          );
        })}
      </nav>
      <div className={`kn-layout${itemKey ? " has-detail" : ""}`}>
        <aside className="kn-list">
          <div className="kn-filter">
            <SearchInput value={q} onChange={setQ} placeholder="Tìm theo tên, key…" width="100%" />
            <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Lọc theo scope">
              <option value="">Mọi scope</option>
              {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {loading && !data ? <SkeletonRows rows={6} /> : error ? <ErrorBox error={error} onRetry={reload} /> : !data?.length ? (
            <EmptyState icon={BookOpen} title="Chưa có item" action={<button className="sm" onClick={() => navigate("/knowledge/~new")}><Plus size={14} />Tạo item</button>}>
              Tạo item mới hoặc quét repository để import CLAUDE.md, skills, rules.
            </EmptyState>
          ) : !items.length ? (
            <div className="kn-none">Không có item khớp bộ lọc.</div>
          ) : (
            <ul className="kn-items">
              {items.map((k) => {
                const I = CAT_ICON[k.category] ?? FileText;
                return (
                  <li key={k.key}>
                    <button type="button" className={`kn-item${k.key === itemKey ? " on" : ""}${k.enabled ? "" : " is-off"}`} onClick={() => navigate(`/knowledge/${k.key}`)}>
                      <span className="kn-item-icon"><I size={16} strokeWidth={2} /></span>
                      <span className="kn-item-body">
                        <span className="kn-item-title">
                          <b>{k.title}</b>
                          {k.enforced && <Badge s="FAILED">enforced</Badge>}
                          {!k.enabled && <Badge s="CANCELED">off</Badge>}
                        </span>
                        <span className="kn-item-key mono">{k.key}</span>
                        <span className="kn-item-meta">
                          <ScopeBadge type={k.scope_type} scopeRef={k.scope_ref} />
                          <span className="kn-tag">{catLabel(k.category)}</span>
                          <span className="kn-tag mono">v{k.current_version}</span>
                          <LoadChip metadata={k.metadata} />
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
        <section className="kn-detail">
          {itemKey ? (
            <KnowledgeEditor key={itemKey} itemKey={itemKey} defaultCategory={cat || "business_rule"} onSaved={reloadAll} />
          ) : (
            <div className="card kn-placeholder">
              <EmptyState icon={BookOpen} title="Chọn một item để xem/sửa" action={<button className="sm ghost" onClick={() => navigate("/knowledge/~new")}><Plus size={14} />Tạo mới</button>}>
                Mỗi item có nội dung Markdown, scope áp dụng, lịch sử version và audit log.
              </EmptyState>
            </div>
          )}
        </section>
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
  const changed = preview ? preview.candidates.filter((c: any) => c.action !== "unchanged") : [];
  return (
    <>
      <button className="ghost" disabled={busy} onClick={() => run(true)}>{busy ? <span className="spinner" /> : <ScanSearch size={15} />}{busy ? "Đang quét…" : "Quét repository"}</button>
      {preview && (
        <Drawer title="Import từ repository" onClose={() => setPreview(null)} width={560}>
          <div className="kn-import-sum">
            <div><b>{preview.created}</b><span>mới</span></div>
            <div><b>{preview.updated}</b><span>cập nhật</span></div>
            <div><b>{preview.unchanged}</b><span>không đổi</span></div>
          </div>
          <div className="row tight" style={{ marginBottom: 12 }}>
            <button disabled={busy || !(preview.created + preview.updated)} onClick={() => run(false)}>Import</button>
            <button className="ghost" onClick={() => setPreview(null)}>Đóng</button>
          </div>
          {changed.length > 0 && (
            <ul className="kn-import-list">
              {changed.map((c: any) => (
                <li key={c.key}>
                  <Badge s={c.action === "create" ? "READY" : "WAITING"}>{c.action}</Badge>
                  <div className="kn-import-body"><span className="mono">{c.key}</span><span className="muted small">{c.category} · {c.repos.join(", ")}</span></div>
                </li>
              ))}
            </ul>
          )}
          {preview.skipped.length > 0 && (
            <>
              <h3>Bỏ qua</h3>
              {preview.skipped.map((s: any) => <div key={s.path} className="small err kn-skip">bỏ qua <span className="mono">{s.path}</span> — {s.reason}</div>)}
            </>
          )}
          {!changed.length && !preview.skipped.length && <div className="muted small">Không có thay đổi nào.</div>}
        </Drawer>
      )}
    </>
  );
}

function Section({ icon: I, title, children, aside }: { icon: LucideIcon; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="kn-section">
      <div className="kn-section-head"><I size={15} strokeWidth={2} /><h4>{title}</h4>{aside}</div>
      {children}
    </section>
  );
}

/** Renders applicability / metadata objects: arrays as chips, scalars as text, anything else as JSON. */
function KeyValues({ value, empty }: { value: any; empty: string }) {
  const entries = Object.entries(value ?? {});
  if (!entries.length) return <div className="muted small">{empty}</div>;
  return (
    <dl className="kn-kv">
      {entries.map(([k, x]) => (
        <div key={k} className="kn-kv-row">
          <dt>{k}</dt>
          <dd>
            {Array.isArray(x) && x.every((y) => typeof y !== "object" || y === null) ? (
              x.length ? x.map((y, i) => <span key={i} className="pill">{String(y)}</span>) : <span className="muted">[]</span>
            ) : x !== null && typeof x === "object" ? <JsonBlock value={x} /> : <span className={typeof x === "string" ? "" : "mono"}>{x === null ? "null" : String(x)}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function KnowledgeEditor({ itemKey, defaultCategory, onSaved }: { itemKey: string; defaultCategory: string; onSaved: () => void }) {
  const isNew = itemKey === "~new";
  const { data: item, error, reload } = useApi<any>(isNew ? null : `/api/knowledge/${itemKey}`);
  const { data: usage } = useApi<any>(isNew ? null : `/api/knowledge/${itemKey}/usage`);
  const [d, setD] = useState<Draft>(emptyDraft(defaultCategory));
  const [tab, setTab] = useState<"overview" | "edit" | "preview" | "versions" | "audit" | "usage">(isNew ? "edit" : "overview");
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
  const back = <button className="quiet sm kn-back" onClick={() => navigate("/knowledge")}><ArrowLeft size={15} />Danh sách</button>;
  if (error) return <div>{back}<ErrorBox error={error} /></div>;
  if (!isNew && !item) return <div className="card"><SkeletonRows rows={5} /></div>;
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
  const cur = isNew ? null : item.versions[0];
  const CatIcon = CAT_ICON[isNew ? d.category : item.category] ?? FileText;
  const tabs: Array<[typeof tab, ReactNode]> = isNew
    ? [["edit", <><SquarePen size={14} />Soạn</>], ["preview", <><Eye size={14} />Preview</>]]
    : [
        ["overview", <><FileText size={14} />Tổng quan</>],
        ["edit", <><SquarePen size={14} />Sửa</>],
        ["preview", <><Eye size={14} />Preview</>],
        ["versions", <><History size={14} />Versions <span className="kn-tab-count">{item.versions.length}</span></>],
        ["audit", <><ScrollText size={14} />Audit <span className="kn-tab-count">{item.audit.length}</span></>],
        ["usage", <><Workflow size={14} />Đã dùng <span className="kn-tab-count">{usage?.used.length ?? 0}</span></>],
      ];

  return (
    <div className="kn-editor">
      {back}
      <div className="card kn-head">
        <span className="kn-head-icon"><CatIcon size={20} strokeWidth={2} /></span>
        <div className="kn-head-main">
          <h2 className="kn-head-title">{isNew ? "Knowledge item mới" : d.title || item.title}</h2>
          {isNew ? (
            <div className="muted small">Điền thông tin, scope và nội dung rồi bấm Tạo.</div>
          ) : (
            <>
              <div className="kn-head-key mono">{item.key}</div>
              <div className="kn-item-meta">
                <ScopeBadge type={item.scope_type} scopeRef={item.scope_ref} />
                <span className="kn-tag">{catLabel(item.category)}</span>
                <span className="kn-tag mono">v{item.current_version}</span>
                <LoadChip metadata={cur?.metadata} />
                {item.enforced && <Badge s="FAILED">enforced</Badge>}
                {item.enabled ? <Badge s="COMPLETED">enabled</Badge> : <Badge s="CANCELED">off</Badge>}
              </div>
            </>
          )}
        </div>
        {!isNew && <div className="kn-head-time muted small">cập nhật {time(item.updated_at)}</div>}
      </div>

      <div className="card kn-body">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />

        {tab === "overview" && !isNew && cur?.metadata?.memory && <MemoryProvenance itemKey={item.key} m={cur.metadata.memory} onDone={reload} />}
        {tab === "overview" && !isNew && (
          <div className="kn-overview">
            <Section icon={FileText} title={item.category === "agent_skill" ? "Skill instructions" : "Nội dung"} aside={<span className="muted small">v{cur?.version ?? item.current_version}</span>}>
              <div className="kn-content">{cur?.content ? <Markdown text={cur.content} /> : <span className="muted">(trống)</span>}</div>
            </Section>
            <div className="kn-overview-grid">
              <Section icon={Layers} title="Scope & applicability">
                <dl className="kn-kv">
                  <div className="kn-kv-row"><dt>scope</dt><dd><ScopeBadge type={item.scope_type} scopeRef={item.scope_ref} /></dd></div>
                  <div className="kn-kv-row"><dt>conflict key</dt><dd>{item.conflict_key ? <span className="mono">{item.conflict_key}</span> : <span className="muted">—</span>}</dd></div>
                  <div className="kn-kv-row"><dt>priority</dt><dd className="mono">{item.priority}</dd></div>
                  <div className="kn-kv-row"><dt>enforced</dt><dd>{item.enforced ? <span className="kn-flag"><Lock size={12} />scope hẹp hơn không ghi đè được</span> : <span className="muted">không</span>}</dd></div>
                  <div className="kn-kv-row"><dt>enabled</dt><dd>{item.enabled ? <span className="okc">có</span> : <span className="kn-flag"><Power size={12} />tắt</span>}</dd></div>
                </dl>
                <div className="kn-sub-head">Applicability</div>
                <KeyValues value={cur?.applicability} empty="Không giới hạn — áp dụng theo scope." />
              </Section>
              <Section icon={BookMarked} title="Metadata">
                <KeyValues value={cur?.metadata} empty="Không có metadata." />
              </Section>
            </div>
          </div>
        )}

        {tab === "edit" && (
          <div className="kn-form">
            <fieldset className="kn-fieldset">
              <legend>Định danh</legend>
              <div className="kn-form-grid">
                <Field label="Key"><input value={d.key} disabled={!isNew} onChange={(e) => set({ key: e.target.value })} /></Field>
                <Field label="Title"><input value={d.title} onChange={(e) => set({ title: e.target.value })} /></Field>
                <Field label="Category"><select value={d.category} disabled={!isNew} onChange={(e) => set({ category: e.target.value })}>{CATS.slice(1).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              </div>
            </fieldset>
            <fieldset className="kn-fieldset">
              <legend>Scope & ưu tiên</legend>
              <div className="kn-form-grid">
                <Field label="Scope"><select value={d.scope_type} onChange={(e) => set({ scope_type: e.target.value, scope_ref: e.target.value === "GLOBAL" ? "" : d.scope_ref })}>{SCOPES.map((s) => <option key={s}>{s}</option>)}</select></Field>
                {d.scope_type !== "GLOBAL" && <Field label="Scope ref"><input placeholder={SCOPE_HINT[d.scope_type]} value={d.scope_ref} onChange={(e) => set({ scope_ref: e.target.value })} /></Field>}
                <Field label="Conflict key" hint="Item cùng conflict key cạnh tranh; scope hẹp hơn thắng."><input value={d.conflict_key} onChange={(e) => set({ conflict_key: e.target.value })} /></Field>
                <Field label="Priority"><input type="number" value={d.priority} onChange={(e) => set({ priority: Number(e.target.value) })} /></Field>
              </div>
              <div className="kn-toggles">
                <label className="kn-toggle"><input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} /><span><b>Enabled</b></span></label>
                <label className="kn-toggle"><input type="checkbox" checked={d.enforced} onChange={(e) => set({ enforced: e.target.checked })} /><span><b>Enforced</b> <span className="muted">(scope hẹp hơn không ghi đè được)</span></span></label>
              </div>
            </fieldset>
            <fieldset className="kn-fieldset">
              <legend>Nội dung</legend>
              <Field label={d.category === "agent_skill" ? "Skill instructions (Markdown)" : "Nội dung (Markdown)"}><textarea className="kn-textarea" rows={12} value={d.content} onChange={(e) => set({ content: e.target.value })} /></Field>
            </fieldset>
            <fieldset className="kn-fieldset">
              <legend>Nâng cao</legend>
              <div className="kn-form-grid two">
                <Field label="Applicability (JSON)" hint="step_types, step_keys, repos, projects, workflows, keywords"><textarea className="code" rows={6} value={d.applicability} onChange={(e) => set({ applicability: e.target.value })} /></Field>
                <Field label="Metadata (JSON)" hint="skills: required_tools, output_contract"><textarea className="code" rows={6} value={d.metadata} onChange={(e) => set({ metadata: e.target.value })} /></Field>
              </div>
            </fieldset>
            <div className="kn-savebar">
              {!isNew && <input placeholder="change note" value={d.change_note} onChange={(e) => set({ change_note: e.target.value })} aria-label="Change note" />}
              <button onClick={save}>{isNew ? <Plus size={15} /> : <SquarePen size={15} />}{isNew ? "Tạo" : "Lưu"}</button>
            </div>
          </div>
        )}

        {tab === "preview" && <div className="kn-content"><Markdown text={d.content || "_(trống)_"} /></div>}

        {tab === "versions" && !isNew && (
          <ol className="kn-timeline">
            {item.versions.map((v: any) => {
              const open = viewVersion === v.version;
              return (
                <li key={v.version} className={`kn-tl-item${v.version === item.current_version ? " is-current" : ""}`}>
                  <span className="kn-tl-dot" aria-hidden />
                  <div className="kn-tl-body">
                    <div className="kn-tl-row">
                      <b className="mono">v{v.version}</b>
                      {v.version === item.current_version && <span className="kn-tag chip-brand">hiện tại</span>}
                      <span className="muted small">{time(v.created_at)}{v.created_by ? ` · ${v.created_by}` : ""}</span>
                      <span className="grow" />
                      <button className={open ? "xs" : "xs ghost"} onClick={() => setViewVersion(open ? null : v.version)}>{open ? "Ẩn" : "Xem"}</button>
                    </div>
                    {v.change_note && <div className="small kn-tl-note">{v.change_note}</div>}
                    {open && <div className="kn-content kn-tl-content"><Markdown text={v.content} /></div>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {tab === "audit" && !isNew && (
          item.audit.length ? (
            <ol className="kn-timeline is-audit">
              {item.audit.map((a: any) => (
                <li key={a.id} className="kn-tl-item">
                  <span className="kn-tl-dot" aria-hidden />
                  <div className="kn-tl-body">
                    <div className="kn-tl-row"><b>{a.action}</b><span className="muted small">{time(a.created_at)}</span></div>
                    <code className="kn-audit-detail">{JSON.stringify(a.detail)}</code>
                  </div>
                </li>
              ))}
            </ol>
          ) : <div className="muted small">Chưa có audit.</div>
        )}

        {tab === "usage" && !isNew && usage && (
          <div className="kn-usage">
            <Section icon={Workflow} title="Được gán trong workflow">
              {usage.assigned.length ? (
                <ul className="kn-use-list">
                  {usage.assigned.map((a: any, i: number) => (
                    <li key={i}><a href={`#/workflows/${a.workflow}`} className="mono">{a.workflow}</a> <span className="kn-tag">{a.version === "draft" ? "draft" : `v${a.version}`}</span> <span className="muted small">{a.step ? <>bước <b>{a.step}</b></> : "mọi bước"}</span></li>
                  ))}
                </ul>
              ) : <div className="muted small">Không được gán trực tiếp (chỉ áp dụng theo scope).</div>}
            </Section>
            <Section icon={History} title="Thực sự được áp dụng trong các lần chạy">
              {usage.used.length ? (
                <ul className="kn-use-list">
                  {usage.used.map((u: any, i: number) => (
                    <li key={i}><a href={`#/runs/${u.run_id}/${u.step_key}`}>Run #{u.run_id} · {u.step_name}</a> <span className="muted small">{u.definition_key} · v{u.version} · {time(u.created_at)}</span></li>
                  ))}
                </ul>
              ) : <div className="muted small">Chưa bước nào nhận item này.</div>}
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

/** Cross-task memory provenance + the explicit human promotion step (only path to trusted agent conclusions). */
function MemoryProvenance({ itemKey, m, onDone }: { itemKey: string; m: any; onDone: () => void }) {
  const [by, setBy] = useState("");
  const tone = m.trust === "verified" || m.trust === "approved" ? "COMPLETED" : m.trust === "rejected" ? "FAILED" : "WAITING";
  const decide = async (d: "approve" | "reject") => {
    if (await act(() => api(`/api/knowledge/${itemKey}/${d}`, { by }), d === "approve" ? "Đã duyệt — được nạp vào context của task sau" : "Đã từ chối")) onDone();
  };
  return (
    <div className="card" style={{ borderLeft: `4px solid var(${tone === "COMPLETED" ? "--st-ok" : tone === "FAILED" ? "--st-err" : "--st-wait"})` }}>
      <div className="card-head"><h4>Task memory provenance</h4><Badge s={tone}>{m.trust}</Badge><span className="pill">confidence: {m.confidence}</span></div>
      <div className="kv small">
        <span>Run</span><span><a href={`#/runs/${m.run_id}`}>#{m.run_id}</a> {m.work_item ?? ""}</span>
        <span>Repository</span><span className="mono">{m.repo} @ {String(m.commit_sha ?? "").slice(0, 12)} (base {m.base_branch})</span>
        <span>Files</span><span className="mono">{(m.files ?? []).slice(0, 8).join(", ") || "—"}</span>
        <span>Sources</span><span>{(m.sources ?? []).join(", ")}</span>
        <span>Extracted</span><span>{time(m.extracted_at)}</span>
        {m.approved_by && <><span>Reviewed by</span><span>{m.approved_by} · {time(m.approved_at)}</span></>}
      </div>
      {m.trust === "unverified" && (
        <div className="row">
          <span className="small muted grow">Kết luận của agent chưa được kiểm chứng: không bao giờ nạp vào context cho tới khi được duyệt.</span>
          <input style={{ width: 180 }} placeholder="Tên người duyệt" value={by} onChange={(e) => setBy(e.target.value)} aria-label="Tên người duyệt" />
          <button className="sm ok" disabled={!by.trim()} onClick={() => decide("approve")}>Duyệt</button>
          <button className="sm ghost" disabled={!by.trim()} onClick={() => decide("reject")}>Từ chối</button>
        </div>
      )}
    </div>
  );
}
