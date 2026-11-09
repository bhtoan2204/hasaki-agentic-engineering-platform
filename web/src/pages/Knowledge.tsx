import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  BookMarked,
  BookOpen,
  Building2,
  Code2,
  Eye,
  FileText,
  FolderGit2,
  FolderKanban,
  Globe,
  History,
  Landmark,
  Layers,
  Lightbulb,
  Lock,
  Plus,
  Power,
  ScanSearch,
  ScrollText,
  Shield,
  Sparkles,
  SquarePen,
  Workflow,
  Footprints,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import {
  act,
  Badge,
  Drawer,
  EmptyState,
  ErrorBox,
  Field,
  JsonBlock,
  Markdown,
  navigate,
  PageHeader,
  SearchInput,
  SkeletonRows,
  Tabs,
  time,
} from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import { ProposalsPanel, ProposalStatus } from "./KnowledgeProposals.tsx";
import "./Knowledge.css";

const CATS = [
  "",
  "business_rule",
  "architecture_guideline",
  "coding_standard",
  "repository_convention",
  "domain_knowledge",
  "security_policy",
  "agent_skill",
  "task_memory",
] as const;
const CAT_ICON: Record<string, LucideIcon> = {
  "": Layers,
  business_rule: Landmark,
  architecture_guideline: Building2,
  coding_standard: Code2,
  repository_convention: FolderGit2,
  domain_knowledge: BookMarked,
  security_policy: Shield,
  agent_skill: Sparkles,
  task_memory: History,
};
const catKey = (c: string) => (c ? `kn.cat.${c}` : "kn.cat.all");
const SCOPES = [
  "GLOBAL",
  "ORGANIZATION",
  "PROJECT",
  "REPOSITORY",
  "WORKFLOW",
  "STEP",
];
const SCOPE_STYLE: Record<string, { color: string; icon: LucideIcon }> = {
  GLOBAL: { color: "var(--brand)", icon: Globe },
  ORGANIZATION: { color: "var(--st-run)", icon: Building2 },
  PROJECT: { color: "var(--st-wait)", icon: FolderKanban },
  REPOSITORY: { color: "var(--st-ok)", icon: FolderGit2 },
  WORKFLOW: { color: "var(--rose-ink)", icon: Workflow },
  STEP: { color: "var(--st-idle)", icon: Footprints },
};

function ScopeBadge({ type, scopeRef }: { type: string; scopeRef?: string }) {
  const { t } = useI18n();
  const s = SCOPE_STYLE[type] ?? { color: "var(--muted)", icon: Globe };
  const I = s.icon;
  return (
    <span
      className="kn-scope"
      style={{ color: s.color }}
      title={`${t("kn.scopeTitle", { type })}${scopeRef ? `: ${scopeRef}` : ""}`}
    >
      <I size={12} strokeWidth={2.2} />
      {type}
      {scopeRef ? <span className="kn-scope-ref">:{scopeRef}</span> : null}
    </span>
  );
}
/** Load mode follows the context planner: metadata.load === "on_demand" → index only, anything else → inline. */
const loadMode = (metadata: any) =>
  metadata?.load === "on_demand" ? "on_demand" : "inline";
function LoadChip({ metadata }: { metadata: any }) {
  const { t } = useI18n();
  const m = loadMode(metadata);
  const onDemand = m === "on_demand";
  return (
    <span
      className={`kn-load is-${m}`}
      title={onDemand ? t("kn.onDemandTip") : t("kn.inlineTip")}
    >
      {onDemand ? <Eye size={11} /> : <Zap size={11} />}
      {onDemand ? t("kn.onDemand") : t("kn.inline")}
    </span>
  );
}

type Draft = {
  key: string;
  title: string;
  category: string;
  scope_type: string;
  scope_ref: string;
  conflict_key: string;
  priority: number;
  enforced: boolean;
  enabled: boolean;
  content: string;
  applicability: string;
  metadata: string;
  change_note: string;
};
const emptyDraft = (category = "business_rule"): Draft => ({
  key: "",
  title: "",
  category,
  scope_type: "GLOBAL",
  scope_ref: "",
  conflict_key: "",
  priority: 0,
  enforced: false,
  enabled: true,
  content: "",
  applicability: "{}",
  metadata:
    category === "agent_skill"
      ? '{\n  "required_tools": ["Read", "Grep"],\n  "output_contract": ""\n}'
      : "{}",
  change_note: "",
});

