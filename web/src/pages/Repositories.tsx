import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle, ArrowLeft, Boxes, CheckCircle2, Compass, Eye, FolderGit2, FolderKanban, GitPullRequest, Link2, Network, PenLine, Plus, Power, Save, ShieldCheck, Tag,
  UserRound, type LucideIcon,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import { act, Badge, Drawer, EmptyState, ErrorBox, Field, Loading, Markdown, navigate, PageHeader, SearchInput, Segmented, StatCard } from "../ui.tsx";
import "./Repositories.css";

const LISTS = ["projects", "services", "tags", "owners", "dependencies", "allowed_actions"] as const;
const LIST_LABEL: Record<(typeof LISTS)[number], string> = {
  projects: "Projects", services: "Services", tags: "Tags", owners: "Owners", dependencies: "Dependencies", allowed_actions: "Allowed actions",
};
const ACTION_ICON: Record<string, LucideIcon> = { read: Eye, write: PenLine, pull_request: GitPullRequest };

function Chips({ items, empty = "—", kind = "" }: { items?: string[]; empty?: ReactNode; kind?: string }) {
  if (!items?.length) return <span className="muted small">{empty}</span>;
  return <span className="repo-chips">{items.map((x) => <span key={x} className={`repo-chip ${kind}`}>{x}</span>)}</span>;
}
function Actions({ items }: { items?: string[] }) {
  if (!items?.length) return <span className="muted small">—</span>;
  return (
    <span className="repo-chips">
      {items.map((a) => {
        const I = ACTION_ICON[a] ?? ShieldCheck;
        return <span key={a} className={`repo-action is-${a}`}><I size={12} strokeWidth={2.2} />{a}</span>;
      })}
    </span>
  );
}
const repoDir = (r: any) => r.path || r.name;

