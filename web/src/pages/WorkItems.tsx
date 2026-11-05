import { useMemo, useState } from "react";
import {
  ChevronRight, CircleHelp, Clock, Download, FileJson, FileText, FolderGit2, GitPullRequest, History, KeyRound, ListTodo, LogIn, PenLine, Pencil, Play, Plus,
  RefreshCw, ScanSearch, Settings2, Sparkles, StepForward, Workflow, Zap, Siren,
} from "lucide-react";
import { api, useApi, useLive } from "../api.ts";
import { act, ago, Badge, Drawer, EmptyState, ErrorBox, Field, JsonBlock, Loading, Markdown, navigate, PageHeader, SearchInput, Segmented, SkeletonRows, time } from "../ui.tsx";
import { RunsTable } from "./Runs.tsx";
import { ProfilePreview, type ProfileChoice } from "./ProfilePreview.tsx";
import { uiLocale, useI18n } from "../i18n/index.tsx";
import type { UiLocale } from "../i18n/messages.ts";
import "./WorkItems.css";

/** Production error groups this work item fixes, with their latest counts (did the fix make them stop?). */
const WI_STATUS_KEY: Record<string, string> = { open: "wi.open", in_progress: "wi.doing", done: "wi.done", archived: "wi.archived" };
const wiBadge = (s: string) => (s === "in_progress" ? "RUNNING" : s === "done" ? "COMPLETED" : "PENDING");
function WiStatus({ s }: { s: string }) {
  const { t } = useI18n();
  return <Badge s={wiBadge(s)}>{t(WI_STATUS_KEY[s] ?? s)}</Badge>;
}
const sourceLabel = (t: (k: string) => string, s: string) => t(`wi.src.${s}`) === `wi.src.${s}` ? s : t(`wi.src.${s}`);