export function KnowledgePage({
  itemKey,
  subKey,
}: {
  itemKey?: string;
  subKey?: string;
}) {
  const { t } = useI18n();
  const pendingProposals = useApi<any[]>(
    "/api/knowledge-proposals?status=pending",
  );
  const [cat, setCat] = useState("");
  const { data, error, loading, reload } = useApi<any[]>(
    `/api/knowledge${cat ? `?category=${cat}` : ""}`,
    [cat],
  );
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
    pendingProposals.reload();
  };
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter(
      (k) =>
        (!scope || k.scope_type === scope) &&
        (!needle ||
          [k.title, k.key, k.scope_ref, k.metadata?.description].some((x) =>
            String(x ?? "")
              .toLowerCase()
              .includes(needle),
          )),
    );
  }, [data, q, scope]);

  return (
    <div className="kn">
      <PageHeader
        icon={BookOpen}
        title={t("kn.title")}
        subtitle={t("kn.subtitle")}
        actions={
          <>
            <button
              className={itemKey === "~proposals" ? "" : "ghost"}
              onClick={() => navigate("/knowledge/~proposals")}
              title={t("kp.subtitle")}
            >
              <Lightbulb size={15} />
              {t("kp.button")}
              {pendingProposals.data?.length ? (
                <span className="kn-cat-count kp-count">
                  {pendingProposals.data.length}
                </span>
              ) : null}
            </button>
            <RepoImport onDone={reloadAll} />
            <button onClick={() => navigate("/knowledge/~new")}>
              <Plus size={15} strokeWidth={2.2} />
              {t("kn.newItem")}
            </button>
          </>
        }
      />
      <nav className="kn-cats" aria-label={t("kn.cats")}>
        {CATS.map((k) => {
          const I = CAT_ICON[k] ?? Layers;
          return (
            <button
              key={k}
              type="button"
              className={`kn-cat${k === cat ? " on" : ""}`}
              aria-pressed={k === cat}
              onClick={() => setCat(k)}
            >
              <I size={15} strokeWidth={2} />
              <span>{t(catKey(k))}</span>
              {counts && <span className="kn-cat-count">{counts[k] ?? 0}</span>}
            </button>
          );
        })}
      </nav>
      <div className={`kn-layout${itemKey ? " has-detail" : ""}`}>
        <aside className="kn-list">
          <div className="kn-filter">
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder={t("kn.searchPh")}
              width="100%"
            />
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              aria-label={t("kn.scopeFilter")}
            >
              <option value="">{t("kn.allScopes")}</option>
              {SCOPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          {loading && !data ? (
            <SkeletonRows rows={6} />
          ) : error ? (
            <ErrorBox error={error} onRetry={reload} />
          ) : !data?.length ? (
            <EmptyState
              icon={BookOpen}
              title={t("kn.emptyTitle")}
              action={
                <button
                  className="sm"
                  onClick={() => navigate("/knowledge/~new")}
                >
                  <Plus size={14} />
                  {t("kn.create")}
                </button>
              }
            >
              {t("kn.emptyBody")}
            </EmptyState>
          ) : !items.length ? (
            <div className="kn-none">{t("kn.noMatch")}</div>
          ) : (
            <ul className="kn-items">
              {items.map((k) => {
                const I = CAT_ICON[k.category] ?? FileText;
                return (
                  <li key={k.key}>
                    <button
                      type="button"
                      className={`kn-item${k.key === itemKey ? " on" : ""}${k.enabled ? "" : " is-off"}`}
                      onClick={() => navigate(`/knowledge/${k.key}`)}
                    >
                      <span className="kn-item-icon">
                        <I size={16} strokeWidth={2} />
                      </span>
                      <span className="kn-item-body">
                        <span className="kn-item-title">
                          <b>{k.title}</b>
                          <Badge s={k.owner_id ? "RUNNING" : "COMPLETED"}>
                            {k.owner_id ? t("auth.my") : t("auth.shared")}
                          </Badge>
                          {k.enforced && (
                            <Badge s="FAILED">{t("kn.enforced")}</Badge>
                          )}
                          {!k.enabled && (
                            <Badge s="CANCELED">{t("kn.enabledNo")}</Badge>
                          )}
                        </span>
                        <span className="kn-item-key mono">{k.key}</span>
                        <span className="kn-item-meta">
                          <ScopeBadge
                            type={k.scope_type}
                            scopeRef={k.scope_ref}
                          />
                          <span className="kn-tag">
                            {t(catKey(k.category))}
                          </span>
                          <span className="kn-tag mono">
                            v{k.current_version}
                          </span>
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
          {itemKey === "~proposals" ? (
            <ProposalsPanel id={subKey} onChanged={reloadAll} />
          ) : itemKey ? (
            <KnowledgeEditor
              key={itemKey}
              itemKey={itemKey}
              defaultCategory={cat || "business_rule"}
              onSaved={reloadAll}
            />
          ) : (
            <div className="card kn-placeholder">
              <EmptyState
                icon={BookOpen}
                title={t("kn.pickTitle")}
                action={
                  <button
                    className="sm ghost"
                    onClick={() => navigate("/knowledge/~new")}
                  >
                    <Plus size={14} />
                    {t("kn.createNew")}
                  </button>
                }
              >
                {t("kn.pickBody")}
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
  const { t } = useI18n();
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dry: boolean) => {
    setBusy(true);
    const r = await act(
      () => api<any>("/api/knowledge/import-repos", { dry_run: dry }),
      dry ? undefined : t("kn.imported"),
    );
    setBusy(false);
    if (!r) return;
    if (dry) setPreview(r);
    else (setPreview(null), onDone());
  };
  const changed = preview
    ? preview.candidates.filter((c: any) => c.action !== "unchanged")
    : [];
  return (
    <>
      <button className="ghost" disabled={busy} onClick={() => run(true)}>
        {busy ? <span className="spinner" /> : <ScanSearch size={15} />}
        {busy ? t("kn.scanning") : t("kn.scan")}
      </button>
      {preview && (
        <Drawer
          title={t("kn.importTitle")}
          onClose={() => setPreview(null)}
          width={560}
        >
          <div className="kn-import-sum">
            <div>
              <b>{preview.created}</b>
              <span>{t("kn.createdN")}</span>
            </div>
            <div>
              <b>{preview.updated}</b>
              <span>{t("kn.updatedN")}</span>
            </div>
            <div>
              <b>{preview.unchanged}</b>
              <span>{t("kn.unchangedN")}</span>
            </div>
          </div>
          <div className="row tight" style={{ marginBottom: 12 }}>
            <button
              disabled={busy || !(preview.created + preview.updated)}
              onClick={() => run(false)}
            >
              {t("kn.import")}
            </button>
            <button className="ghost" onClick={() => setPreview(null)}>
              {t("common.close")}
            </button>
          </div>
          {changed.length > 0 && (
            <ul className="kn-import-list">
              {changed.map((c: any) => (
                <li key={c.key}>
                  <Badge s={c.action === "create" ? "READY" : "WAITING"}>
                    {c.action}
                  </Badge>
                  <div className="kn-import-body">
                    <span className="mono">{c.key}</span>
                    <span className="muted small">
                      {c.category} · {c.repos.join(", ")}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {preview.skipped.length > 0 && (
            <>
              <h3>{t("kn.skipped")}</h3>
              {preview.skipped.map((s: any) => (
                <div key={s.path} className="small err kn-skip">
                  {t("kn.skip", { path: s.path, reason: s.reason })}
                </div>
              ))}
            </>
          )}
          {!changed.length && !preview.skipped.length && (
            <div className="muted small">{t("kn.noChange")}</div>
          )}
        </Drawer>
      )}
    </>
  );
}

function Section({
  icon: I,
  title,
  children,
  aside,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="kn-section">
      <div className="kn-section-head">
        <I size={15} strokeWidth={2} />
        <h4>{title}</h4>
        {aside}
      </div>
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
            {Array.isArray(x) &&
            x.every((y) => typeof y !== "object" || y === null) ? (
              x.length ? (
                x.map((y, i) => (
                  <span key={i} className="pill">
                    {String(y)}
                  </span>
                ))
              ) : (
                <span className="muted">[]</span>
              )
            ) : x !== null && typeof x === "object" ? (
              <JsonBlock value={x} />
            ) : (
              <span className={typeof x === "string" ? "" : "mono"}>
                {x === null ? "null" : String(x)}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function KnowledgeEditor({
  itemKey,
  defaultCategory,
  onSaved,
}: {
  itemKey: string;
  defaultCategory: string;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const isNew = itemKey === "~new";
  const {
    data: item,
    error,
    reload,
  } = useApi<any>(isNew ? null : `/api/knowledge/${itemKey}`);
  const { data: usage } = useApi<any>(
    isNew ? null : `/api/knowledge/${itemKey}/usage`,
  );
  const [d, setD] = useState<Draft>(emptyDraft(defaultCategory));
  const [tab, setTab] = useState<
    "overview" | "edit" | "preview" | "versions" | "audit" | "usage"
  >(isNew ? "edit" : "overview");
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  useEffect(() => {
    if (!item) return;
    const v = item.versions[0];
    setD({
      key: item.key,
      title: item.title,
      category: item.category,
      scope_type: item.scope_type,
      scope_ref: item.scope_ref,
      conflict_key: item.conflict_key ?? "",
      priority: item.priority,
      enforced: item.enforced,
      enabled: item.enabled,
      content: v?.content ?? "",
      applicability: JSON.stringify(v?.applicability ?? {}, null, 2),
      metadata: JSON.stringify(v?.metadata ?? {}, null, 2),
      change_note: "",
    });
  }, [item]);
  const back = (
    <button className="quiet sm kn-back" onClick={() => navigate("/knowledge")}>
      <ArrowLeft size={15} />
      {t("kn.back")}
    </button>
  );
  if (error)
    return (
      <div>
        {back}
        <ErrorBox error={error} />
      </div>
    );
  if (!isNew && !item)
    return (
      <div className="card">
        <SkeletonRows rows={5} />
      </div>
    );
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const save = async () => {
    let applicability, metadata;
    try {
      applicability = JSON.parse(d.applicability || "{}");
      metadata = JSON.parse(d.metadata || "{}");
    } catch {
      return act(async () => {
        throw new Error(t("kn.badJson"));
      });
    }
    const body = {
      ...d,
      conflict_key: d.conflict_key || null,
      applicability,
      metadata,
    };
    const r = await act(
      () =>
        api<any>(isNew ? "/api/knowledge" : `/api/knowledge/${itemKey}`, body),
      isNew ? t("kn.created") : t("kn.saved"),
    );
    if (r) {
      onSaved();
      if (isNew) navigate(`/knowledge/${r.key}`);
      else reload();
    }
  };
  const cur = isNew ? null : item.versions[0];
  const CatIcon = CAT_ICON[isNew ? d.category : item.category] ?? FileText;
  const tabs: Array<[typeof tab, ReactNode]> = isNew
    ? [
        [
          "edit",
          <>
            <SquarePen size={14} />
            {t("kn.compose")}
          </>,
        ],
        [
          "preview",
          <>
            <Eye size={14} />
            {t("common.preview")}
          </>,
        ],
      ]
    : [
        [
          "overview",
          <>
            <FileText size={14} />
            {t("kn.overview")}
          </>,
        ],
        [
          "edit",
          <>
            <SquarePen size={14} />
            {t("common.edit")}
          </>,
        ],
        [
          "preview",
          <>
            <Eye size={14} />
            {t("common.preview")}
          </>,
        ],
        [
          "versions",
          <>
            <History size={14} />
            {t("kn.versions")}{" "}
            <span className="kn-tab-count">{item.versions.length}</span>
          </>,
        ],
        [
          "audit",
          <>
            <ScrollText size={14} />
            {t("kn.audit")}{" "}
            <span className="kn-tab-count">{item.audit.length}</span>
          </>,
        ],
        [
          "usage",
          <>
            <Workflow size={14} />
            {t("kn.used")}{" "}
            <span className="kn-tab-count">{usage?.used.length ?? 0}</span>
          </>,
        ],
      ];

  return (
    <div className="kn-editor">
      {back}
      <div className="card kn-head">
        <span className="kn-head-icon">
          <CatIcon size={20} strokeWidth={2} />
        </span>
        <div className="kn-head-main">
          <h2 className="kn-head-title">
            {isNew ? t("kn.newTitle") : d.title || item.title}
          </h2>
          {isNew ? (
            <div className="muted small">{t("kn.newHint")}</div>
          ) : (
            <>
              <div className="kn-head-key mono">{item.key}</div>
              <div className="kn-item-meta">
                <ScopeBadge type={item.scope_type} scopeRef={item.scope_ref} />
                <span className="kn-tag">{t(catKey(item.category))}</span>
                <span className="kn-tag mono">v{item.current_version}</span>
                <LoadChip metadata={cur?.metadata} />
                {item.enforced && <Badge s="FAILED">{t("kn.enforced")}</Badge>}
                {item.enabled ? (
                  <Badge s="COMPLETED">{t("kn.enabled")}</Badge>
                ) : (
                  <Badge s="CANCELED">{t("kn.enabledNo")}</Badge>
                )}
              </div>
            </>
          )}
        </div>
        {!isNew && (
          <div className="kn-head-time muted small">
            {t("kn.updatedAt", { time: time(item.updated_at) })}
          </div>
        )}
      </div>

      <div className="card kn-body">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />

        {tab === "overview" && !isNew && cur?.metadata?.memory && (
          <MemoryProvenance
            itemKey={item.key}
            m={cur.metadata.memory}
            onDone={reload}
          />
        )}
        {tab === "overview" && !isNew && <Evolution item={item} />}
        {tab === "overview" && !isNew && (
          <div className="kn-overview">
            <Section
              icon={FileText}
              title={
                item.category === "agent_skill"
                  ? t("kn.skillInstructions")
                  : t("kn.content")
              }
              aside={
                <span className="muted small">
                  v{cur?.version ?? item.current_version}
                </span>
              }
            >
              <div className="kn-content">
                {cur?.content ? (
                  <Markdown text={cur.content} />
                ) : (
                  <span className="muted">{t("kn.emptyContent")}</span>
                )}
              </div>
            </Section>
            <div className="kn-overview-grid">
              <Section icon={Layers} title={t("kn.scopeSection")}>
                <dl className="kn-kv">
                  <div className="kn-kv-row">
                    <dt>{t("kn.scope")}</dt>
                    <dd>
                      <ScopeBadge
                        type={item.scope_type}
                        scopeRef={item.scope_ref}
                      />
                    </dd>
                  </div>
                  <div className="kn-kv-row">
                    <dt>{t("kn.conflictKey")}</dt>
                    <dd>
                      {item.conflict_key ? (
                        <span className="mono">{item.conflict_key}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </dd>
                  </div>
                  <div className="kn-kv-row">
                    <dt>{t("kn.priority")}</dt>
                    <dd className="mono">{item.priority}</dd>
                  </div>
                  <div className="kn-kv-row">
                    <dt>{t("kn.enforced")}</dt>
                    <dd>
                      {item.enforced ? (
                        <span className="kn-flag">
                          <Lock size={12} />
                          {t("kn.enforcedYes")}
                        </span>
                      ) : (
                        <span className="muted">{t("kn.enforcedNo")}</span>
                      )}
                    </dd>
                  </div>
                  <div className="kn-kv-row">
                    <dt>{t("kn.enabled")}</dt>
                    <dd>
                      {item.enabled ? (
                        <span className="okc">{t("kn.enabledYes")}</span>
                      ) : (
                        <span className="kn-flag">
                          <Power size={12} />
                          {t("kn.enabledNo")}
                        </span>
                      )}
                    </dd>
                  </div>
                </dl>
                <div className="kn-sub-head">{t("kn.applicability")}</div>
                <KeyValues
                  value={cur?.applicability}
                  empty={t("kn.applicabilityEmpty")}
                />
              </Section>
              <Section icon={BookMarked} title={t("kn.metadata")}>
                <KeyValues
                  value={cur?.metadata}
                  empty={t("kn.metadataEmpty")}
                />
              </Section>
            </div>
          </div>
        )}

        {tab === "edit" && (
          <div className="kn-form">
            <fieldset className="kn-fieldset">
              <legend>{t("kn.identity")}</legend>
              <div className="kn-form-grid">
                <Field label={t("kn.key")}>
                  <input
                    value={d.key}
                    disabled={!isNew}
                    onChange={(e) => set({ key: e.target.value })}
                  />
                </Field>
                <Field label={t("kn.titleField")}>
                  <input
                    value={d.title}
                    onChange={(e) => set({ title: e.target.value })}
                  />
                </Field>
                <Field label={t("kn.category")}>
                  <select
                    value={d.category}
                    disabled={!isNew}
                    onChange={(e) => set({ category: e.target.value })}
                  >
                    {CATS.slice(1).map((k) => (
                      <option key={k} value={k}>
                        {t(catKey(k))}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </fieldset>
            <fieldset className="kn-fieldset">
              <legend>{t("kn.scopePriority")}</legend>
              <div className="kn-form-grid">
                <Field label={t("kn.scope")}>
                  <select
                    value={d.scope_type}
                    onChange={(e) =>
                      set({
                        scope_type: e.target.value,
                        scope_ref:
                          e.target.value === "GLOBAL" ? "" : d.scope_ref,
                      })
                    }
                  >
                    {SCOPES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </Field>
                {d.scope_type !== "GLOBAL" && (
                  <Field label={t("kn.scopeRef")}>
                    <input
                      placeholder={t(`kn.hint.${d.scope_type}`)}
                      value={d.scope_ref}
                      onChange={(e) => set({ scope_ref: e.target.value })}
                    />
                  </Field>
                )}
                <Field label={t("kn.conflictKey")} hint={t("kn.conflictHint")}>
                  <input
                    value={d.conflict_key}
                    onChange={(e) => set({ conflict_key: e.target.value })}
                  />
                </Field>
                <Field label={t("kn.priority")}>
                  <input
                    type="number"
                    value={d.priority}
                    onChange={(e) => set({ priority: Number(e.target.value) })}
                  />
                </Field>
              </div>
              <div className="kn-toggles">
                <label className="kn-toggle">
                  <input
                    type="checkbox"
                    checked={d.enabled}
                    onChange={(e) => set({ enabled: e.target.checked })}
                  />
                  <span>
                    <b>{t("kn.enabled")}</b>
                  </span>
                </label>
                <label className="kn-toggle">
                  <input
                    type="checkbox"
                    checked={d.enforced}
                    onChange={(e) => set({ enforced: e.target.checked })}
                  />
                  <span>
                    <b>{t("kn.enforced")}</b>{" "}
                    <span className="muted">({t("kn.enforcedYes")})</span>
                  </span>
                </label>
              </div>
            </fieldset>
            <fieldset className="kn-fieldset">
              <legend>{t("kn.contentLegend")}</legend>
              <Field
                label={
                  d.category === "agent_skill"
                    ? t("kn.skillMd")
                    : t("kn.contentMd")
                }
              >
                <textarea
                  className="kn-textarea"
                  rows={12}
                  value={d.content}
                  onChange={(e) => set({ content: e.target.value })}
                />
              </Field>
            </fieldset>
            <fieldset className="kn-fieldset">
              <legend>{t("kn.advanced")}</legend>
              <div className="kn-form-grid two">
                <Field
                  label={t("kn.applicabilityJson")}
                  hint={t("kn.applicabilityHint")}
                >
                  <textarea
                    className="code"
                    rows={6}
                    value={d.applicability}
                    onChange={(e) => set({ applicability: e.target.value })}
                  />
                </Field>
                <Field label={t("kn.metadataJson")} hint={t("kn.metadataHint")}>
                  <textarea
                    className="code"
                    rows={6}
                    value={d.metadata}
                    onChange={(e) => set({ metadata: e.target.value })}
                  />
                </Field>
              </div>
            </fieldset>
            <div className="kn-savebar">
              {!isNew && (
                <input
                  placeholder={t("kn.changeNote")}
                  value={d.change_note}
                  onChange={(e) => set({ change_note: e.target.value })}
                  aria-label={t("kn.changeNoteAria")}
                />
              )}
              <button onClick={save}>
                {isNew ? <Plus size={15} /> : <SquarePen size={15} />}
                {isNew ? t("kn.createBtn") : t("kn.save")}
              </button>
            </div>
          </div>
        )}

        {tab === "preview" && (
          <div className="kn-content">
            <Markdown text={d.content || `_(${t("kn.emptyContent")})_`} />
          </div>
        )}

        {tab === "versions" && !isNew && (
          <ol className="kn-timeline">
            {item.versions.map((v: any) => {
              const open = viewVersion === v.version;
              return (
                <li
                  key={v.version}
                  className={`kn-tl-item${v.version === item.current_version ? " is-current" : ""}`}
                >
                  <span className="kn-tl-dot" aria-hidden />
                  <div className="kn-tl-body">
                    <div className="kn-tl-row">
                      <b className="mono">v{v.version}</b>
                      {v.version === item.current_version && (
                        <span className="kn-tag chip-brand">
                          {t("kn.current")}
                        </span>
                      )}
                      <span className="muted small">
                        {time(v.created_at)}
                        {v.created_by ? ` · ${v.created_by}` : ""}
                      </span>
                      <span className="grow" />
                      <button
                        className={open ? "xs" : "xs ghost"}
                        onClick={() => setViewVersion(open ? null : v.version)}
                      >
                        {open ? t("kn.hide") : t("kn.view")}
                      </button>
                    </div>
                    {v.effective_from && (
                      <div className="small kn-tl-note">
                        {t("kp.effectiveOn", { date: time(v.effective_from) })}
                        {v.version === item.effective_version
                          ? ""
                          : new Date(v.effective_from) > new Date()
                            ? ` · ${t("kp.notYet")}`
                            : ""}
                      </div>
                    )}
                    {v.change_note && (
                      <div className="small kn-tl-note">{v.change_note}</div>
                    )}
                    {open && (
                      <div className="kn-content kn-tl-content">
                        <Markdown text={v.content} />
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {tab === "audit" &&
          !isNew &&
          (item.audit.length ? (
            <ol className="kn-timeline is-audit">
              {item.audit.map((a: any) => (
                <li key={a.id} className="kn-tl-item">
                  <span className="kn-tl-dot" aria-hidden />
                  <div className="kn-tl-body">
                    <div className="kn-tl-row">
                      <b>{a.action}</b>
                      <span className="muted small">{time(a.created_at)}</span>
                    </div>
                    <code className="kn-audit-detail">
                      {JSON.stringify(a.detail)}
                    </code>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="muted small">{t("kn.noAudit")}</div>
          ))}

        {tab === "usage" && !isNew && usage && (
          <div className="kn-usage">
            <Section icon={Workflow} title={t("kn.assigned")}>
              {usage.assigned.length ? (
                <ul className="kn-use-list">
                  {usage.assigned.map((a: any, i: number) => (
                    <li key={i}>
                      <a href={`#/workflows/${a.workflow}`} className="mono">
                        {a.workflow}
                      </a>{" "}
                      <span className="kn-tag">
                        {a.version === "draft"
                          ? t("kn.draft")
                          : `v${a.version}`}
                      </span>{" "}
                      <span className="muted small">
                        {a.step
                          ? t("kn.step", { step: a.step })
                          : t("kn.allSteps")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="muted small">{t("kn.notAssigned")}</div>
              )}
            </Section>
            <Section icon={History} title={t("kn.applied")}>
              {usage.used.length ? (
                <ul className="kn-use-list">
                  {usage.used.map((u: any, i: number) => (
                    <li key={i}>
                      <a href={`#/runs/${u.run_id}/${u.step_key}`}>
                        Run #{u.run_id} · {u.step_name}
                      </a>{" "}
                      <span className="muted small">
                        {u.definition_key} · v{u.version} · {time(u.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="muted small">{t("kn.noneApplied")}</div>
              )}
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

/** Cross-task memory provenance + the explicit human promotion step (only path to trusted agent conclusions). */
function MemoryProvenance({
  itemKey,
  m,
  onDone,
}: {
  itemKey: string;
  m: any;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [by, setBy] = useState("");
  const tone =
    m.trust === "verified" || m.trust === "approved"
      ? "COMPLETED"
      : m.trust === "rejected"
        ? "FAILED"
        : "WAITING";
  const decide = async (d: "approve" | "reject") => {
    if (
      await act(
        () => api(`/api/knowledge/${itemKey}/${d}`, { by }),
        d === "approve" ? t("kn.approvedToast") : t("kn.rejectedToast"),
      )
    )
      onDone();
  };
  return (
    <div
      className="card"
      style={{
        borderLeft: `4px solid var(${tone === "COMPLETED" ? "--st-ok" : tone === "FAILED" ? "--st-err" : "--st-wait"})`,
      }}
    >
      <div className="card-head">
        <h4>{t("kn.memoryTitle")}</h4>
        <Badge s={tone}>{m.trust}</Badge>
        <span className="pill">confidence: {m.confidence}</span>
      </div>
      <div className="kv small">
        <span>{t("kn.run")}</span>
        <span>
          <a href={`#/runs/${m.run_id}`}>#{m.run_id}</a> {m.work_item ?? ""}
        </span>
        <span>{t("kn.repository")}</span>
        <span className="mono">
          {m.repo} @ {String(m.commit_sha ?? "").slice(0, 12)} (base{" "}
          {m.base_branch})
        </span>
        <span>{t("kn.files")}</span>
        <span className="mono">
          {(m.files ?? []).slice(0, 8).join(", ") || "—"}
        </span>
        <span>{t("kn.sources")}</span>
        <span>{(m.sources ?? []).join(", ")}</span>
        <span>{t("kn.extracted")}</span>
        <span>{time(m.extracted_at)}</span>
        {m.approved_by && (
          <>
            <span>{t("kn.reviewedBy")}</span>
            <span>
              {m.approved_by} · {time(m.approved_at)}
            </span>
          </>
        )}
      </div>
      {m.trust === "unverified" && (
        <div className="row">
          <span className="small muted grow">{t("kn.unverified")}</span>
          <input
            style={{ width: 180 }}
            placeholder={t("kn.reviewerPh")}
            value={by}
            onChange={(e) => setBy(e.target.value)}
            aria-label={t("kn.reviewerPh")}
          />
          <button
            className="sm ok"
            disabled={!by.trim()}
            onClick={() => decide("approve")}
          >
            {t("kn.approve")}
          </button>
          <button
            className="sm ghost"
            disabled={!by.trim()}
            onClick={() => decide("reject")}
          >
            {t("kn.reject")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Rule evolution at a glance: supersession both ways, a version waiting for its effective date, related proposals. */
function Evolution({ item }: { item: any }) {
  const { t } = useI18n();
  const { data: props } = useApi<any[]>(
    `/api/knowledge-proposals?target=${encodeURIComponent(item.key)}`,
    [item.key],
  );
  const waiting =
    item.effective_version != null &&
    item.effective_version !== item.current_version;
  const expired = item.expires_at && new Date(item.expires_at) <= new Date();
  if (
    !item.superseded_by_item &&
    !item.supersedes?.length &&
    !waiting &&
    !item.expires_at &&
    !props?.length
  )
    return null;
  return (
    <div className="card kp-evo">
      {item.superseded_by_item && (
        <div className="kp-note kp-warn small">
          <History size={14} /> {t("kp.supersededBy")}{" "}
          <a
            className="mono"
            href={`#/knowledge/${item.superseded_by_item.key}`}
          >
            {item.superseded_by_item.key}
          </a>{" "}
          — {t("kp.supersededHint")}
        </div>
      )}
      {item.supersedes?.length > 0 && (
        <div className="kp-note small">
          {t("kp.replaces")}{" "}
          {item.supersedes.map((x: any) => (
            <a key={x.key} className="mono" href={`#/knowledge/${x.key}`}>
              {x.key}{" "}
            </a>
          ))}
        </div>
      )}
      {waiting && (
        <div className="kp-note small">
          {t("kp.waitingVersion", {
            current: item.current_version,
            effective: item.effective_version,
          })}
        </div>
      )}
      {item.expires_at && (
        <div className={`kp-note small${expired ? " kp-warn" : ""}`}>
          {t(expired ? "kp.expired" : "kp.expires", {
            date: time(item.expires_at),
          })}
        </div>
      )}
      {props && props.length > 0 && (
        <div className="small">
          <b>{t("kp.related")}</b>{" "}
          {props.slice(0, 8).map((p) => (
            <a
              key={p.id}
              className="kp-rel"
              href={`#/knowledge/~proposals/${p.id}`}
            >
              #{p.id} {p.change_type} <ProposalStatus s={p.status} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
