import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ExternalLink,
  FolderGit2,
  Inbox,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Workflow,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import { dialog } from "../dialog/index.ts";
import { useI18n } from "../i18n/index.tsx";
import { act, ago, Empty, EmptyState, ErrorBox, SkeletonRows, time } from "../ui.tsx";
import "./Intake.css";

type Item = {
  id: number;
  source: string;
  state: string;
  severity: string | null;
  service: string | null;
  repo_candidate: string | null;
  workflow: string | null;
  occurrences: number;
  last_seen: string;
  reason: string;
  would_start: { workflow: string; repo: string } | null;
  stale_revision: boolean | null;
  run_id: number | null;
  work_item_id: number | null;
  permalink?: string | null;
  work_item_code?: string | null;
  work_item_title?: string | null;
};
const STATES = ["eligible", "queued", "running", "deferred", "rejected", "superseded", "resolved"];
const STATE_TONE: Record<string, string> = {
  eligible: "ok",
  queued: "run",
  starting: "run",
  running: "run",
  deferred: "wait",
  imported: "idle",
  triaged: "idle",
  rejected: "idle",
  superseded: "idle",
  resolved: "idle",
};
const SEV_TONE: Record<string, string> = {
  critical: "err",
  high: "err",
  medium: "wait",
  low: "idle",
};
const WAITING = ["deferred", "rejected", "superseded"];