export function RepositoriesPage({ name }: { name?: string }) {
  const { data, error, loading, reload } = useApi<any[]>("/api/repositories");
  const [form, setForm] = useState<any>(null);
  const [rank, setRank] = useState({ text: "", project: "" });
  const [ranked, setRanked] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "on" | "off">("all");
  useEffect(() => {
    if (!data) return;
    const r = name ? data.find((x) => x.name === name) : null;
    setForm(
      r
        ? { ...r, ...Object.fromEntries(LISTS.map((k) => [k, r[k].join(", ")])) }
        : { name: "", description: "", architecture: "", enabled: true, ...Object.fromEntries(LISTS.map((k) => [k, k === "allowed_actions" ? "read, write, pull_request" : ""])) },
    );
  }, [data, name]);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (data ?? []).filter(
      (r) =>
        (filter === "all" || (filter === "on" ? r.enabled : !r.enabled)) &&
        (!n || [r.name, r.description, r.path, r.remote_slug, ...r.projects, ...r.services, ...r.tags].some((x) => String(x ?? "").toLowerCase().includes(n))),
    );
  }, [data, q, filter]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const save = async () => {
    const body = { ...form, ...Object.fromEntries(LISTS.map((k) => [k, String(form[k]).split(",").map((x: string) => x.trim()).filter(Boolean)])) };
    if (await act(() => api(`/api/repositories/${encodeURIComponent(form.name)}`, body), "Đã lưu")) (reload(), setCreating(false), navigate(`/repositories/${form.name}`));
  };
  const startNew = () => {
    if (name) navigate("/repositories");
    setCreating(true);
  };

  const editor = form && (
    <RepoForm form={form} setForm={setForm} isNew={!name} onSave={save} />
  );

  // ------------------------------------------------------------------ detail
  if (name) {
    const r = data!.find((x) => x.name === name);
    return (
      <div className="repo">
        <PageHeader
          icon={FolderGit2}
          crumbs={[["Repositories", "#/repositories"], [name]]}
          title={<span className="mono">{name}</span>}
          subtitle={r?.description || undefined}
          actions={
            <>
              <button className="ghost" onClick={() => navigate("/repositories")}><ArrowLeft size={15} />Danh sách</button>
              <button className="ghost" onClick={startNew}><Plus size={15} />Thêm repo</button>
            </>
          }
        />
        {!r ? (
          <EmptyState icon={FolderGit2} title="Không tìm thấy repository" action={<button className="ghost sm" onClick={() => navigate("/repositories")}>Về danh sách</button>}>
            <span className="mono">{name}</span> chưa có trong registry.
          </EmptyState>
        ) : null}
        <div className="repo-detail">
          {r && (
            <div className="repo-detail-main">
              <div className="card repo-hero">
                <div className="repo-hero-row">
                  <span className="repo-hero-icon"><FolderGit2 size={22} /></span>
                  <div className="repo-hero-main">
                    <div className="repo-hero-name mono">{r.name}</div>
                    <div className="repo-hero-path"><span className="mono">{repoDir(r)}</span>{r.provider && <span className="repo-chip">{r.provider}</span>}</div>
                  </div>
                  {r.enabled ? <Badge s="COMPLETED">enabled</Badge> : <Badge s="CANCELED">off</Badge>}
                </div>
                <dl className="repo-kv">
                  <div><dt>Thư mục (reposRoot)</dt><dd className="mono">{repoDir(r)}{!r.path && <span className="muted small"> (= tên)</span>}</dd></div>
                  <div><dt>Provider</dt><dd>{r.provider || <span className="muted">—</span>}</dd></div>
                  <div><dt>Remote</dt><dd className="mono">{r.remote_slug || <span className="muted">—</span>}</dd></div>
                </dl>
              </div>

              <section className="card">
                <div className="card-head"><ShieldCheck size={16} color="var(--brand)" /><h4>Quyền & phạm vi</h4></div>
                <div className="repo-perm">
                  <div>
                    <div className="repo-label">Allowed actions</div>
                    <Actions items={r.allowed_actions} />
                  </div>
                  <div>
                    <div className="repo-label">Projects được phép</div>
                    <Chips items={r.projects} kind="is-project" empty="Chưa gán project" />
                  </div>
                </div>
              </section>

              <div className="repo-grid2">
                <section className="card">
                  <div className="card-head"><Boxes size={16} color="var(--brand)" /><h4>Services & tags</h4></div>
                  <div className="repo-label">Services</div>
                  <Chips items={r.services} />
                  <div className="repo-label">Tags</div>
                  <Chips items={r.tags} kind="is-tag" />
                </section>
                <section className="card">
                  <div className="card-head"><Network size={16} color="var(--brand)" /><h4>Dependencies & owners</h4></div>
                  <div className="repo-label">Dependencies</div>
                  {r.dependencies?.length ? (
                    <span className="repo-chips">
                      {r.dependencies.map((d: string) => {
                        const known = data!.some((x) => x.name === d);
                        return known ? <a key={d} className="repo-chip is-link" href={`#/repositories/${d}`}><Link2 size={11} />{d}</a> : <span key={d} className="repo-chip">{d}</span>;
                      })}
                    </span>
                  ) : <span className="muted small">—</span>}
                  <div className="repo-label">Owners</div>
                  {r.owners?.length ? <span className="repo-chips">{r.owners.map((o: string) => <span key={o} className="repo-chip"><UserRound size={11} />{o}</span>)}</span> : <span className="muted small">—</span>}
                </section>
              </div>

              <section className="card">
                <div className="card-head"><FolderKanban size={16} color="var(--brand)" /><h4>Kiến trúc / ghi chú</h4></div>
                {r.architecture ? <div className="repo-arch"><Markdown text={r.architecture} /></div> : <span className="muted small">Chưa có ghi chú kiến trúc.</span>}
              </section>
            </div>
          )}
          <aside className="repo-detail-side">{editor}</aside>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------ list
  const all = data!;
  const enabled = all.filter((r) => r.enabled).length;
  const projects = new Set(all.flatMap((r) => r.projects));
  const writable = all.filter((r) => r.enabled && r.allowed_actions.includes("write")).length;
  return (
    <div className="repo">
      <PageHeader
        icon={FolderGit2}
        title="Repositories"
        subtitle="Registry dùng cho repository discovery và tập repo được phép (theo project). Agent không bao giờ sửa repo ngoài tập được phép của run."
        actions={<button onClick={startNew}><Plus size={15} strokeWidth={2.2} />Thêm repo</button>}
      />
      <div className="repo-stats">
        <StatCard icon={FolderGit2} label="Repositories" value={all.length} tone="brand" />
        <StatCard icon={Power} label="Đang bật" value={enabled} hint={`${all.length - enabled} tắt`} tone="ok" />
        <StatCard icon={FolderKanban} label="Projects" value={projects.size} hint="đã gán repo" tone="run" />
        <StatCard icon={PenLine} label="Cho phép ghi" value={writable} hint="enabled + write" tone="wait" />
      </div>

      <div className="repo-layout">
        <div className="repo-main">
          <div className="toolbar">
            <SearchInput value={q} onChange={setQ} placeholder="Tìm repo, project, service…" width="min(100%, 320px)" />
            <Segmented label="Trạng thái" options={[["all", "Tất cả"], ["on", "Đang bật"], ["off", "Tắt"]]} value={filter} onChange={setFilter} />
            <span className="grow" />
            <span className="muted small">{shown.length}/{all.length} repo</span>
          </div>
          {!all.length ? (
            <EmptyState icon={FolderGit2} title="Chưa có repository" action={<button onClick={startNew}><Plus size={15} />Thêm repo</button>}>Thêm repo để agent có thể khám phá và làm việc trên đó.</EmptyState>
          ) : !shown.length ? (
            <div className="repo-none">Không có repo khớp bộ lọc.</div>
          ) : (
            <div className="repo-cards">
              {shown.map((r) => (
                <button key={r.name} type="button" className={`repo-card${r.enabled ? "" : " is-off"}`} onClick={() => navigate(`/repositories/${r.name}`)}>
                  <div className="repo-card-head">
                    <span className="repo-card-icon"><FolderGit2 size={17} /></span>
                    <div className="repo-card-title">
                      <b className="mono">{r.name}</b>
                      <span className="repo-card-path mono">{r.remote_slug || repoDir(r)}</span>
                    </div>
                    {!r.enabled && <Badge s="CANCELED">off</Badge>}
                  </div>
                  <div className="repo-card-desc">{r.description || <span className="muted">Chưa có mô tả.</span>}</div>
                  <div className="repo-card-rows">
                    <div><span className="repo-label-inline"><FolderKanban size={12} />Projects</span><Chips items={r.projects} kind="is-project" /></div>
                    <div><span className="repo-label-inline"><Tag size={12} />Services / tags</span><Chips items={[...r.services, ...r.tags]} /></div>
                    <div><span className="repo-label-inline"><ShieldCheck size={12} />Actions</span><Actions items={r.allowed_actions} /></div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <aside className="repo-side">
          <section className="card repo-rank">
            <div className="card-head"><Compass size={16} color="var(--brand)" /><h4>Thử gợi ý repo</h4></div>
            <div className="muted small" style={{ marginBottom: 8 }}>Mô tả yêu cầu để xem repo nào sẽ được chọn cho project.</div>
            <textarea rows={2} placeholder="mô tả yêu cầu" value={rank.text} onChange={(e) => setRank({ ...rank, text: e.target.value })} aria-label="Mô tả yêu cầu" />
            <div className="row">
              <input className="repo-rank-project" placeholder="project" value={rank.project} onChange={(e) => setRank({ ...rank, project: e.target.value })} aria-label="Project" />
              <button className="sm ghost" onClick={async () => setRanked(await act(() => api("/api/repositories/rank", rank)))}>Xếp hạng</button>
            </div>
            {ranked && (
              <div className="repo-ranked">
                {ranked.ambiguous && <div className="repo-ambig"><AlertTriangle size={14} />Không rõ ràng — workflow sẽ hỏi bạn chọn</div>}
                {!ranked.ranked.length && <div className="muted small">Không có repo nào phù hợp.</div>}
                {(() => {
                  const max = Math.max(...ranked.ranked.map((x: any) => Number(x.score) || 0), 1);
                  return ranked.ranked.map((x: any, i: number) => (
                    <div key={x.repo} className="repo-ranked-row">
                      <div className="repo-ranked-top">
                        {i === 0 && !ranked.ambiguous ? <CheckCircle2 size={14} color="var(--st-ok)" /> : <span className="repo-rank-n">{i + 1}</span>}
                        <b className="mono">{x.repo}</b>
                        <span className="grow" />
                        <span className="mono small">{x.score}</span>
                      </div>
                      <div className="repo-ranked-bar"><span style={{ width: `${Math.max(0, (Number(x.score) || 0) / max) * 100}%` }} /></div>
                      {x.reasons?.length > 0 && <div className="muted small">{x.reasons.join(" · ")}</div>}
                    </div>
                  ));
                })()}
              </div>
            )}
          </section>
        </aside>
      </div>
      {creating && <NewRepoDrawer form={form} setForm={setForm} onSave={save} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewRepoDrawer({ form, setForm, onSave, onClose }: { form: any; setForm: (f: any) => void; onSave: () => void; onClose: () => void }) {
  return (
    <Drawer title="Thêm repo" onClose={onClose} width={560}>
      {form ? <RepoForm form={form} setForm={setForm} isNew onSave={onSave} bare /> : <Loading />}
    </Drawer>
  );
}

function RepoForm({ form, setForm, isNew, onSave, bare }: { form: any; setForm: (f: any) => void; isNew: boolean; onSave: () => void; bare?: boolean }) {
  const body = (
    <>
      <Field label="Tên (thư mục trong reposRoot)"><input value={form.name} disabled={!isNew} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
      <Field label="Mô tả (dùng để gợi ý repo)"><textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      <div className="repo-form-grid">
        {LISTS.map((k) => (
          <Field key={k} label={LIST_LABEL[k]} hint="phân cách bằng dấu phẩy">
            <input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
      <Field label="Kiến trúc / ghi chú"><textarea rows={4} value={form.architecture} onChange={(e) => setForm({ ...form, architecture: e.target.value })} /></Field>
      <div className="repo-form-foot">
        <label className="repo-toggle"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
        <span className="grow" />
        <button disabled={!form.name} onClick={onSave}><Save size={15} />Lưu</button>
      </div>
    </>
  );
  if (bare) return <div className="repo-form">{body}</div>;
  return (
    <section className="card repo-form">
      <div className="card-head"><PenLine size={16} color="var(--brand)" /><h4>{isNew ? "Thêm repo" : `Sửa ${form.name}`}</h4></div>
      {body}
    </section>
  );
}
