import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  ExternalLink,
  Hand,
  History,
  ListFilter,
  Play,
  RotateCcw,
  ScanSearch,
  Wrench,
  X,
} from "lucide-react";
import { api, useApi, useLive } from "../../api.ts";
import { SharedAnalysisCard } from "../../components/SharedAnalysis.tsx";
import type { SharedView } from "../../sharedAnalysis.ts";
import { dialog } from "../../dialog/index.ts";
import { useI18n } from "../../i18n/index.tsx";
import {
  act,
  ago,
  EmptyState,
  ErrorBox,
  FilterField,
  FilterToolbar,
  Pager,
  SearchInput,
  SkeletonRows,
  Tabs,
  navigate,
  toast,
} from "../../ui.tsx";
import { AssessProgressCard, type AssessProgress } from "../ScanProgress.tsx";
import "./code-scan.css";

/** A finding as the scan output lists it (history view counts severities from it). */
type ScanFinding = { id: string; severity: string };
type Status =
  "needs_look" | "in_progress" | "fixed" | "report_only" | "unverified" | "resolved" | "dismissed";
const STATUSES: Status[] = [
  "needs_look",
  "in_progress",
  "fixed",
  "report_only",
  "unverified",
  "resolved",
  "dismissed",
];
/** A finding managed across scans (GET /api/code-findings): one row per fingerprint. */
type FindingRow = {
  id: number;
  fingerprint: string;
  repo: string;
  related_repos: string[];
  kind: string;
  severity: string;
  title: string;
  file: string;
  line: number | null;
  symbol: string;
  implementable: boolean;
  status: "open" | "resolved" | "dismissed";
  display_status: Status;
  occurrences: number;
  reopened_count: number;
  first_seen_at: string;
  last_seen_at: string;
  last_scan_run_id: number | null;
  fix_run_id: number | null;
};
type FindingPage = {
  items: FindingRow[];
  total: number;
  page: number;
  page_size: number;
  facets: { repos: string[]; kinds: string[]; statuses: Partial<Record<Status, number>> };
};
type FindingDetail = FindingRow & {
  issue: string;
  evidence: string;
  why_not: string;
  code_evidence: { status: "verified" | "missing"; reason?: string } | null;
  status_note: string;
  sightings: Array<{
    scan_run_id: number;
    finding_key: string;
    seen_at: string;
    severity: string;
    issue: string;
    evidence: string;
    line: number | null;
    selected_repositories: string[];
  }>;
  fixes: Array<{
    id: number;
    status: string;
    created_at: string;
    decision: string | null;
    steps: Array<{ key: string; status: string }> | null;
  }>;
};
type Fix = { run_id: number; status: string; steps: Array<{ key: string; status: string }> | null };
type Scan = {
  id: number;
  title: string;
  status: string;
  selected_repositories: string[];
  focus: string | null;
  created_at: string;
  assess_status: string;
  decision: string | null;
  summary: string | null;
  findings: ScanFinding[] | null;
  steps: Array<{ key: string; status: string }> | null;
  activity: (Omit<AssessProgress, "phase" | "startedAt"> & { started_at: string | null }) | null;
  typical_seconds: number | null;
};

const FIX = "codebase-improvement";
const SEVERITY_ORDER = ["high", "medium", "low"];
const ASSESSING = ["PENDING", "READY", "RUNNING", "RETRYING"];
const TERMINAL = ["COMPLETED", "FAILED", "CANCELED"];

/** Where a running assessment is: preparing (repositories, context), the agent assessing, or the report. */
function progressOf(scan: Scan): AssessProgress | null {
  if (TERMINAL.includes(scan.status) || !scan.steps) return null;
  const st = (key: string) => scan.steps?.find((x) => x.key === key)?.status ?? "";
  const live = (status: string) => ASSESSING.includes(status);
  const phase: AssessProgress["phase"] | null =
    st("select") === "COMPLETED" && live(st("assess"))
      ? "assess"
      : st("assess") === "COMPLETED" && live(st("report"))
        ? "report"
        : live(st("select"))
          ? "prepare"
          : null;
  if (!phase) return null;
  return {
    phase,
    startedAt: scan.activity?.started_at ?? scan.created_at,
    tools: scan.activity?.tools ?? 0,
    reads: scan.activity?.reads ?? 0,
    commands: scan.activity?.commands ?? 0,
    last: scan.activity?.last ?? null,
  };
}

