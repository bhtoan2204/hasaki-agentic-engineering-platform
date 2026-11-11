import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  CheckCircle2,
  Compass,
  Eye,
  FolderGit2,
  FolderKanban,
  GitPullRequest,
  Link2,
  Network,
  PenLine,
  Plus,
  RefreshCw,
  Power,
  Save,
  ShieldCheck,
  Tag,
  Trash2,
  UserRound,
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
  Loading,
  Markdown,
  navigate,
  PageHeader,
  SearchInput,
  Segmented,
  StatCard,
} from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import "./Repositories.css";
import { BitbucketState, RepositoryAccessAdmin } from "./RepositoryAccess.tsx";

const LISTS = [
  "projects",
  "services",
  "tags",
  "owners",
  "dependencies",
  "allowed_actions",
] as const;
const ACTION_ICON: Record<string, LucideIcon> = {
  read: Eye,
  write: PenLine,
  pull_request: GitPullRequest,
};

function Chips({
  items,
  empty = "—",
  kind = "",
}: {
  items?: string[];
  empty?: ReactNode;
  kind?: string;
}) {
  if (!items?.length) return <span className="muted small">{empty}</span>;
  return (
    <span className="repo-chips">
      {items.map((x) => (
        <span key={x} className={`repo-chip ${kind}`}>
          {x}
        </span>
      ))}
    </span>
  );
}
function Actions({ items }: { items?: string[] }) {
  if (!items?.length) return <span className="muted small">—</span>;
  return (
    <span className="repo-chips">
      {items.map((a) => {
        const I = ACTION_ICON[a] ?? ShieldCheck;
        return (
          <span key={a} className={`repo-action is-${a}`}>
            <I size={12} strokeWidth={2.2} />
            {a}
          </span>
        );
      })}
    </span>
  );
}
const repoDir = (r: any) => r.repository_url || r.path || r.name;

/** The caller's effective access to one repository (platform grant ∩ Bitbucket ∩ repository policy). */
function AccessCard({ access, provider }: { access: any; provider?: string }) {
  const { t } = useI18n();
  if (!access) return null;
  return (
    <section className="card">
      <div className="card-head">
        <ShieldCheck size={16} color="var(--brand)" />
        <h4>{t("repo.yourAccess")}</h4>
        <span className="grow" />
        <span className={`repo-level is-${access.level}`}>{t(`repo.level.${access.level}`)}</span>
      </div>
      <dl className="repo-kv">
        <div>
          <dt>{t("repo.access.source")}</dt>
          <dd>{access.source ? t(`repo.source.${access.source}`) : "—"}</dd>
        </div>
        <div>
          <dt>{provider === "github" ? "GitHub" : "Bitbucket"}</dt>
          <dd>
            <BitbucketState
              host={provider}
              state={access.bitbucket.state}
              reason={access.bitbucket.reason}
              stale={access.bitbucket.stale}
            />
          </dd>
        </div>
      </dl>
      <p className="muted small">{t("repo.access.effectiveHint")}</p>
    </section>
  );
}

