import { useMemo, useState } from "react";
import {
  BadgeCheck, Bot, Clock, Code2, Copy, FilePlus2, FileText, GitBranch, GitPullRequest, Layers, MessageCircleQuestion, Play, Plug, Plus, Sparkles,
  Terminal, Workflow, type LucideIcon,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import { act, ago, Badge, Drawer, EmptyState, ErrorBox, Field, Loading, navigate, PageHeader, SearchInput, Segmented, Skeleton } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import "./Workflows.css";

/** Step type → lucide icon + short label (mirrors the editor palette). */
export const WF_TYPE_ICON: Record<string, LucideIcon> = {
  agent: Bot,
  coding_agent: Code2,
  human_input: MessageCircleQuestion,
  human_approval: BadgeCheck,
  integration: Plug,
  command: Terminal,
  condition: GitBranch,
  git_pull_request: GitPullRequest,
  task_result_report: FileText,
};
const SHORT_LABEL: Record<string, string> = {
  agent: "Agent", coding_agent: "Coding", human_input: "Input", human_approval: "Approval", integration: "Integration",
  command: "Command", condition: "Condition", git_pull_request: "PR", task_result_report: "Report",
};
export const WF_TYPE_TONE: Record<string, string> = {
  agent: "ai", coding_agent: "ai", human_input: "human", human_approval: "human", integration: "logic", command: "logic", condition: "logic",
  git_pull_request: "ship", task_result_report: "ship",
};

type Filter = "all" | "template" | "published" | "draft";

export function WorkflowsPage() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi<any[]>("/api/workflows");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // null = drawer closed; "" = blank workflow; otherwise the key of the workflow being duplicated
  const [creating, setCreating] = useState<string | null>(null);

  const create = async (from?: any) => {
    const spec = from
      ? { ...(from.draft_spec ?? from.versions[0].spec), name: name || `${from.name} (copy)` }
      : { name: name || key, description: "", steps: [{ key: "analyze", type: "agent", name: "Analyze", config: { instructions: "", output_contract: "{ summary }" } }] };
    const r = await act(() => api("/api/workflows", { key, spec, publish: false }));
    if (r) navigate(`/workflows/${key}`);
  };
  const duplicate = async (src: string) => {
    if (!key) return act(async () => { throw new Error(t("wfs.needKey")); });
    create(await api(`/api/workflows/${src}`));
  };

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter((w) => {
      if (filter === "template" && !w.is_template) return false;
      if (filter === "published" && !w.latest_version) return false;
      if (filter === "draft" && !w.has_draft) return false;
      return !needle || [w.name, w.key, w.description].some((x) => String(x ?? "").toLowerCase().includes(needle));
    });
  }, [data, q, filter]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const all = data ?? [];
  const counts = {
    all: all.length,
    template: all.filter((w) => w.is_template).length,
    published: all.filter((w) => w.latest_version).length,
    draft: all.filter((w) => w.has_draft).length,
  };
  const openCreate = (src = "") => {
    setName("");
    setCreating(src);
  };
  const source = creating ? all.find((w) => w.key === creating) : null;

  return (
    <div className="wfs">
      <PageHeader
        icon={Workflow}
        title={t("wfs.title")}
        subtitle={t("wfs.subtitle")}
        actions={<button onClick={() => openCreate()}><Plus size={16} strokeWidth={2.2} /> {t("wfs.new")}</button>}
      />

      <div className="toolbar wfs-toolbar">
        <SearchInput value={q} onChange={setQ} placeholder={t("wfs.search")} width="min(340px, 100%)" />
        <Segmented<Filter>
          label={t("wfs.filter")}
          value={filter}
          onChange={setFilter}
          options={[
            ["all", <>{t("common.all")} <span className="wfs-n">{counts.all}</span></>],
            ["template", <>{t("wfs.template")} <span className="wfs-n">{counts.template}</span></>],
            ["published", <>{t("wfs.published")} <span className="wfs-n">{counts.published}</span></>],
            ["draft", <>{t("wfs.draft")} <span className="wfs-n">{counts.draft}</span></>],
          ]}
        />
      </div>

      {all.length === 0 ? (
        <div className="card wfs-empty">
          <EmptyState icon={Workflow} title={t("wfs.emptyTitle")} action={<button onClick={() => openCreate()}><Plus size={16} /> {t("wfs.createFirst")}</button>}>
            {t("wfs.emptyBody")}
          </EmptyState>
        </div>
      ) : list.length === 0 ? (
        <div className="card wfs-empty">
          <EmptyState icon={Layers} title={t("wfs.noMatch")} action={<button className="ghost sm" onClick={() => (setQ(""), setFilter("all"))}>{t("wfs.clearFilter")}</button>} />
        </div>
      ) : (
        <div className="wfs-grid">
          {list.map((w) => <WorkflowCard key={w.key} w={w} onDuplicate={() => openCreate(w.key)} />)}
          <button className="wfs-new" onClick={() => openCreate()}>
            <span className="wfs-new-icon"><FilePlus2 size={22} strokeWidth={1.8} /></span>
            <b>{t("wfs.blank")}</b>
            <span className="muted small">{t("wfs.blankHint")}</span>
          </button>
        </div>
      )}

      {creating !== null && (
        <Drawer title={creating ? t("wfs.duplicate") : t("wfs.new")} onClose={() => setCreating(null)}>
          <form
            className="wfs-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (creating) duplicate(creating);
              else if (key) create();
            }}
          >
            {source && (
              <div className="wfs-src">
                <span className="wfs-src-icon"><Copy size={16} /></span>
                <div>
                  <div className="muted small">{t("wfs.copiedFrom")}</div>
                  <b>{source.name}</b> <span className="mono muted">{source.key}</span>
                </div>
              </div>
            )}
            <Field label="Key" hint={t("wfs.keyHint")}>
              <input autoFocus placeholder="key (lowercase-dashes)" value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} />
            </Field>
            <Field label={t("wfs.name")}>
              <input placeholder={source ? `${source.name} (copy)` : t("wfs.name")} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            {!creating && <p className="muted small">{t("wfs.blankHelp")}</p>}
            <div className="row">
              <button type="submit" disabled={!key}>{creating ? <><Copy size={15} /> {t("wfs.dupOpen")}</> : <><Plus size={15} /> {t("wfs.createBlank")}</>}</button>
              <button type="button" className="ghost" onClick={() => setCreating(null)}>{t("common.cancel")}</button>
            </div>
          </form>
        </Drawer>
      )}
    </div>
  );
}