function Chip({ tone, children, title }: { tone: string; children: ReactNode; title?: string }) {
  return (
    <span className={`in-chip is-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Intake queue: why each item would, would not, or did start. Owners see theirs; admins may see all. */
export function IntakeQueue({ all = false }: { all?: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState("");
  const { data, error, loading, reload } = useApi<Item[]>(
    `/api/intake/items${all ? "?all=1" : ""}`,
  );
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const i of data ?? []) m[i.state] = (m[i.state] ?? 0) + 1;
    return m;
  }, [data]);
  const items = useMemo(
    () => (data ?? []).filter((i) => !state || i.state === state),
    [data, state],
  );
  const tabs = ["", ...STATES, ...Object.keys(counts).filter((s) => !STATES.includes(s))];
  const retriage = async (id: number) =>
    (await act(() => api(`/api/intake/items/${id}/retriage`, {}))) && reload();
  return (
    <section className="card set-section in-queue" id="set-intake-queue">
      <header className="set-section-head">
        <Inbox size={18} aria-hidden />
        <h3>{t("in.queue")}</h3>
        {data && <span className="in-total">{data.length}</span>}
        <button
          className="ghost sm icon"
          onClick={reload}
          aria-label={t("in.refresh")}
          title={t("in.refresh")}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      {data && data.length > 0 && (
        <nav className="in-tabs" aria-label={t("in.state")}>
          {tabs.map((s) => (
            <button
              key={s || "all"}
              type="button"
              className={`in-tab${s === state ? " on" : ""}`}
              aria-pressed={s === state}
              onClick={() => setState(s)}
            >
              {s ? t(`in.st.${s}`) : t("in.allStates")}
              <span className="in-tab-n">{s ? (counts[s] ?? 0) : data.length}</span>
            </button>
          ))}
        </nav>
      )}
      {loading && !data && <SkeletonRows rows={4} />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && data.length === 0 && (
        <EmptyState icon={Inbox} title={t("in.emptyTitle")}>
          {t("in.empty")}
          {all && (
            <>
              {" "}
              <button
                type="button"
                className="linkish"
                onClick={() =>
                  document.getElementById("set-intake")?.scrollIntoView({ behavior: "smooth" })
                }
              >
                {t("in.openPolicies")}
              </button>
            </>
          )}
        </EmptyState>
      )}
      {data && data.length > 0 && items.length === 0 && (
        <div className="in-none">{t("in.noMatch")}</div>
      )}
      <ul className="in-list">
        {items.map((i) => (
          <li key={i.id} className={`in-item is-${STATE_TONE[i.state] ?? "idle"}`}>
            <div className="in-item-top">
              <Chip tone={STATE_TONE[i.state] ?? "idle"}>{t(`in.st.${i.state}`)}</Chip>
              {i.severity && <Chip tone={SEV_TONE[i.severity] ?? "idle"}>{i.severity}</Chip>}
              <b className="in-item-title">
                {i.work_item_title || i.service || i.workflow || t(`in.src.${i.source}`)}
              </b>
              <span className="in-item-id mono">#{i.id}</span>
              <span className="in-item-time" title={time(i.last_seen)}>
                {ago(i.last_seen)}
              </span>
            </div>
            <div className="in-item-meta">
              <span>{t(`in.src.${i.source}`)}</span>
              {i.repo_candidate && (
                <span className="mono">
                  <FolderGit2 size={12} /> {i.repo_candidate}
                </span>
              )}
              {i.workflow && (
                <span className="mono">
                  <Workflow size={12} /> {i.workflow}
                </span>
              )}
              {i.occurrences > 1 && <span>×{i.occurrences}</span>}
              {i.work_item_id && (
                <a href={`#/work-items/${i.work_item_id}`}>
                  {i.work_item_code || t("in.workItem")}
                </a>
              )}
              {i.run_id && <a href={`#/runs/${i.run_id}`}>run #{i.run_id}</a>}
              {i.permalink && (
                <a href={i.permalink} target="_blank" rel="noreferrer">
                  {t("in.source")} <ExternalLink size={11} />
                </a>
              )}
            </div>
            {i.would_start && (
              <div className="in-callout is-run">
                <Play size={13} />
                {t("in.wouldStart", { wf: i.would_start.workflow })}
                {i.would_start.repo && <span className="mono"> · {i.would_start.repo}</span>}
              </div>
            )}
            {i.stale_revision && (
              <div className="in-callout is-err">
                <AlertTriangle size={13} />
                {t("in.staleRevision")}
              </div>
            )}
            {i.reason && <div className="in-item-reason">{i.reason}</div>}
            {WAITING.includes(i.state) && (
              <div className="in-item-actions">
                <button className="ghost sm" onClick={() => retriage(i.id)}>
                  <RefreshCw size={13} />
                  {t("in.retriage")}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

type Policy = {
  id: number;
  source: string;
  owner_id: number | null;
  mode: string;
  paused: boolean;
  workflows: string[];
  repositories: string[];
  min_severity: string;
  max_active_runs: number;
  max_runs_per_day: number;
  max_backlog?: number;
  revision: number;
};
const MODES = ["OFF", "SHADOW", "AUTOPILOT"];

/** Admin: per-source intake policies (OFF / SHADOW / AUTOPILOT), with a global pause per policy. */
export function IntakePolicies() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi<{
    policies: Policy[];
    modes: string[];
    sources: string[];
  }>("/api/intake/policies");
  const [draft, setDraft] = useState({
    source: "prod_errors",
    owner_id: "",
    mode: "SHADOW",
    workflows: "production-incident-investigation",
    repositories: "",
    min_severity: "high",
    max_active_runs: 2,
    max_runs_per_day: 5,
  });
  const save = async (extra: Partial<Policy> = {}, base?: Policy) =>
    (await act(() =>
      api("/api/intake/policies", {
        ...(base ?? {
          ...draft,
          owner_id: draft.owner_id ? Number(draft.owner_id) : null,
          workflows: draft.workflows
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          repositories: draft.repositories
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
        ...extra,
      }),
    )) && reload();
  const setMode = async (p: Policy, mode: string) => {
    if (mode === p.mode) return;
    if (
      mode === "AUTOPILOT" &&
      !(await dialog.confirm({
        title: t("in.autopilotTitle"),
        description: t("in.autopilotBody", { source: t(`in.src.${p.source}`) }),
        confirmLabel: t("in.autopilotConfirm"),
        cancelLabel: t("common.cancel"),
        variant: "destructive",
      }))
    )
      return;
    await save({ mode }, p);
  };
  const field = (label: string, input: ReactNode, hint?: string) => (
    <label className="in-field">
      <span>{label}</span>
      {input}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
  return (
    <section className="card set-section in-policies" id="set-intake">
      <header className="set-section-head">
        <Inbox size={18} aria-hidden />
        <h3>{t("in.policies")}</h3>
      </header>
      <p className="small muted">{t("in.hint")}</p>
      {loading && !data && <SkeletonRows rows={3} />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && data.policies.length === 0 && <Empty>{t("in.noPolicy")}</Empty>}
      <div className="in-policy-list">
        {data?.policies.map((p) => (
          <article
            key={p.id}
            className={`in-policy is-${p.mode.toLowerCase()}${p.paused ? " is-paused" : ""}`}
          >
            <header className="in-policy-head">
              <b>{t(`in.src.${p.source}`)}</b>
              {p.owner_id ? <span className="in-item-id mono">owner {p.owner_id}</span> : null}
              {p.paused && <Chip tone="wait">{t("in.paused")}</Chip>}
              <div className="in-modes" role="group" aria-label={t("in.f.mode")}>
                {MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`in-mode${m === p.mode ? " on" : ""}`}
                    aria-pressed={m === p.mode}
                    onClick={() => setMode(p, m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <button className="ghost sm" onClick={() => save({ paused: !p.paused }, p)}>
                {p.paused ? <Play size={13} /> : <Pause size={13} />}
                {p.paused ? t("in.resume") : t("in.pause")}
              </button>
            </header>
            <p className="small muted in-policy-mode">{t(`in.modeHint.${p.mode}`)}</p>
            <dl className="in-policy-grid">
              <div>
                <dt>{t("in.f.workflows")}</dt>
                <dd className="mono">{p.workflows.join(", ") || "—"}</dd>
              </div>
              <div>
                <dt>{t("in.f.repos")}</dt>
                <dd className="mono">{p.repositories.join(", ") || t("in.ownerRepos")}</dd>
              </div>
              <div>
                <dt>{t("in.f.minSev")}</dt>
                <dd>≥ {p.min_severity}</dd>
              </div>
              <div>
                <dt>{t("in.caps")}</dt>
                <dd>
                  {t("in.capsValue", { active: p.max_active_runs, perDay: p.max_runs_per_day })}
                  {p.max_backlog != null && ` · ${t("in.backlog")} ${p.max_backlog}`}
                </dd>
              </div>
            </dl>
            <footer className="in-item-id">rev {p.revision}</footer>
          </article>
        ))}
      </div>
      {data && (
        <details className="in-form" open={data.policies.length === 0}>
          <summary>
            <Plus size={14} /> {t("in.addPolicy")}
          </summary>
          <div className="in-form-grid">
            {field(
              t("in.f.source"),
              <select
                value={draft.source}
                onChange={(e) => setDraft({ ...draft, source: e.target.value })}
              >
                {data.sources.map((o) => (
                  <option key={o} value={o}>
                    {t(`in.src.${o}`)}
                  </option>
                ))}
              </select>,
            )}
            {field(
              t("in.f.mode"),
              <select
                value={draft.mode}
                onChange={(e) => setDraft({ ...draft, mode: e.target.value })}
              >
                {data.modes.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>,
              t(`in.modeHint.${draft.mode}`),
            )}
            {field(
              t("in.f.minSev"),
              <select
                value={draft.min_severity}
                onChange={(e) => setDraft({ ...draft, min_severity: e.target.value })}
              >
                {["critical", "high", "medium", "low"].map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>,
            )}
            {field(
              t("in.f.owner"),
              <input
                inputMode="numeric"
                value={draft.owner_id}
                onChange={(e) => setDraft({ ...draft, owner_id: e.target.value })}
              />,
              t("in.f.ownerHint"),
            )}
            {field(
              t("in.f.workflows"),
              <input
                value={draft.workflows}
                onChange={(e) => setDraft({ ...draft, workflows: e.target.value })}
              />,
              t("in.f.listHint"),
            )}
            {field(
              t("in.f.repos"),
              <input
                value={draft.repositories}
                onChange={(e) => setDraft({ ...draft, repositories: e.target.value })}
              />,
              t("in.f.listHint"),
            )}
            {field(
              t("in.f.activeRuns"),
              <input
                type="number"
                min={0}
                value={draft.max_active_runs}
                onChange={(e) => setDraft({ ...draft, max_active_runs: Number(e.target.value) })}
              />,
            )}
            {field(
              t("in.f.perDay"),
              <input
                type="number"
                min={0}
                value={draft.max_runs_per_day}
                onChange={(e) => setDraft({ ...draft, max_runs_per_day: Number(e.target.value) })}
              />,
            )}
          </div>
          <button onClick={() => save()}>{t("in.save")}</button>
        </details>
      )}
    </section>
  );
}
