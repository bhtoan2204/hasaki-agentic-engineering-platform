import { useEffect, useMemo, useState } from "react";
import { Bot, ChevronRight, ExternalLink, Hand, Play, ScanSearch, Wrench } from "lucide-react";
import { api, useApi, useLive } from "../../api.ts";
import { dialog } from "../../dialog/index.ts";
import { useI18n } from "../../i18n/index.tsx";
import {
  act,
  ago,
  EmptyState,
  ErrorBox,
  FilterField,
  FilterToolbar,
  SearchInput,
  SkeletonRows,
  navigate,
  toast,
} from "../../ui.tsx";
import { AssessProgressCard, type AssessProgress } from "../ScanProgress.tsx";
import "./code-scan.css";

type Finding = {
  id: string;
  kind: string;
  severity: string;
  repo?: string;
  file?: string;
  line?: number;
  issue: string;
  evidence?: string;
  implementable?: boolean;
  why_not?: string;
  code_evidence?: { status: "verified" | "missing"; reason?: string };
  related_repos?: string[];
};
type Fix = {
  finding_id: string;
  run_id: number;
  status: string;
  steps: Array<{ key: string; status: string }> | null;
};
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
  findings: Finding[] | null;
  fixes: Fix[] | null;
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
 * Agent code assessment: a read-only codebase-assessment run lists what the agent found in the code (severity,
 * location, evidence); a person picks a finding and starts a codebase-improvement run on exactly that finding
 * (blast radius, approval, before/after test, independent review).
 */
export function CodeScan() {
  const { t } = useI18n();
  const repos =
    useApi<Array<{ name: string; enabled: boolean; self?: boolean; projects?: string[] }>>(
      "/api/repositories",
    );
  const scans = useApi<Scan[]>("/api/code-scans");
  useLive(null, (p) => (!p || p.kind === "status") && scans.reload());
  const running = (scans.data ?? []).some((x) => !TERMINAL.includes(x.status));
  const reloadScans = scans.reload;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => reloadScans(), 4000);
    return () => clearInterval(id);
  }, [running, reloadScans]);
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

  const assess = async (force = false): Promise<void> => {
    const text = focus.trim();
    const subject = repo || project;
    const res = await act(() =>
      api<
        { started: true; run_id: number } | { reused: "running" | "same_commits"; run_id: number }
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
    if ("started" in res) {
      setFocus("");
      toast.success(t("cs.started"));
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
  const fix = async (scan: Scan, f: Finding) => {
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
    const repoName = repoOf(f, scan.selected_repositories) || scan.selected_repositories[0];
    const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
    const run = await act(() =>
      api<{ id: number }>("/api/runs", {
        workflow: FIX,
        repositories: [repoName],
        inputs: {
          repositories: [repoName],
          finding: { ...f, scan_run_id: scan.id },
          ...(decision ? { decision: decision.trim() } : {}),
          focus: `${t("cs.fixFocus")} ${f.id}: ${f.issue}${where}`,
        },
        title: `${t("cs.fixFocus")} ${f.id} — ${f.issue.slice(0, 80)}`,
      }),
    );
    if (run) navigate(`/runs/${run.id}`);
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
          <button disabled={!targets.length} onClick={() => assess()}>
            <ScanSearch size={15} strokeWidth={2} />
            {t("cs.scan")}
          </button>
        </div>
      </section>

      {scans.error && <ErrorBox error={scans.error} onRetry={scans.reload} />}
      {scans.loading && !scans.data && <SkeletonRows rows={3} />}
      {scans.data && scans.data.length === 0 && (
        <EmptyState icon={ScanSearch} title={t("cs.empty")}>
          {t("cs.emptyBody")}
        </EmptyState>
      )}
      {(scans.data ?? []).map((scan) => (
        <ScanCard key={scan.id} scan={scan} onFix={(f) => fix(scan, f)} />
      ))}
    </div>
  );
}

function FixState({ fix }: { fix: Fix }) {
  const { t } = useI18n();
  const step = (key: string) => fix.steps?.find((s) => s.key === key)?.status;
  if (step("approve") === "WAITING_APPROVAL")
    return (
      <button className="xs" onClick={() => navigate(`/runs/${fix.run_id}/approve`)}>
        <Hand size={12} /> {t("cs.approve")}
      </button>
    );
  if (step("pr") === "WAITING_APPROVAL")
    return (
      <button className="xs" onClick={() => navigate(`/runs/${fix.run_id}/pr`)}>
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
    <button className="xs ghost" onClick={() => navigate(`/runs/${fix.run_id}`)}>
      <Play size={12} /> {label}
    </button>
  );
}

function ScanCard({ scan, onFix }: { scan: Scan; onFix: (f: Finding) => void }) {
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
      {findings.length > 0 && <FindingsTable scan={scan} findings={findings} onFix={onFix} />}
    </section>
  );
}

type Status = "needs_look" | "in_progress" | "fixed" | "report_only" | "unverified";
const STATUSES: Status[] = ["needs_look", "in_progress", "fixed", "report_only", "unverified"];

function statusOf(f: Finding, fix: Fix | undefined): Status {
  if (fix) return fix.status === "COMPLETED" ? "fixed" : "in_progress";
  if (f.code_evidence?.status === "missing") return "unverified";
  return f.implementable ? "needs_look" : "report_only";
}

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, repo: string) =>
  new RegExp(`(^|[^\\w.-])${escaped(repo)}([^\\w-]|$)`).test(text);

