import { useState } from "react";
import { Bot, ExternalLink, Hand, Play, ScanSearch, Wrench } from "lucide-react";
import { api, useApi, useLive } from "../../api.ts";
import { dialog } from "../../dialog/index.ts";
import { useI18n } from "../../i18n/index.tsx";
import { act, ago, EmptyState, ErrorBox, SkeletonRows, navigate } from "../../ui.tsx";
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
  selected: { finding_id?: string } | null;
  steps: Array<{ key: string; status: string }> | null;
};

const WORKFLOW = "codebase-improvement";
const SEVERITY_ORDER = ["high", "medium", "low"];
const ASSESSING = ["PENDING", "READY", "RUNNING", "RETRYING"];

/**
 * Agent code assessment: start a codebase-improvement run on a repository, read what the agent found in the code (with
 * its evidence), and hand one finding to the same workflow to fix it (approval, before/after test, independent review).
 */
export function CodeScan() {
  const { t } = useI18n();
  const repos =
    useApi<Array<{ name: string; enabled: boolean; self?: boolean }>>("/api/repositories");
  const scans = useApi<Scan[]>("/api/code-scans");
  useLive(null, (p) => (!p || p.kind === "status") && scans.reload());
  const [repo, setRepo] = useState("");
  const [focus, setFocus] = useState("");
  const available = (repos.data ?? []).filter((r) => r.enabled && !r.self);

  const start = async (repoName: string, focusText: string) => {
    const run = await act(
      () =>
        api<{ id: number }>("/api/runs", {
          workflow: WORKFLOW,
          repositories: [repoName],
          inputs: {
            repositories: [repoName],
            ...(focusText.trim() ? { focus: focusText.trim() } : {}),
          },
          title: `${t("cs.runTitle")} ${repoName}${focusText.trim() ? ` — ${focusText.trim().slice(0, 80)}` : ""}`,
        }),
      t("cs.started"),
    );
    if (run) scans.reload();
    return run;
  };
  const fix = async (scan: Scan, f: Finding) => {
    const ok = await dialog.confirm({
      title: t("cs.fixTitle"),
      description: t("cs.fixBody", { issue: f.issue }),
      confirmLabel: t("cs.fix"),
    });
    if (!ok) return;
    const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
    const run = await start(
      f.repo || scan.selected_repositories[0],
      `${t("cs.fixFocus")} ${f.id}: ${f.issue}${where}`,
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
            <span>{t("cs.repo")}</span>
            <select
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              aria-label={t("cs.repo")}
            >
              <option value="">{t("cs.pickRepo")}</option>
              {available.map((r) => (
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
            disabled={!repo}
            onClick={async () => {
              if (await start(repo, focus)) setFocus("");
            }}
          >
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

function ScanCard({ scan, onFix }: { scan: Scan; onFix: (f: Finding) => void }) {
  const { t } = useI18n();
  const step = (key: string) => scan.steps?.find((s) => s.key === key)?.status;
  const findings = [...(scan.findings ?? [])].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const counts = Object.fromEntries(
    SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length]),
  );
  const assessing = ASSESSING.includes(scan.assess_status);
  const selectedAction = () => {
    if (step("approve") === "WAITING_APPROVAL")
      return (
        <button className="xs" onClick={() => navigate(`/runs/${scan.id}/approve`)}>
          <Hand size={12} /> {t("cs.approve")}
        </button>
      );
    if (step("pr") === "WAITING_APPROVAL")
      return (
        <button className="xs" onClick={() => navigate(`/runs/${scan.id}/pr`)}>
          <ExternalLink size={12} /> {t("cs.prReady")}
        </button>
      );
    return (
      <button className="xs ghost" onClick={() => navigate(`/runs/${scan.id}`)}>
        <Play size={12} /> {t("cs.inRun")}
      </button>
    );
  };
  return (
    <section className="card cs-scan" data-testid="code-scan">
      <header className="cs-scan-head">
        <div className="cs-scan-title">
          <b>{scan.selected_repositories.join(", ")}</b>
          {scan.focus && <span className="muted small"> · {scan.focus}</span>}
        </div>
        <div className="cs-scan-meta">
          {assessing ? (
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
      {scan.summary && <p className="cs-summary">{scan.summary}</p>}
      {findings.length > 0 && (
        <ul className="cs-findings">
          {findings.map((f) => {
            const selected = scan.selected?.finding_id === f.id;
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
                  {selected ? (
                    selectedAction()
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