export function RepositoriesPage({
  name,
  query,
  me,
}: { name?: string; query?: string; me?: { role?: string } | null } = {}) {
  const { t } = useI18n();
  const isAdmin = me?.role === "admin";
  const view = new URLSearchParams(
    query || (location.hash.includes("?") ? location.hash.split("?")[1] : ""),
  ).get("view");
  // Members only ever see "My repositories". Admins also manage the registry and grants (view=manage); managing
  // access is not reading: the workspace and index panels need the admin's own grant like anyone else's.
  const manage = isAdmin && view === "manage";
  const { data, error, loading, reload } = useApi<any[]>(
    manage ? "/api/repositories?manage=1" : "/api/repositories",
    [manage],
  );

  // Only for a repository the caller can read (otherwise the page shows "not found", like an unknown name).
  const readable = !!name && !manage && !!data?.some((x) => x.name === name);
  const workspace = useApi<any>(
    readable ? `/api/repositories/${encodeURIComponent(name!)}/workspace` : null,
    [manage, readable],
  );
  const index = useApi<{ enabled: boolean; repositories: any[] }>(
    readable ? "/api/repositories/index-status" : null,
    [manage, readable],
  );
  const manageHref = (repo?: string) =>
    repo ? `/repositories/${repo}?view=manage` : "/repositories?view=manage";
  const tabs = isAdmin && (
    <Segmented
      label={t("repo.title")}
      options={[
        ["mine", t("repo.mine")],
        ["manage", t("repo.manage")],
      ]}
      value={manage ? "manage" : "mine"}
      onChange={(v) =>
        navigate(
          v === "manage" ? manageHref(name) : name ? `/repositories/${name}` : "/repositories",
        )
      }
    />
  );
  const [form, setForm] = useState<any>(null);
  const [rank, setRank] = useState({ text: "", project: "" });
  const [ranked, setRanked] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const initParams = useMemo(
    () =>
      new URLSearchParams(
        query || (location.hash.includes("?") ? location.hash.split("?")[1] : ""),
      ),
    [query],
  );
  const [q, setQState] = useState(() => initParams.get("q") || "");
  const [filter, setFilterState] = useState<"all" | "on" | "off">(
    () => (initParams.get("filter") as "all" | "on" | "off") || "all",
  );

  const syncUrl = (newFilter: string, newQ: string) => {
    if (name) return;
    const p = new URLSearchParams();
    if (manage) p.set("view", "manage");
    if (newFilter && newFilter !== "all") p.set("filter", newFilter);
    if (newQ.trim()) p.set("q", newQ.trim());
    const qs = p.toString();
    const newHash = `#/repositories${qs ? `?${qs}` : ""}`;
    if (location.hash !== newHash) {
      history.replaceState(null, "", newHash);
    }
  };

  const setFilter = (f: "all" | "on" | "off") => {
    setFilterState(f);
    syncUrl(f, q);
  };
  const setQ = (queryText: string) => {
    setQState(queryText);
    syncUrl(filter, queryText);
  };
  useEffect(() => {
    if (!data) return;
    const r = name ? data.find((x) => x.name === name) : null;
    setForm(
      r
        ? {
            ...r,
            ...Object.fromEntries(LISTS.map((k) => [k, r[k].join(", ")])),
          }
        : {
            name: "",
            provider: "bitbucket",
            repository_url: "",
            default_branch: "",
            category: "",
            description: "",
            architecture: "",
            enabled: true,
            ...Object.fromEntries(
              LISTS.map((k) => [k, k === "allowed_actions" ? "read, write, pull_request" : ""]),
            ),
          },
    );
  }, [data, name]);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (data ?? []).filter(
      (r) =>
        (filter === "all" || (filter === "on" ? r.enabled : !r.enabled)) &&
        (!n ||
          [
            r.name,
            r.description,
            r.repository_url,
            r.path,
            r.remote_slug,
            ...r.projects,
            ...r.services,
            ...r.tags,
          ].some((x) =>
            String(x ?? "")
              .toLowerCase()
              .includes(n),
          )),
    );
  }, [data, q, filter]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const save = async () => {
    const { path: _legacyPath, remote_slug: _legacySlug, ...metadata } = form;
    const body = {
      ...metadata,
      ...Object.fromEntries(
        LISTS.map((k) => [
          k,
          String(form[k])
            .split(",")
            .map((x: string) => x.trim())
            .filter(Boolean),
        ]),
      ),
    };
    if (
      await act(
        () => api(`/api/repositories/${encodeURIComponent(form.name)}`, body),
        t("repo.saved"),
      )
    )
      (reload(), setCreating(false), navigate(manageHref(form.name)));
  };
  const startNew = () => {
    if (name) navigate(manageHref());
    setCreating(true);
  };
  const remove = async (repo: string) => {
    if (!confirm(t("repo.deleteConfirm", { name: repo }))) return;
    if (
      await act(
        () => api(`/api/repositories/${encodeURIComponent(repo)}/delete`, {}),
        t("repo.deleted", { name: repo }),
      )
    )
      (reload(), navigate(manageHref()));
  };

  const editor = manage && form && (
    <RepoForm form={form} setForm={setForm} isNew={!name} onSave={save} />
  );

  // ------------------------------------------------------------------ detail
  if (name) {
    const r = data!.find((x) => x.name === name);
    return (
      <div className="repo">
        <PageHeader
          icon={FolderGit2}
          crumbs={[[t("repo.title"), "#/repositories"], [name]]}
          title={<span className="mono">{name}</span>}
          subtitle={r?.description || undefined}
          actions={
            <>
              {tabs}
              <button
                className="ghost"
                onClick={() => navigate(manage ? manageHref() : "/repositories")}
              >
                <ArrowLeft size={15} />
                {t("repo.list")}
              </button>
              {manage && (
                <button className="ghost" onClick={startNew}>
                  <Plus size={15} />
                  {t("repo.add")}
                </button>
              )}
              {manage && r && (
                <button className="danger" onClick={() => remove(r.name)}>
                  <Trash2 size={15} />
                  {t("repo.delete")}
                </button>
              )}
            </>
          }
        />
        {!r ? (
          <EmptyState
            icon={FolderGit2}
            title={t("repo.missing")}
            action={
              <button
                className="ghost sm"
                onClick={() => navigate(manage ? manageHref() : "/repositories")}
              >
                {t("repo.back")}
              </button>
            }
          >
            {t("repo.notRegistered", { name })}
          </EmptyState>
        ) : null}
        <div className="repo-detail">
          {r && (
            <div className="repo-detail-main">
              <div className="card repo-hero">
                <div className="repo-hero-row">
                  <span className="repo-hero-icon">
                    <FolderGit2 size={22} />
                  </span>
                  <div className="repo-hero-main">
                    <div className="repo-hero-name mono">{r.name}</div>
                    <div className="repo-hero-path">
                      <span className="mono">{repoDir(r)}</span>
                      {r.provider && <span className="repo-chip">{r.provider}</span>}
                    </div>
                  </div>
                  {r.enabled ? (
                    <Badge s="COMPLETED">{t("kn.enabled")}</Badge>
                  ) : (
                    <Badge s="CANCELED">{t("kn.enabledNo")}</Badge>
                  )}
                </div>
                <dl className="repo-kv">
                  <div>
                    <dt>{t(r.repository_url ? "repo.url" : "repo.legacyLayout")}</dt>
                    <dd className="mono">
                      {repoDir(r)}
                      {!r.repository_url && !r.path && (
                        <span className="muted small"> {t("repo.equalsName")}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("repo.provider")}</dt>
                    <dd>{r.provider || <span className="muted">—</span>}</dd>
                  </div>
                  <div>
                    <dt>{t("repo.category")}</dt>
                    <dd>{r.category || <span className="muted">—</span>}</dd>
                  </div>
                  <div>
                    <dt>{t("repo.defaultBranch")}</dt>
                    <dd className="mono">
                      {r.default_branch || (
                        <span className="muted">{t("repo.instanceDefault")}</span>
                      )}
                    </dd>
                  </div>
                </dl>
              </div>

              {manage ? (
                <RepositoryAccessAdmin only={r.name} />
              ) : (
                <AccessCard access={r.access} provider={r.provider} />
              )}
              {!manage && (
                <>
                  <section className="card">
                    <div className="card-head">
                      <FolderGit2 size={16} />
                      <h4>{t("repo.workspace")}</h4>
                    </div>
                    <p>{t(`repo.workspace.${workspace.data?.status ?? "remote_configured"}`)}</p>
                    <p className="muted small">{workspace.data?.instance_id}</p>
                    <div className="row" style={{ flexWrap: "wrap" }}>
                      {(["test-connection", "prepare", "refresh"] as const).map((action) => (
                        <button
                          key={action}
                          className="ghost sm"
                          onClick={async () => {
                            if (
                              await act(
                                () =>
                                  api(
                                    `/api/repositories/${encodeURIComponent(r.name)}/${action}`,
                                    {},
                                  ),
                                t("repo.saved"),
                              )
                            )
                              workspace.reload();
                          }}
                        >
                          {t(`repo.${action}`)}
                        </button>
                      ))}
                      <button className="ghost sm" onClick={workspace.reload}>
                        {t("repo.workspaceStatus")}
                      </button>
                    </div>
                  </section>
                  <section className="card">
                    <div className="card-head">
                      <Network size={16} color="var(--brand)" />
                      <h4>Code intelligence</h4>
                    </div>
                    {index.error ? (
                      <ErrorBox error={index.error} onRetry={index.reload} />
                    ) : !index.data?.enabled ? (
                      <span className="muted small">Disabled on this instance</span>
                    ) : (
                      (() => {
                        const state = index.data.repositories.find((x: any) => x.name === r.name);
                        return (
                          <>
                            <dl className="repo-kv">
                              <div>
                                <dt>Status</dt>
                                <dd>{state?.status ?? "Not indexed"}</dd>
                              </div>
                              <div>
                                <dt>Progress</dt>
                                <dd>
                                  {state?.status === "running"
                                    ? `${state?.metrics?.processed_files ?? 0} / ${state?.metrics?.total_files ?? "…"}`
                                    : "—"}
                                </dd>
                              </div>
                              <div>
                                <dt>Commit</dt>
                                <dd className="mono">{state?.commit_sha?.slice(0, 12) ?? "—"}</dd>
                              </div>
                              <div>
                                <dt>Files / symbols / relations</dt>
                                <dd>
                                  {state?.indexed_files ?? 0} / {state?.symbol_count ?? 0} /{" "}
                                  {state?.relation_count ?? 0}
                                </dd>
                              </div>
                              <div>
                                <dt>Last indexed</dt>
                                <dd>
                                  {state?.last_indexed_at
                                    ? new Date(state.last_indexed_at).toLocaleString()
                                    : "—"}
                                </dd>
                              </div>
                            </dl>
                            {state?.last_indexing_error && (
                              <p className="muted small">{state.last_indexing_error}</p>
                            )}
                            {isAdmin && (
                              <button
                                className="ghost sm"
                                onClick={async () => {
                                  if (
                                    await act(
                                      () =>
                                        api(
                                          `/api/repositories/${encodeURIComponent(r.name)}/reindex`,
                                          {},
                                        ),
                                      "Indexing queued",
                                    )
                                  )
                                    index.reload();
                                }}
                              >
                                Reindex (admin)
                              </button>
                            )}
                            <button className="ghost sm" onClick={index.reload}>
                              Refresh
                            </button>
                            {isAdmin &&
                              state?.indexing_run_id &&
                              ["queued", "running"].includes(state.status) && (
                                <button
                                  className="ghost sm"
                                  onClick={async () => {
                                    if (
                                      await act(
                                        () =>
                                          api(
                                            `/api/repositories/index-runs/${state.indexing_run_id}/cancel`,
                                            {},
                                          ),
                                        "Indexing canceled",
                                      )
                                    )
                                      index.reload();
                                  }}
                                >
                                  Cancel (admin)
                                </button>
                              )}
                          </>
                        );
                      })()
                    )}
                  </section>
                </>
              )}

              <section className="card">
                <div className="card-head">
                  <ShieldCheck size={16} color="var(--brand)" />
                  <h4>{t("repo.perms")}</h4>
                </div>
                <div className="repo-perm">
                  <div>
                    <div className="repo-label">{t("repo.allowed")}</div>
                    <Actions items={r.allowed_actions} />
                  </div>
                  <div>
                    <div className="repo-label">{t("repo.projectsAllowed")}</div>
                    <Chips items={r.projects} kind="is-project" empty={t("repo.noProject")} />
                  </div>
                </div>
              </section>

              <div className="repo-grid2">
                <section className="card">
                  <div className="card-head">
                    <Boxes size={16} color="var(--brand)" />
                    <h4>{t("repo.servicesTags")}</h4>
                  </div>
                  <div className="repo-label">{t("repo.services")}</div>
                  <Chips items={r.services} />
                  <div className="repo-label">{t("repo.tags")}</div>
                  <Chips items={r.tags} kind="is-tag" />
                </section>
                <section className="card">
                  <div className="card-head">
                    <Network size={16} color="var(--brand)" />
                    <h4>{t("repo.depsOwners")}</h4>
                  </div>
                  <div className="repo-label">{t("repo.dependencies")}</div>
                  {r.dependencies?.length ? (
                    <span className="repo-chips">
                      {r.dependencies.map((d: string) => {
                        const known = data!.some((x) => x.name === d);
                        return known ? (
                          <a
                            key={d}
                            className="repo-chip is-link"
                            href={`#${manage ? manageHref(d) : `/repositories/${d}`}`}
                          >
                            <Link2 size={11} />
                            {d}
                          </a>
                        ) : (
                          <span key={d} className="repo-chip">
                            {d}
                          </span>
                        );
                      })}
                    </span>
                  ) : (
                    <span className="muted small">—</span>
                  )}
                  <div className="repo-label">{t("repo.owners")}</div>
                  {r.owners?.length ? (
                    <span className="repo-chips">
                      {r.owners.map((o: string) => (
                        <span key={o} className="repo-chip">
                          <UserRound size={11} />
                          {o}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="muted small">—</span>
                  )}
                </section>
              </div>

              <section className="card">
                <div className="card-head">
                  <FolderKanban size={16} color="var(--brand)" />
                  <h4>{t("repo.arch")}</h4>
                </div>
                {r.architecture ? (
                  <div className="repo-arch">
                    <Markdown text={r.architecture} />
                  </div>
                ) : (
                  <span className="muted small">{t("repo.noArch")}</span>
                )}
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
  // My repositories: what the caller may actually do. Management: what the registry allows.
  const writable = all.filter((r) =>
    manage ? r.enabled && r.allowed_actions.includes("write") : r.access?.effective?.write,
  ).length;
  return (
    <div className="repo">
      <PageHeader
        icon={FolderGit2}
        title={manage ? t("repo.manage") : t("repo.mine")}
        subtitle={manage ? t("repo.subtitle") : t("repo.mineSubtitle")}
        actions={
          <>
            {tabs}
            {manage ? (
              <button onClick={startNew}>
                <Plus size={15} strokeWidth={2.2} />
                {t("repo.add")}
              </button>
            ) : (
              <button
                className="ghost"
                onClick={async () => {
                  if (
                    await act(
                      () => api("/api/repository-access/revalidate", {}),
                      t("repo.access.revalidated"),
                    )
                  )
                    reload();
                }}
              >
                <RefreshCw size={15} />
                {t("repo.revalidateMine")}
              </button>
            )}
          </>
        }
      />
      {manage && <RepositoryAccessAdmin />}
      <div className="repo-stats">
        <StatCard icon={FolderGit2} label={t("repo.title")} value={all.length} tone="brand" />
        <StatCard
          icon={Power}
          label={t("repo.on")}
          value={enabled}
          hint={t("repo.offN", { n: all.length - enabled })}
          tone="ok"
        />
        <StatCard
          icon={FolderKanban}
          label={t("repo.list.projects")}
          value={projects.size}
          hint={t("repo.projectsHint")}
          tone="run"
        />
        <StatCard
          icon={PenLine}
          label={t("repo.writable")}
          value={writable}
          hint={t("repo.writableHint")}
          tone="wait"
        />
      </div>

      <div className="repo-layout">
        <div className="repo-main">
          <div className="toolbar">
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder={t("repo.search")}
              width="min(100%, 320px)"
            />
            <Segmented
              label={t("repo.status")}
              options={[
                ["all", t("repo.all")],
                ["on", t("repo.on")],
                ["off", t("repo.off")],
              ]}
              value={filter}
              onChange={setFilter}
            />
            <span className="grow" />
            <span className="muted small">
              {t("repo.count", { shown: shown.length, all: all.length })}
            </span>
          </div>
          {!all.length && !manage ? (
            <EmptyState icon={FolderGit2} title={t("repo.mineEmpty")}>
              {t(isAdmin ? "repo.mineEmptyAdmin" : "repo.mineEmptyBody")}
            </EmptyState>
          ) : !all.length ? (
            <EmptyState
              icon={FolderGit2}
              title={t("repo.empty")}
              action={
                <button onClick={startNew}>
                  <Plus size={15} />
                  {t("repo.add")}
                </button>
              }
            >
              {t("repo.emptyBody")}
            </EmptyState>
          ) : !shown.length ? (
            <div className="repo-none">{t("repo.noMatch")}</div>
          ) : (
            <div className="repo-cards">
              {shown.map((r) => (
                <button
                  key={r.name}
                  type="button"
                  className={`repo-card${r.enabled ? "" : " is-off"}`}
                  onClick={() => navigate(manage ? manageHref(r.name) : `/repositories/${r.name}`)}
                >
                  <div className="repo-card-head">
                    <span className="repo-card-icon">
                      <FolderGit2 size={17} />
                    </span>
                    <div className="repo-card-title">
                      <b className="mono">{r.name}</b>
                      <span className="repo-card-path mono">
                        {r.repository_url || r.remote_slug || repoDir(r)}
                      </span>
                    </div>
                    {!r.enabled && <Badge s="CANCELED">{t("kn.enabledNo")}</Badge>}
                    {r.access && (
                      <span className={`repo-level is-${r.access.level}`}>
                        {t(`repo.level.${r.access.level}`)}
                      </span>
                    )}
                  </div>
                  <div className="repo-card-desc">
                    {r.description || <span className="muted">{t("repo.noDesc")}</span>}
                  </div>
                  <div className="repo-card-rows">
                    <div>
                      <span className="repo-label-inline">
                        <FolderKanban size={12} />
                        {t("repo.list.projects")}
                      </span>
                      <Chips items={r.projects} kind="is-project" />
                    </div>
                    <div>
                      <span className="repo-label-inline">
                        <Tag size={12} />
                        {t("repo.servicesTagsInline")}
                      </span>
                      <Chips items={[...r.services, ...r.tags]} />
                    </div>
                    <div>
                      <span className="repo-label-inline">
                        <ShieldCheck size={12} />
                        {t("repo.actions")}
                      </span>
                      <Actions items={r.allowed_actions} />
                    </div>
                    {r.access?.bitbucket?.state &&
                      r.access.bitbucket.state !== "not_applicable" && (
                        <div>
                          <span className="repo-label-inline">
                            {r.provider === "github" ? "GitHub" : "Bitbucket"}
                          </span>
                          <BitbucketState
                            host={r.provider}
                            state={r.access.bitbucket.state}
                            reason={r.access.bitbucket.reason}
                            stale={r.access.bitbucket.stale}
                          />
                        </div>
                      )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <aside className="repo-side">
          <section className="card repo-rank">
            <div className="card-head">
              <Compass size={16} color="var(--brand)" />
              <h4>{t("repo.rankTitle")}</h4>
            </div>
            <div className="muted small" style={{ marginBottom: 8 }}>
              {t("repo.rankHint")}
            </div>
            <textarea
              rows={2}
              placeholder={t("repo.rankPh")}
              value={rank.text}
              onChange={(e) => setRank({ ...rank, text: e.target.value })}
              aria-label={t("repo.rankAria")}
            />
            <div className="row">
              <input
                className="repo-rank-project"
                placeholder={t("repo.project")}
                value={rank.project}
                onChange={(e) => setRank({ ...rank, project: e.target.value })}
                aria-label={t("repo.project")}
              />
              <button
                className="sm ghost"
                onClick={async () =>
                  setRanked(await act(() => api("/api/repositories/rank", rank)))
                }
              >
                {t("repo.rank")}
              </button>
            </div>
            {ranked && (
              <div className="repo-ranked">
                {ranked.ambiguous && (
                  <div className="repo-ambig">
                    <AlertTriangle size={14} />
                    {t("repo.ambiguous")}
                  </div>
                )}
                {!ranked.ranked.length && <div className="muted small">{t("repo.noneFit")}</div>}
                {(() => {
                  const max = Math.max(...ranked.ranked.map((x: any) => Number(x.score) || 0), 1);
                  return ranked.ranked.map((x: any, i: number) => (
                    <div key={x.repo} className="repo-ranked-row">
                      <div className="repo-ranked-top">
                        {i === 0 && !ranked.ambiguous ? (
                          <CheckCircle2 size={14} color="var(--st-ok)" />
                        ) : (
                          <span className="repo-rank-n">{i + 1}</span>
                        )}
                        <b className="mono">{x.repo}</b>
                        <span className="grow" />
                        <span className="mono small">{x.score}</span>
                      </div>
                      <div className="repo-ranked-bar">
                        <span
                          style={{
                            width: `${Math.max(0, (Number(x.score) || 0) / max) * 100}%`,
                          }}
                        />
                      </div>
                      {x.reasons?.length > 0 && (
                        <div className="muted small">{x.reasons.join(" · ")}</div>
                      )}
                    </div>
                  ));
                })()}
              </div>
            )}
          </section>
        </aside>
      </div>
      {creating && manage && (
        <NewRepoDrawer
          form={form}
          setForm={setForm}
          onSave={save}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function NewRepoDrawer({
  form,
  setForm,
  onSave,
  onClose,
}: {
  form: any;
  setForm: (f: any) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Drawer title={t("repo.add")} onClose={onClose} width={560}>
      {form ? <RepoForm form={form} setForm={setForm} isNew onSave={onSave} bare /> : <Loading />}
    </Drawer>
  );
}

function RepoForm({
  form,
  setForm,
  isNew,
  onSave,
  bare,
}: {
  form: any;
  setForm: (f: any) => void;
  isNew: boolean;
  onSave: () => void;
  bare?: boolean;
}) {
  const { t } = useI18n();
  const body = (
    <>
      <Field label={t("repo.name")}>
        <input
          value={form.name}
          disabled={!isNew}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </Field>
      <Field label={t("repo.provider")}>
        <select
          value={form.provider || "bitbucket"}
          onChange={(e) => setForm({ ...form, provider: e.target.value })}
        >
          <option value="bitbucket">Bitbucket</option>
          <option value="github">GitHub</option>
        </select>
      </Field>
      <Field label={t("repo.url")}>
        <input
          value={form.repository_url ?? ""}
          placeholder={
            form.provider === "github"
              ? "https://github.com/owner/repository.git"
              : "https://bitbucket.org/workspace/repository.git"
          }
          onChange={(e) => setForm({ ...form, repository_url: e.target.value })}
        />
      </Field>
      <button
        className="ghost sm"
        onClick={async () => {
          const result = await act(
            () =>
              api<any>("/api/repositories/validate-url", {
                repository_url: form.repository_url,
              }),
            t("repo.urlValid"),
          );
          if (result) setForm({ ...form, repository_url: result.url });
        }}
      >
        {t("repo.validateUrl")}
      </button>
      <Field label={t("repo.defaultBranch")}>
        <input
          value={form.default_branch ?? ""}
          onChange={(e) => setForm({ ...form, default_branch: e.target.value })}
        />
      </Field>
      <Field label={t("repo.category")}>
        <input
          value={form.category ?? ""}
          placeholder={t("repo.categoryPh")}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
        />
      </Field>
      <Field label={t("repo.desc")}>
        <textarea
          rows={2}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </Field>
      <div className="repo-form-grid">
        {LISTS.map((k) => (
          <Field key={k} label={t(`repo.list.${k}`)} hint={t("repo.comma")}>
            <input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
      <Field label={t("repo.arch")}>
        <textarea
          rows={4}
          value={form.architecture}
          onChange={(e) => setForm({ ...form, architecture: e.target.value })}
        />
      </Field>
      <div className="repo-form-foot">
        <label className="repo-toggle">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />{" "}
          {t("kn.enabled")}
        </label>
        <span className="grow" />
        <button disabled={!form.name} onClick={onSave}>
          <Save size={15} />
          {t("kn.save")}
        </button>
      </div>
    </>
  );
  if (bare) return <div className="repo-form">{body}</div>;
  return (
    <section className="card repo-form">
      <div className="card-head">
        <PenLine size={16} color="var(--brand)" />
        <h4>{isNew ? t("repo.add") : t("repo.edit", { name: form.name })}</h4>
      </div>
      {body}
    </section>
  );
}