/**
 * The repository a finding's code is in: the agent's `repo`, else the selected repository its evidence names
 * (`repo@commit` or plain), else the only selected one. Older scans did not ask for `repo`.
 */
export function repoOf(f: Finding, selected: string[]): string {
  if (f.repo) return f.repo;
  const text = `${f.evidence ?? ""} ${f.issue} ${f.file ?? ""}`;
  return selected.find((r) => mentions(text, r)) ?? (selected.length === 1 ? selected[0] : "");
}

/** The other selected repositories the finding names or the agent listed as affected by the same defect. */
export function relatedReposOf(f: Finding, own: string, selected: string[]): string[] {
  const text = `${f.issue} ${f.evidence ?? ""} ${f.why_not ?? ""}`;
  const named = selected.filter((r) => mentions(text, r));
  return [...new Set([...(f.related_repos ?? []), ...named])].filter((r) => r && r !== own);
}

function FindingsTable({
  scan,
  findings,
  onFix,
}: {
  scan: Scan;
  findings: Finding[];
  onFix: (f: Finding) => void;
}) {
  const { t } = useI18n();
  const [repo, setRepo] = useState("");
  const [sev, setSev] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(
    () =>
      findings.map((f) => {
        const fix = scan.fixes?.find((x) => x.finding_id === f.id);
        const own = repoOf(f, scan.selected_repositories);
        return {
          f,
          fix,
          repo: own,
          related: relatedReposOf(f, own, scan.selected_repositories),
          status: statusOf(f, fix),
        };
      }),
    [findings, scan.fixes, scan.selected_repositories],
  );
  const repos = [...new Set(rows.flatMap((r) => [r.repo, ...r.related]).filter(Boolean))].sort();
  const kinds = [...new Set(rows.map((r) => r.f.kind))];
  const q = query.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (!repo || r.repo === repo || r.related.includes(repo)) &&
      (!sev || r.f.severity === sev) &&
      (!kind || r.f.kind === kind) &&
      (!status || r.status === status) &&
      (!q ||
        [r.f.issue, r.f.evidence, r.f.file, r.repo, r.f.id]
          .filter(Boolean)
          .some((x) => String(x).toLowerCase().includes(q))),
  );
  const count = (s: Status) => rows.filter((r) => r.status === s).length;
  return (
    <div className="cs-table-wrap">
      <FilterToolbar
        className="cs-filters"
        secondary={
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t("cs.searchFindings")}
            width="100%"
          />
        }
      >
        <FilterField label={t("cs.col.repo")}>
          <select
            aria-label={t("cs.col.repo")}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          >
            <option value="">{t("an.all")}</option>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label={t("cs.col.severity")}>
          <select
            aria-label={t("cs.col.severity")}
            value={sev}
            onChange={(e) => setSev(e.target.value)}
          >
            <option value="">{t("an.all")}</option>
            {SEVERITY_ORDER.map((s) => (
              <option key={s} value={s}>
                {t(`cs.sev.${s}`)}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label={t("cs.col.kind")}>
          <select
            aria-label={t("cs.col.kind")}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">{t("an.all")}</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {t(`cs.kind.${k}`)}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label={t("cs.col.status")}>
          <select
            aria-label={t("cs.col.status")}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">{t("an.all")}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`cs.status.${s}`)} ({count(s)})
              </option>
            ))}
          </select>
        </FilterField>
      </FilterToolbar>
      <div className="cs-list" role="table">
        <div className="cs-cols muted small" role="row">
          <span />
          <span>{t("cs.col.severity")}</span>
          <span>{t("cs.col.repo")}</span>
          <span>{t("cs.col.issue")}</span>
          <span>{t("cs.col.related")}</span>
          <span>{t("cs.col.status")}</span>
          <span />
        </div>
        {shown.length === 0 && <div className="cs-none muted small">{t("cs.noMatch")}</div>}
        {shown.map(({ f, fix, repo: own, related, status: st }) => {
          const isOpen = open === f.id;
          return (
            <div
              key={f.id}
              className={`cs-row sev-${f.severity}${isOpen ? " is-open" : ""}`}
              role="row"
            >
              <button
                className="cs-head"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : f.id)}
              >
                <ChevronRight size={14} className="cs-chev" />
                <span className={`cs-chip sev-${f.severity}`}>{t(`cs.sev.${f.severity}`)}</span>
                <span className="mono small cs-repo" title={own}>
                  {own || "—"}
                </span>
                <span className="cs-what">
                  <span className="cs-issue">{f.issue}</span>
                  <span className="cs-sub">
                    <span className="cs-chip">{t(`cs.kind.${f.kind}`)}</span>
                    {f.file && (
                      <span className="mono small cs-loc">
                        {f.file}
                        {f.line ? `:${f.line}` : ""}
                      </span>
                    )}
                  </span>
                </span>
                <span className="cs-related">
                  {related.length ? (
                    related.map((r) => (
                      <span key={r} className="cs-chip mono">
                        {r}
                      </span>
                    ))
                  ) : (
                    <span className="muted small">—</span>
                  )}
                </span>
                <span className={`cs-status is-${st}`}>{t(`cs.status.${st}`)}</span>
              </button>
              <div className="cs-act">
                {fix ? (
                  <FixState fix={fix} />
                ) : f.code_evidence?.status === "missing" ? (
                  <span className="muted small" title={f.code_evidence.reason}>
                    {t("cs.unverifiedNoFix")}
                  </span>
                ) : f.implementable ? (
                  <button className="xs" onClick={() => onFix(f)}>
                    <Wrench size={12} /> {t("cs.fix")}
                  </button>
                ) : (
                  <button className="xs ghost" onClick={() => onFix(f)} title={f.why_not}>
                    <Wrench size={12} /> {t("cs.fixWithDecision")}
                  </button>
                )}
              </div>
              {isOpen && (
                <div className="cs-detail small">
                  {f.evidence && (
                    <p>
                      <b>{t("cs.evidence")}</b> <span className="cs-evidence">{f.evidence}</span>
                    </p>
                  )}
                  {!f.implementable && (
                    <p className="muted">
                      {f.why_not ? t("cs.notFixable", { why: f.why_not }) : t("cs.reportOnly")}
                    </p>
                  )}
                  {f.code_evidence?.status === "missing" && (
                    <p className="cs-unverified">
                      {t("cs.unverified")}: {f.code_evidence.reason}
                    </p>
                  )}
                  <p className="muted mono">{f.id}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