function WorkflowCard({ w, onDuplicate }: { w: any; onDuplicate: () => void }) {
  const { t } = useI18n();
  // The list endpoint carries no step data; read the definition to show its shape (read-only GET).
  const { data: def } = useApi<any>(`/api/workflows/${w.key}`);
  const spec = def ? (def.draft_spec ?? def.versions?.[0]?.spec) : null;
  const steps: any[] = spec?.steps ?? [];
  const types = [...new Set(steps.map((s) => s.type as string))];
  const open = () => navigate(`/workflows/${w.key}`);
  return (
    <article className="wfs-card" role="link" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()} aria-label={t("wfs.open", { name: w.name })}>
      <div className="wfs-card-top">
        <span className="wfs-card-icon"><Workflow size={19} strokeWidth={1.9} /></span>
        <div className="wfs-card-title">
          <b>{w.name}</b>
          <span className="mono muted">{w.key}</span>
        </div>
        <button className="ghost xs" onClick={(e) => (e.stopPropagation(), onDuplicate())} aria-label={t("wfs.dupName", { name: w.name })}><Copy size={13} /> {t("wfs.duplicate")}</button>
      </div>

      <div className="wfs-badges">
        {w.is_template && <span className="pill chip-brand wfs-tpl"><Sparkles size={12} /> template</span>}
        {w.latest_version ? <Badge s="COMPLETED">v{w.latest_version} {t("wfs.published").toLowerCase()}</Badge> : <Badge s="PENDING">{t("wfs.unpublished")}</Badge>}
        {w.has_draft && <Badge s="WAITING">draft</Badge>}
      </div>

      <p className="wfs-desc">{w.description || <span className="muted">{t("wfs.noDesc")}</span>}</p>

      <div className="wfs-types">
        {!def ? (
          <><Skeleton h={22} w={74} r={999} /><Skeleton h={22} w={60} r={999} /></>
        ) : types.length ? (
          types.map((t) => {
            const I = WF_TYPE_ICON[t] ?? Layers;
            return <span key={t} className={`wfs-type tone-${WF_TYPE_TONE[t] ?? "logic"}`} title={t}><I size={12} strokeWidth={2} /> {SHORT_LABEL[t] ?? t}</span>;
          })
        ) : (
          <span className="muted small">{t("wfs.noSteps")}</span>
        )}
      </div>

      <div className="wfs-meta">
        <span title={t("wfs.stepsTip")}><Layers size={13} /> {def ? t("wfs.stepCount", { n: steps.length }) : "—"}</span>
        <span title={t("wfs.runsTip")}><Play size={13} /> {w.run_count != null ? t("wfs.runCount", { n: w.run_count }) : "—"}</span>
        <span className="grow" />
        <span title={w.updated_at}><Clock size={13} /> {w.updated_at ? t("common.ago", { when: ago(w.updated_at) }) : "—"}</span>
      </div>
    </article>
  );
}