/**
 * Agent code assessment: read-only codebase-assessment runs report findings; findings are managed across scans (one
 * per fingerprint, with every scan's evidence). A person filters them, opens one and starts a codebase-improvement run
 * on exactly that finding, or resolves or dismisses it. Each scan's own result is in Scan history.
 */
export function CodeScan() {
  const { t } = useI18n();
  const repos =
    useApi<Array<{ name: string; enabled: boolean; self?: boolean; projects?: string[] }>>(
      "/api/repositories",
    );
  const scans = useApi<Scan[]>("/api/code-scans");
  const [view, setView] = useState<"findings" | "history">("findings");
  const [scanFilter, setScanFilter] = useState<number | null>(null);
  const [findingsVersion, setFindingsVersion] = useState(0);
  useLive(null, (p) => (!p || p.kind === "status") && scans.reload());
  const running = (scans.data ?? []).filter((x) => !TERMINAL.includes(x.status));
  const reloadScans = scans.reload;
  useEffect(() => {
    if (!running.length) return;
    const id = setInterval(() => reloadScans(), 4000);
    return () => clearInterval(id);
  }, [running.length, reloadScans]);
  // A scan that just completed is ingested on the next findings read.
  const done = (scans.data ?? []).filter((x) => TERMINAL.includes(x.status)).length;
  useEffect(() => setFindingsVersion((v) => v + 1), [done]);
  const [project, setProject] = useState("");
  const [repo, setRepo] = useState("");
  const [focus, setFocus] = useState("");
  const available = useMemo(
    () => (repos.data ?? []).filter((r) => r.enabled && !r.self),
    [repos.data],
  );
  const projects = useMemo(
    () => [...new Set(available.flatMap((r) => r.projects ?? []))].sort(),
    [available],
  );
  const inProject = available.filter((r) => !project || (r.projects ?? []).includes(project));
  const targets = repo ? [repo] : project ? inProject.map((r) => r.name) : [];

  // Shared results (flag SHARED_RESULTS_CODE_ASSESSMENT): the latest assessment of exactly these repositories and focus
  // that the viewer may read, from any member; an older commit shows as "may be outdated".
  const [sharedFocus, setSharedFocus] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setSharedFocus(focus.trim()), 400);
    return () => clearTimeout(id);
  }, [focus]);
  const shared = useApi<{ shared: SharedView | null }>(
    targets.length
      ? `/api/code-scans/shared?${new URLSearchParams({
          repositories: targets.join(","),
          focus: sharedFocus,
          ...(project ? { project } : {}),
        })}`
      : null,
  );
  const sharedView = shared.data?.shared ?? null;
  const reloadShared = shared.reload;
  useEffect(() => {
    if (sharedView?.status !== "running") return;
    const id = setInterval(() => reloadShared(), 4000);
    return () => clearInterval(id);
  }, [sharedView?.status, reloadShared]);

  const assess = async (force = false): Promise<void> => {
    const text = focus.trim();
    const subject = repo || project;
    const res = await act(() =>
      api<
        | { started: true; run_id: number; shared?: SharedView }
        | { reused: "running" | "same_commits"; run_id: number }
        | { reused: "shared"; shared: SharedView }
      >("/api/code-scans", {
        repositories: targets,
        ...(project ? { project } : {}),
        ...(text ? { focus: text } : {}),
        title: `${t("cs.runTitle")} ${subject}${text ? ` — ${text.slice(0, 80)}` : ""}`,
        ...(force ? { force: true } : {}),
      }),
    );
    if (!res) return;
    scans.reload();
    shared.reload();
    if ("started" in res) {
      setFocus("");
      toast.success(t(force && res.shared ? "sr.forced" : "cs.started"));
      return;
    }
    if (res.reused === "shared") {
      if (res.shared.outcome === "hit")
        toast.success(t("sr.toastHit", { name: res.shared.run_by.name ?? "—" }));
      else toast.info(t("sr.toastWait"));
      return;
    }
    if (res.reused === "running") {
      toast.info(t("cs.alreadyRunning", { id: res.run_id }));
      return;
    }
    const again = await dialog.confirm({
      title: t("cs.sameCommitsTitle"),
      description: t("cs.sameCommitsBody", { id: res.run_id }),
      confirmLabel: t("cs.forceRescan"),
      cancelLabel: t("cs.keepResult"),
    });
    if (again) await assess(true);
  };

  return (
    <div className="cs">
      <section className="card cs-start">
        <div className="cs-start-head">
          <Bot size={18} aria-hidden />
          <div>
            <h3>{t("cs.title")}</h3>
            <p className="muted small">{t("cs.intro")}</p>
          </div>
        </div>
        <div className="cs-form">
          <label className="field">
            <span>{t("cs.project")}</span>
            <select
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                setRepo("");
              }}
              aria-label={t("cs.project")}
            >
              <option value="">{t("cs.pickProject")}</option>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("cs.repo")}</span>
            <select
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              aria-label={t("cs.repo")}
            >
              <option value="">
                {project ? t("cs.allRepos", { n: inProject.length }) : t("cs.pickRepo")}
              </option>
              {inProject.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field cs-focus">
            <span>{t("cs.focus")}</span>
            <input
              value={focus}
              placeholder={t("cs.focusPh")}
              onChange={(e) => setFocus(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={!targets.length}
            aria-describedby={!targets.length ? "cs-scan-hint" : undefined}
            onClick={() => assess()}
          >
            <ScanSearch size={15} strokeWidth={2} />
            {t("cs.scan")}
          </button>
          {!targets.length && (
            <span id="cs-scan-hint" className="muted small">
              {t("hint.pickTarget")}
            </span>
          )}
        </div>
        {sharedView && (
          <div className="cs-shared">
            <SharedAnalysisCard view={sharedView} onForce={() => assess(true)} />
          </div>
        )}
      </section>

      {view === "findings" && running.map((scan) => <ScanCard key={scan.id} scan={scan} />)}

      <Tabs
        tabs={[
          [
            "findings",
            <>
              <ListFilter size={14} /> {t("cs.tab.findings")}
            </>,
          ],
          [
            "history",
            <>
              <History size={14} /> {t("cs.tab.history")}
              {scans.data ? ` (${scans.data.length})` : ""}
            </>,
          ],
        ]}
        value={view}
        onChange={setView}
      />

      {view === "findings" ? (
        <FindingsView
          projects={projects}
          version={findingsVersion}
          scan={scanFilter}
          onClearScan={() => setScanFilter(null)}
        />
      ) : (
        <>
          {scans.error && <ErrorBox error={scans.error} onRetry={scans.reload} />}
          {scans.loading && !scans.data && <SkeletonRows rows={3} />}
          {scans.data && scans.data.length === 0 && (
            <EmptyState icon={ScanSearch} title={t("cs.empty")}>
              {t("cs.emptyBody")}
            </EmptyState>
          )}
          {(scans.data ?? []).map((scan) => (
            <ScanCard
              key={scan.id}
              scan={scan}
              onShowFindings={() => {
                setScanFilter(scan.id);
                setView("findings");
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

function FixState({ fix }: { fix: Fix }) {
  const { t } = useI18n();
  const step = (key: string) => fix.steps?.find((s) => s.key === key)?.status;
  if (step("approve") === "WAITING_APPROVAL")
    return (
      <button type="button" className="xs" onClick={() => navigate(`/runs/${fix.run_id}/approve`)}>
        <Hand size={12} /> {t("cs.approve")}
      </button>
    );
  if (step("pr") === "WAITING_APPROVAL")
    return (
      <button type="button" className="xs" onClick={() => navigate(`/runs/${fix.run_id}/pr`)}>
        <ExternalLink size={12} /> {t("cs.prReady")}
      </button>
    );
  const changed = step("implement") === "COMPLETED";
  const label =
    fix.status === "COMPLETED" && !changed
      ? t("cs.fixNoChange")
      : fix.status === "COMPLETED"
        ? t("cs.fixDone")
        : ["FAILED", "CANCELED"].includes(fix.status)
          ? t("cs.fixFailed")
          : t("cs.inRun");
  return (
    <button type="button" className="xs ghost" onClick={() => navigate(`/runs/${fix.run_id}`)}>
      <Play size={12} /> {label}
    </button>
  );
}

function ScanCard({ scan, onShowFindings }: { scan: Scan; onShowFindings?: () => void }) {
  const { t } = useI18n();
  const findings = [...(scan.findings ?? [])].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const counts = Object.fromEntries(
    SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length]),
  );
  const assessing = ASSESSING.includes(scan.assess_status);
  const progress = progressOf(scan);
  return (
    <section className="card cs-scan" data-testid="code-scan">
      <header className="cs-scan-head">
        <div className="cs-scan-title">
          <b>{scan.selected_repositories.join(", ")}</b>
          {scan.focus && <span className="muted small"> · {scan.focus}</span>}
        </div>
        <div className="cs-scan-meta">
          {scan.assess_status === "WAITING_INPUT" ? (
            <a className="cs-chip is-run" href={`#/runs/${scan.id}/assess`}>
              {t("cs.waitingInput")}
            </a>
          ) : assessing ? (
            <span className="cs-chip is-run">{t("cs.scanning")}</span>
          ) : scan.assess_status === "FAILED" || scan.assess_status === "CANCELED" ? (
            <span className="cs-chip is-err">{t("cs.failed")}</span>
          ) : scan.decision === "NO_CHANGES_NEEDED" ? (
            <span className="cs-chip is-ok">{t("cs.noChanges")}</span>
          ) : (
            SEVERITY_ORDER.filter((s) => counts[s]).map((s) => (
              <span key={s} className={`cs-chip sev-${s}`}>
                {counts[s]} {t(`cs.sev.${s}`)}
              </span>
            ))
          )}
          <span className="muted small">{t("wi.ago", { ago: ago(scan.created_at) })}</span>
          <a className="muted small" href={`#/runs/${scan.id}`}>
            #{scan.id}
          </a>
        </div>
      </header>
      {progress && <AssessProgressCard progress={progress} typicalSeconds={scan.typical_seconds} />}
      {scan.summary && <p className="cs-summary">{scan.summary}</p>}
      {findings.length > 0 && onShowFindings && (
        <button type="button" className="xs ghost cs-scan-findings" onClick={onShowFindings}>
          <ListFilter size={12} /> {t("cs.showScanFindings", { n: findings.length })}
        </button>
      )}
    </section>
  );
}

const PAGE_SIZE = 25;

/** Every finding of every scan, one row per finding, with global filters and pages; a row opens its detail. */
function FindingsView({
  projects,
  version,
  scan,
  onClearScan,
}: {
  projects: string[];
  version: number;
  scan: number | null;
  onClearScan: () => void;
}) {
  const { t } = useI18n();
  const [project, setProject] = useState("");
  const [repo, setRepo] = useState("");
  const [sev, setSev] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    const id = setTimeout(() => setQ(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);
  useEffect(() => setPage(1), [project, repo, sev, kind, status, q, scan]);
  const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
  for (const [k, v] of Object.entries({ project, repo, severity: sev, kind, status, q }))
    if (v) params.set(k, v);
  if (scan) params.set("scan", String(scan));
  const filtered = !!(project || repo || sev || kind || status || q || scan);
  const data = useApi<FindingPage>(`/api/code-findings?${params}`);
  const reload = data.reload;
  useEffect(() => {
    if (version > 1) reload();
  }, [version, reload]);
  const facets = data.data?.facets;
  const pages = data.data ? Math.ceil(data.data.total / data.data.page_size) : 0;
  const select = (
    label: string,
    value: string,
    set: (v: string) => void,
    options: Array<[string, string]>,
  ) => (
    <FilterField label={label}>
      <select aria-label={label} value={value} onChange={(e) => set(e.target.value)}>
        <option value="">{t("an.all")}</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </FilterField>
  );
  return (
    <div className="cs-table-wrap" data-testid="code-findings">
      <FilterToolbar
        className="cs-filters"
        secondary={
          <>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={t("cs.searchFindings")}
              width="100%"
            />
            {scan && (
              <button type="button" className="xs ghost" onClick={onClearScan}>
                <X size={12} /> {t("cs.scanFilter", { id: scan })}
              </button>
            )}
          </>
        }
      >
        {select(
          t("cs.project"),
          project,
          setProject,
          projects.map((p) => [p, p]),
        )}
        {select(
          t("cs.col.repo"),
          repo,
          setRepo,
          (facets?.repos ?? []).map((r) => [r, r]),
        )}
        {select(
          t("cs.col.severity"),
          sev,
          setSev,
          SEVERITY_ORDER.map((s) => [s, t(`cs.sev.${s}`)]),
        )}
        {select(
          t("cs.col.kind"),
          kind,
          setKind,
          (facets?.kinds ?? []).map((k) => [k, t(`cs.kind.${k}`)]),
        )}
        {select(
          t("cs.col.status"),
          status,
          setStatus,
          STATUSES.map((s) => [s, `${t(`cs.status.${s}`)} (${facets?.statuses[s] ?? 0})`]),
        )}
      </FilterToolbar>
      {data.error && <ErrorBox error={data.error} onRetry={data.reload} />}
      {data.loading && !data.data && <SkeletonRows rows={4} />}
      {data.data && (
        <div className="cs-list" role="table">
          <div className="cs-cols muted small" role="row">
            <span />
            <span>{t("cs.col.severity")}</span>
            <span>{t("cs.col.repo")}</span>
            <span>{t("cs.col.issue")}</span>
            <span>{t("cs.col.seen")}</span>
            <span>{t("cs.col.status")}</span>
          </div>
          {data.data.items.length === 0 && (
            <div className="cs-none muted small">
              {filtered ? t("cs.noMatch") : t("cs.emptyFindings")}
            </div>
          )}
          {data.data.items.map((f) => {
            const isOpen = open === f.id;
            return (
              <div
                key={f.id}
                className={`cs-row sev-${f.severity}${isOpen ? " is-open" : ""}`}
                role="row"
              >
                <button
                  type="button"
                  className="cs-head"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : f.id)}
                >
                  <ChevronRight size={14} className="cs-chev" />
                  <span className={`cs-chip sev-${f.severity}`}>{t(`cs.sev.${f.severity}`)}</span>
                  <span className="mono small cs-repo" title={f.repo}>
                    {f.repo || "—"}
                  </span>
                  <span className="cs-what">
                    <span className="cs-issue">{f.title}</span>
                    <span className="cs-sub">
                      <span className="cs-chip">{t(`cs.kind.${f.kind}`)}</span>
                      {f.file && (
                        <span className="mono small cs-loc">
                          {f.file}
                          {f.line ? `:${f.line}` : ""}
                        </span>
                      )}
                      {f.related_repos.length > 0 && (
                        <span className="muted small">
                          {t("cs.alsoIn", { repos: f.related_repos.join(", ") })}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="muted small cs-seen">
                    {t("cs.seenTimes", { n: f.occurrences })} · {ago(f.last_seen_at)}
                  </span>
                  <span className={`cs-status is-${f.display_status}`}>
                    {t(`cs.status.${f.display_status}`)}
                  </span>
                </button>
                {isOpen && <FindingPanel id={f.id} onChanged={data.reload} />}
              </div>
            );
          })}
        </div>
      )}
      {data.data && <Pager page={page} pages={pages} total={data.data.total} onPage={setPage} />}
    </div>
  );
}

/** A finding's description, evidence, related repositories, scan history, fix runs and the actions on it. */
function FindingPanel({ id, onChanged }: { id: number; onChanged: () => void }) {
  const { t } = useI18n();
  const d = useApi<FindingDetail>(`/api/code-findings/${id}`);
  const f = d.data;
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!f) return <SkeletonRows rows={2} />;
  const changed = () => {
    d.reload();
    onChanged();
  };
  const setStatus = async (status: "open" | "resolved" | "dismissed") => {
    let note = "";
    if (status === "dismissed") {
      const why = await dialog.prompt({
        title: t("cs.dismissTitle"),
        label: t("cs.dismissWhy"),
        required: true,
        confirmLabel: t("cs.dismiss"),
      });
      if (why === null) return;
      note = why.trim();
    }
    const ok = await act(() => api(`/api/code-findings/${id}/status`, { status, note }));
    if (ok) changed();
  };
  const fix = async () => {
    // A report-only finding waits for a person's decision (e.g. which errors are unrecoverable): ask for it.
    let decision: string | null = null;
    if (!f.implementable) {
      decision = await dialog.prompt({
        title: t("cs.decideTitle"),
        description: f.why_not ? t("cs.decideBody", { why: f.why_not }) : t("cs.decideBodyNoWhy"),
        label: t("cs.decision"),
        placeholder: t("cs.decisionPh"),
        required: true,
        confirmLabel: t("cs.fix"),
        validate: (v) => (v.trim().length < 10 ? t("cs.decisionTooShort") : null),
      });
      if (decision === null) return;
    } else {
      const ok = await dialog.confirm({
        title: t("cs.fixTitle"),
        description: t("cs.fixBody", { issue: f.issue }),
        confirmLabel: t("cs.fix"),
      });
      if (!ok) return;
    }
    const latest = f.sightings[0];
    const repoName = f.repo || latest?.selected_repositories[0] || "";
    const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
    const run = await act(() =>
      api<{ id: number }>("/api/runs", {
        workflow: FIX,
        repositories: [repoName],
        inputs: {
          repositories: [repoName],
          finding: {
            id: latest?.finding_key ?? String(f.id),
            fingerprint: f.fingerprint,
            scan_run_id: f.last_scan_run_id,
            kind: f.kind,
            severity: f.severity,
            title: f.title,
            repo: f.repo,
            related_repos: f.related_repos,
            file: f.file,
            line: f.line,
            symbol: f.symbol,
            issue: f.issue,
            evidence: f.evidence,
            implementable: f.implementable,
            why_not: f.why_not,
            code_evidence: f.code_evidence,
          },
          ...(decision ? { decision: decision.trim() } : {}),
          focus: `${t("cs.fixFocus")}: ${f.title}${where}`,
        },
        title: `${t("cs.fixFocus")} — ${f.title.slice(0, 80)}`,
      }),
    );
    if (run) navigate(`/runs/${run.id}`);
  };
  const active = f.fixes.find((x) => !TERMINAL.includes(x.status));
  const unverified = f.code_evidence?.status === "missing";
  return (
    <div className="cs-detail small">
      <p className="cs-desc">{f.issue}</p>
      {f.evidence && (
        <p>
          <b>{t("cs.evidence")}</b> <span className="cs-evidence">{f.evidence}</span>
        </p>
      )}
      {f.related_repos.length > 0 && (
        <p>
          <b>{t("cs.col.related")}:</b>{" "}
          {f.related_repos.map((r) => (
            <span key={r} className="cs-chip mono">
              {r}
            </span>
          ))}
        </p>
      )}
      {!f.implementable && (
        <p className="muted">
          {f.why_not ? t("cs.notFixable", { why: f.why_not }) : t("cs.reportOnly")}
        </p>
      )}
      {unverified && (
        <p className="cs-unverified">
          {t("cs.unverified")}: {f.code_evidence?.reason}
        </p>
      )}
      {f.status !== "open" && f.status_note && (
        <p className="muted">{t(`cs.note.${f.status}`, { note: f.status_note })}</p>
      )}
      {f.status === "open" && f.reopened_count > 0 && (
        <p className="cs-unverified">{t("cs.reopened", { note: f.status_note })}</p>
      )}

      <div className="cs-actions">
        {f.status === "open" &&
          !active &&
          (unverified ? (
            <span className="muted small" title={f.code_evidence?.reason}>
              {t("cs.unverifiedNoFix")}
            </span>
          ) : (
            <button
              type="button"
              className={f.implementable ? "xs" : "xs ghost"}
              onClick={fix}
              title={f.why_not}
            >
              <Wrench size={12} /> {f.implementable ? t("cs.fix") : t("cs.fixWithDecision")}
            </button>
          ))}
        {f.status === "open" ? (
          <>
            <button type="button" className="xs ghost" onClick={() => setStatus("resolved")}>
              <Check size={12} /> {t("cs.resolve")}
            </button>
            <button
              type="button"
              className="xs ghost danger"
              onClick={() => setStatus("dismissed")}
            >
              <X size={12} /> {t("cs.dismiss")}
            </button>
          </>
        ) : (
          <button type="button" className="xs ghost" onClick={() => setStatus("open")}>
            <RotateCcw size={12} /> {t("cs.reopen")}
          </button>
        )}
      </div>

      {f.fixes.length > 0 && (
        <section className="cs-sub-list">
          <h4>{t("cs.fixRuns")}</h4>
          <ul>
            {f.fixes.map((x) => (
              <li key={x.id}>
                <FixState fix={{ run_id: x.id, status: x.status, steps: x.steps }} />
                <span className="muted">
                  #{x.id} · {ago(x.created_at)}
                  {x.decision ? ` · ${t("cs.decision")}: ${x.decision}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="cs-sub-list">
        <h4>{t("cs.scanHistory", { n: f.sightings.length })}</h4>
        <ul>
          {f.sightings.map((s) => (
            <li key={s.scan_run_id}>
              <a href={`#/runs/${s.scan_run_id}`} className="mono">
                #{s.scan_run_id}
              </a>
              <span className={`cs-chip sev-${s.severity}`}>{t(`cs.sev.${s.severity}`)}</span>
              <span className="muted">{ago(s.seen_at)}</span>
              {s.evidence && <span className="cs-evidence muted">{s.evidence}</span>}
            </li>
          ))}
        </ul>
      </section>
      <p className="muted mono">{f.fingerprint}</p>
    </div>
  );
}
