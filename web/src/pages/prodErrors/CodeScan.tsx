import { useEffect, useMemo, useState } from "react";
import { Bot, ExternalLink, Hand, Play, ScanSearch, Wrench } from "lucide-react";
import { api, useApi, useLive } from "../../api.ts";
import { dialog } from "../../dialog/index.ts";
import { useI18n } from "../../i18n/index.tsx";
import { act, ago, EmptyState, ErrorBox, SkeletonRows, navigate } from "../../ui.tsx";
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

const ASSESS = "codebase-assessment";
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

  const assess = async () => {
    const text = focus.trim();
    const subject = repo || project;
    const run = await act(
      () =>
        api<{ id: number }>("/api/runs", {
          workflow: ASSESS,
          repositories: targets,
          inputs: {
            repositories: targets,
            ...(project ? { project } : {}),
            ...(text ? { focus: text } : {}),
          },
          title: `${t("cs.runTitle")} ${subject}${text ? ` — ${text.slice(0, 80)}` : ""}`,
        }),
      t("cs.started"),
    );
    if (run) {
      setFocus("");
      scans.reload();
    }
  };
  const fix = async (scan: Scan, f: Finding) => {
    const ok = await dialog.confirm({
      title: t("cs.fixTitle"),
      description: t("cs.fixBody", { issue: f.issue }),
      confirmLabel: t("cs.fix"),
    });
    if (!ok) return;
    const repoName = f.repo || scan.selected_repositories[0];
    const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
    const run = await act(() =>
      api<{ id: number }>("/api/runs", {
        workflow: FIX,
        repositories: [repoName],
        inputs: {
          repositories: [repoName],
          finding: { ...f, scan_run_id: scan.id },
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
          <button disabled={!targets.length} onClick={assess}>
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
  const label =
    fix.status === "COMPLETED"
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
  const fixOf = (id: string) => scan.fixes?.find((x) => x.finding_id === id);
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
      {findings.length > 0 && (
        <ul className="cs-findings">
          {findings.map((f) => {
            const fix = fixOf(f.id);
            return (
              <li key={f.id} className={`cs-finding sev-${f.severity}`}>
                <div className="cs-finding-main">
                  <div className="cs-finding-top">
                    <span className={`cs-chip sev-${f.severity}`}>{t(`cs.sev.${f.severity}`)}</span>
                    <span className="cs-chip">{t(`cs.kind.${f.kind}`)}</span>
                    {f.file && (
                      <span className="mono small cs-loc">
                        {f.file}
                        {f.line ? `:${f.line}` : ""}
                      </span>
                    )}
                  </div>
                  <div className="cs-issue">{f.issue}</div>
                  {f.evidence && <div className="muted small cs-evidence">{f.evidence}</div>}
                  {!f.implementable && (
                    <div className="muted small">
                      {f.why_not ? t("cs.notFixable", { why: f.why_not }) : t("cs.reportOnly")}
                    </div>
                  )}
                </div>
                <div className="cs-finding-act">
                  {fix ? (
                    <FixState fix={fix} />
                  ) : f.implementable ? (
                    <button className="xs" onClick={() => onFix(f)}>
                      <Wrench size={12} /> {t("cs.fix")}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