function ProdErrorRefs({ rows }: { rows: any[] }) {
  const { t } = useI18n();
  if (!rows?.length) return null;
  const hm = (t: string | null) => (t ? new Date(t).toLocaleString(uiLocale() === "vi" ? "vi-VN" : "en-GB", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", hour12: false }) : "–");
  return (
    <section className="card wi-prod">
      <div className="card-head"><span className="wi-hicon"><Siren size={16} strokeWidth={2} /></span><h4>{t("wi.prodTitle")}</h4><span className="muted small">{t("wi.prodFrom")}</span></div>
      {rows.map((g) => {
        const current = g.day === g.latest_day;
        return (
          <a key={g.fingerprint} className="wi-prod-row" href={`#/prod-errors/${g.fingerprint}`}>
            <span className={`pe-sev pe-${g.severity}`}>{g.severity}</span>
            <span className="wi-prod-main">
              <b>{g.service}</b> <span className="mono small">{g.signature}</span>
              <span className="muted small">
                {current
                  ? <>{t("wi.prodCurrent", { day: g.day, count: g.today_count, when: hm(g.last_at) })}{g.yesterday_count ? ` · ${t("wi.prodYesterday", { count: g.yesterday_count })}` : ""}</>
                  : <>{t("wi.prodGone", { day: g.latest_day, when: hm(g.last_at) })}</>}
              </span>
            </span>
          </a>
        );
      })}
    </section>
  );
}

function HasakiPanel({ onImported }: { onImported: () => void }) {
  const { t } = useI18n();
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
    const r = await act(() => api<any>(`/api/work/pick/${workId}`, {}), t("wi.importedRun"));
    if (r) (reloadInbox(), onImported(), navigate(`/work-items/${r.work_item_id}`));
  };
  return (
    <section className="card wi-hasaki">
      <div className="card-head">
        <span className="wi-hicon"><Sparkles size={16} strokeWidth={2} /></span>
        <h4>Hasaki Work</h4>
        {st && (st.loggedIn ? <Badge s="COMPLETED">{t("wi.loggedIn")}</Badge> : <Badge s="FAILED">{t("wi.loggedOut")}</Badge>)}
      </div>
      {st?.expiresAt && <div className="muted small wi-hexp"><Clock size={12} strokeWidth={2} /> {t("wi.expires", { time: time(st.expiresAt) })}</div>}
      {st && !st.loggedIn && (
        <div className="stack wi-hlogin">
          {st.windowOpen ? <span className="muted small"><span className="spinner" /> {t("wi.loginWindow")}</span> : (
            <button className="sm" onClick={async () => (await act(() => api("/api/work/login-window", {}))) && reloadSt()}><LogIn size={14} strokeWidth={2} />{t("wi.openLogin")}</button>
          )}
          <div className="wi-inline">
            <input aria-label="Token" placeholder={t("wi.tokenPh")} value={token} onChange={(e) => setToken(e.target.value)} />
            <button className="sm ghost" onClick={async () => (await act(() => api("/api/work/token", { token }), t("wi.tokenSaved"))) && (setToken(""), reloadSt())}><KeyRound size={14} strokeWidth={2} />{t("wi.save")}</button>
          </div>
        </div>
      )}
      {st?.loggedIn && (
        <div className="stack wi-hlogin">
          <button className="sm" disabled={busy} onClick={refresh}><RefreshCw size={14} strokeWidth={2} className={busy ? "wi-spin" : undefined} />{busy ? t("wi.fetching") : t("wi.fetchTasks")}</button>
          <div className="wi-inline">
            <input aria-label="Task id" placeholder={t("wi.taskId")} value={taskId} onChange={(e) => setTaskId(e.target.value)} />
            <button className="sm ghost" disabled={!taskId} onClick={() => pick(taskId)}><Download size={14} strokeWidth={2} />{t("kn.import")}</button>
          </div>
        </div>
      )}
      {!!inbox?.length && (
        <>
          <div className="wi-hsub">{t("wi.inbox")} <span className="muted">· {inbox.length}</span></div>
          <div className="wi-hinbox">
            {inbox.map((r) => (
              <div key={r.work_id} className="wi-hitem">
                <div className="wi-hitem-main">
                  <div className="wi-hitem-meta"><span className="mono">{r.code}</span>{r.project && <span>· {r.project}</span>}</div>
                  <div className="wi-hitem-name">{r.name}</div>
                </div>
                {r.work_item_id ? (
                  <a className="wi-hitem-link" href={`#/work-items/${r.work_item_id}`}>{r.run_status ? <Badge s={r.run_status} label /> : <span className="pill chip-brand">{t("wi.imported")}</span>}</a>
                ) : (
                  <button className="xs ghost" onClick={() => pick(r.work_id)}>{t("kn.import")}</button>
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
  const { t } = useI18n();
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
      return act(async () => { throw new Error(t("wi.badJson")); });
    }
    const r = await act(() => api<any>("/api/work-items/import", { source: src, payload }), t("wi.importedOnly"));
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
        title={t("wi.title")}
        subtitle={t("wi.subtitle")}
        crumbs={[[t("nav.overview"), "#/overview"], [t("wi.title")]]}
        actions={
          <>
            <button className="ghost icon" aria-label={t("wi.refreshList")} title={t("wi.refresh")} onClick={reload}><RefreshCw size={16} strokeWidth={2} /></button>
            <button className="ghost" onClick={() => setPanel("import")}><FileJson size={15} strokeWidth={2} />{t("wi.importBtn")}</button>
            <button onClick={() => setPanel("create")}><Plus size={16} strokeWidth={2.2} />{t("wi.new")}</button>
          </>
        }
      />

      <div className="wi-layout">
        <div className="wi-main">
          <div className="wi-toolbar">
            <SearchInput value={q} onChange={setQ} placeholder={t("wi.search")} width="min(320px, 100%)" />
            <div className="wi-scroll">
              <Segmented<string>
                label={t("wi.source")}
                value={source}
                onChange={setSource}
                options={[["", t("wi.allSources")], ...["manual", "hasaki_work", "jira", "legacy"].map((s) => [s, sourceLabel(t, s)] as [string, string])]}
              />
            </div>
          </div>
          <div className="wi-statusbar" role="group" aria-label={t("wi.filterStatus")}>
            {([["", t("wi.all"), data?.length ?? 0], ...Object.keys(WI_STATUS_KEY).map((k) => [k, t(WI_STATUS_KEY[k]), counts[k] ?? 0])] as Array<[string, string, number]>).map(([k, label, n]) => (
              <button key={k || "all"} type="button" className={`wi-sf${statusF === k ? " on" : ""}`} aria-pressed={statusF === k} onClick={() => setStatusF(k)}>
                {k && <i className={`wi-dot wi-dot-${k}`} />}{label}<span className="wi-sf-n">{n}</span>
              </button>
            ))}
          </div>

          {loading && !data ? <SkeletonRows rows={6} /> : error ? <ErrorBox error={error} onRetry={reload} /> : !data?.length ? (
            <EmptyState icon={ListTodo} title={t("wi.empty")} action={<button onClick={() => setPanel("create")}><Plus size={16} strokeWidth={2.2} />{t("wi.first")}</button>}>
              {t("wi.emptyBody")}
            </EmptyState>
          ) : !shown.length ? (
            <EmptyState icon={ScanSearch} title={t("wi.noMatch")}>{t("wi.noMatchBody")}</EmptyState>
          ) : (
            <div className="wi-list">
              {shown.map((w) => (
                <a key={w.id} className="wi-row" href={`#/work-items/${w.id}`}>
                  <i className={`wi-bar wi-dot-${w.status}`} aria-hidden />
                  <div className="wi-row-main">
                    <div className="wi-row-meta">
                      <span className="mono wi-code">{w.code}</span>
                      <span className="wi-src">{sourceLabel(t, w.source)}</span>
                      {w.project && <span className="wi-proj"><FolderGit2 size={12} strokeWidth={2} />{w.project}</span>}
                    </div>
                    <div className="wi-row-title">{w.title}</div>
                  </div>
                  <div className="wi-row-side">
                    <WiStatus s={w.status} />
                    <div className="wi-row-runs">
                      <span className="muted small"><Workflow size={12} strokeWidth={2} /> {t("wi.runs", { n: w.run_count })}</span>
                      {w.last_run_status && <Badge s={w.last_run_status} label />}
                    </div>
                    <span className="muted small wi-row-time"><Clock size={12} strokeWidth={2} />{t("wi.ago", { ago: ago(w.updated_at) })}</span>
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
            <span>{t("wi.note")}</span>
          </div>
        </aside>
      </div>

      {panel === "create" && (
        <Drawer title={t("wi.createTitle")} onClose={() => setPanel("")}>
          <Field label={t("wi.fieldTitle")}><input autoFocus placeholder={t("wi.titlePh")} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Project"><input placeholder={t("wi.projectPh")} value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} /></Field>
          <Field label={t("wi.description")}><textarea rows={8} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <div className="row">
            <button disabled={!form.title.trim()} onClick={async () => { const w = await act(() => api<any>("/api/work-items", form)); if (w) navigate(`/work-items/${w.id}`); }}><Plus size={15} strokeWidth={2.2} />{t("wi.create")}</button>
            <button className="ghost" onClick={() => setPanel("")}>{t("common.cancel")}</button>
          </div>
        </Drawer>
      )}
      {panel === "import" && (
        <Drawer title={t("wi.importBtn")} onClose={() => setPanel("")}>
          <Field label="JSON"><textarea className="code" rows={10} placeholder={t("wi.jsonPh")} value={paste} onChange={(e) => setPaste(e.target.value)} /></Field>
          <div className="row">
            <button className="ghost" disabled={!paste} onClick={() => importJson("hasaki_work")}><Download size={14} strokeWidth={2} />{t("wi.importHasaki")}</button>
            <button className="ghost" disabled={!paste} onClick={() => importJson("jira")}><Download size={14} strokeWidth={2} />{t("wi.importJira")}</button>
          </div>
          <div className="divider" />
          {meta?.jiraEnabled ? (
            <Field label={t("wi.fromJira")}>
              <div className="wi-inline">
                <input placeholder="JIRA-123" value={jiraKey} onChange={(e) => setJiraKey(e.target.value)} />
                <button className="ghost" onClick={async () => { const r = await act(() => api<any>("/api/work-items/import", { source: "jira", key: jiraKey })); if (r) navigate(`/work-items/${r.item.id}`); }}>{t("wi.fetch")}</button>
              </div>
            </Field>
          ) : (
            <div className="muted small">{t("wi.jiraOff")}</div>
          )}
        </Drawer>
      )}
    </div>
  );
}

/** View / edit the request description (tasks often arrive with an empty note). Edits are kept across re-imports. */
function DescriptionEditor({ id, description, source, onSaved }: { id: number; description: string; source?: string; onSaved: () => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(description ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await act(() => api(`/api/work-items/${id}`, { description: text }), t("wi.savedDesc"));
    setBusy(false);
    if (r) (setEditing(false), onSaved());
  };
  return (
    <div>
      <div className="card-head">
        <span className="wi-hicon"><FileText size={16} strokeWidth={2} /></span>
        <h4>{t("wi.request")}</h4>
        {source === "manual" && !editing && <span className="pill" title={t("wi.editedTip")}><PenLine size={12} strokeWidth={2} /> {t("wi.edited")}</span>}
        {!editing && (
          <button className="sm ghost" onClick={() => (setText(description ?? ""), setEditing(true))}>
            {description ? <><Pencil size={13} strokeWidth={2} />{t("wi.edit")}</> : <><Plus size={14} strokeWidth={2.2} />{t("wi.addDesc")}</>}
          </button>
        )}
      </div>
      {editing ? (
        <div>
          <textarea rows={10} autoFocus placeholder={t("wi.descPh")} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row">
            <button className="sm" disabled={busy} onClick={save}>{busy ? t("wi.saving") : t("wi.save")}</button>
            <button className="sm ghost" onClick={() => setEditing(false)}>{t("common.cancel")}</button>
            <span className="muted small">{t("wi.agentUses")}</span>
          </div>
        </div>
      ) : description ? (
        <div className="wi-desc"><Markdown text={description} /></div>
      ) : (
        <div className="wi-desc-empty">
          <CircleHelp size={18} strokeWidth={1.9} />
          <span>{t("wi.noDesc")}</span>
        </div>
      )}
    </div>
  );
}

export function WorkItemDetail({ id }: { id: number }) {
  const { data: w, error, loading, reload } = useApi<any>(`/api/work-items/${id}`);
  const { data: wfs } = useApi<any[]>("/api/workflows");
  useLive(null, (p) => (!p || p.kind === "status") && reload());
  const { t, locale } = useI18n();
  const [wf, setWf] = useState("feature-implementation");
  const [profile, setProfile] = useState<ProfileChoice>("AUTO");
  const [outputLocale, setOutputLocale] = useState<UiLocale>(locale);
  if (loading && !w) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const start = async (mode: "start" | "step" | "pending") => {
    const r = await act(() => api<any>(`/api/work-items/${id}/runs`, { workflow: wf, start: mode === "start", profile, output_locale: outputLocale }));
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
        crumbs={[[t("wi.title"), "#/work-items"], [w.code || `#${id}`]]}
      >
        <div className="wi-hmeta">
          <span className="mono wi-code">{w.code}</span>
          <WiStatus s={w.status} />
          <span className="wi-src">{sourceLabel(t, w.source)}</span>
          <span className="wi-proj"><FolderGit2 size={12} strokeWidth={2} />{w.project || t("wi.noProject")}</span>
        </div>
      </PageHeader>

      <div className="wi-detail">
        <div className="wi-detail-main">
          <section className="card">
            <DescriptionEditor id={id} description={w.description} source={w.description_source} onSaved={reload} />
            {w.payload && Object.keys(w.payload).length > 0 && <details className="wi-raw"><summary>{t("wi.raw")}</summary><JsonBlock value={w.payload} /></details>}
          </section>

          <ProdErrorRefs rows={w.prod_errors} />

          <section className="wi-section">
            <div className="wi-section-head"><History size={16} strokeWidth={2} /><h4>{t("wi.history")}</h4><span className="muted small">{t("wi.runs", { n: w.runs.length })}</span></div>
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
              <summary>{t("wi.legacy", { questions: w.legacy.questions.length, events: w.legacy.events.length })}</summary>
              {w.legacy.questions.map((q: any) => <div key={q.id} className="q"><b>{q.question}</b><div className="muted">→ {q.answer ?? t("wi.unanswered")}</div></div>)}
              {w.legacy.events.map((e: any) => <div key={e.id} className="small"><span className="muted">{time(e.created_at)}</span> <b>{e.kind}</b> {e.content}</div>)}
            </details>
          )}
        </div>

        <aside className="wi-detail-side">
          <section className="card hero wi-launch">
            <div className="wi-launch-head">
              <span className="wi-launch-icon"><Play size={18} strokeWidth={2.2} /></span>
              <div>
                <h4>{t("run.launch")}</h4>
                <div className="muted small">{t("run.launchHint")}</div>
              </div>
            </div>
            <Field label="Workflow">
              <select value={wf} onChange={(e) => setWf(e.target.value)}>
                {(wfs ?? []).filter((x) => x.latest_version > 0).map((x) => <option key={x.key} value={x.key}>{x.name} (v{x.latest_version}) — {x.description?.slice(0, 60)}</option>)}
              </select>
            </Field>
            {selectedWf?.description && <div className="wi-wfdesc">{selectedWf.description}</div>}
            <ProfilePreview workflow={wf} workItemId={id} value={profile} onChange={setProfile} />
            <Field label={t("run.outputLanguage")} hint={t("run.outputHint")}>
              <select value={outputLocale} onChange={(e) => setOutputLocale(e.target.value as UiLocale)}>
                <option value="vi">{t("lang.vi")}</option>
                <option value="en">{t("lang.en")}</option>
              </select>
            </Field>
            <button className="wi-start" onClick={() => start("start")}><Play size={16} strokeWidth={2.2} />{t("run.start")}</button>
            <div className="wi-launch-alt">
              <button className="ghost sm" onClick={() => start("step")} title={t("run.step")}><StepForward size={14} strokeWidth={2} />{t("run.step")}</button>
              <button className="ghost sm" onClick={() => start("pending")}><Settings2 size={14} strokeWidth={2} />{t("run.pending")}</button>
              <button className="ghost sm" onClick={async () => { const r = await act(() => api<any>(`/api/work-items/${id}/analyze`, { output_locale: outputLocale })); if (r) navigate(`/runs/${r.id}`); }}><ScanSearch size={14} strokeWidth={2} />{t("run.analyze")}</button>
            </div>
          </section>

          <section className="card">
            <div className="card-head"><span className="wi-hicon"><Settings2 size={16} strokeWidth={2} /></span><h4>{t("wi.settings")}</h4></div>
            <Field label={t("wi.policy")} hint={t("wi.policyHint")}>
              <div className="wi-policy">
                <span className="grow small">{w.automation_policy ? t("wi.autoRun", { workflow: w.automation_policy.workflow }) : t("wi.none")}</span>
                <button className="xs ghost" onClick={async () => (await act(() => api(`/api/work-items/${id}`, { automation_policy: { workflow: wf } }), t("wi.saved"))) && reload()}>{t("wi.useSelected")}</button>
                {w.automation_policy && <button className="xs ghost" onClick={async () => (await act(() => api(`/api/work-items/${id}`, { automation_policy: null }))) && reload()}>{t("wi.remove")}</button>}
              </div>
            </Field>
            <Field label={t("wi.status")}>
              <select value={w.status} onChange={async (e) => (await act(() => api(`/api/work-items/${id}`, { status: e.target.value }))) && reload()}>
                {["open", "in_progress", "done", "archived"].map((s) => <option key={s} value={s}>{t(WI_STATUS_KEY[s])} ({s})</option>)}
              </select>
            </Field>
          </section>
        </aside>
      </div>
    </div>
  );
}
