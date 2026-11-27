import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Building2,
  CheckCircle2,
  Clock,
  Coins,
  HeartPulse,
  Inbox,
  PlayCircle,
  RefreshCw,
  ShieldCheck,
  UserRound,
  Wrench,
  XCircle,
} from "lucide-react";
import { api, useApi, useLive } from "../api.ts";
import { BRAND } from "../brand/brand.ts";
import { ago, Badge, EmptyState, ErrorBox, navigate, StatCard } from "../ui.tsx";
import { uiLocale, useI18n } from "../i18n/index.tsx";
import { ChibiAgent } from "../office/ChibiAgent.tsx";
import { OfficeScene } from "../office/OfficeScene.tsx";
import { useNow, useOfficeExecutionState } from "../office/useOfficeExecutionState.ts";
import { mapOffice } from "../office/workflowToAgentMapper.ts";
import type { OfficeSnapshot } from "../office/types.ts";
import "../office/office.css";
import { TimesheetCard } from "./OverviewTimesheet.tsx";
import "./Overview.css";

const EMPTY: OfficeSnapshot = {
  run: null,
  steps: [],
  graph: [],
  attempts: [],
  questions: [],
  events: {},
};
const ACTIVE = ["RUNNING", "WAITING", "PAUSED"];

type OverviewRun = {
  id: number;
  status: string;
  title: string;
  definition_key: string;
  updated_at: string;
  open_questions: number;
  steps: Array<{ status: string }> | null;
};
type OverviewQuestion = { run_id: number; step_key: string; question: string | null };
type MetricsSummary = {
  evaluation?: {
    verification?: {
      pass_rate_pct: number | null;
      passed: number;
      verified: number;
      accepted_preexisting?: number;
      avg_repairs: number | null;
      stopped_no_progress?: number;
      repair_budget_exhausted?: number;
    };
    human_intervention: { rate_pct: number | null; answers?: number; reexecutions?: number };
  };
  by_profile?: Array<{ runs?: number; avg_wall_min?: number | null }>;
  by_workflow?: Array<{ cost_usd?: number | null }>;
};
type AttemptVerification = {
  status?: string;
  outcome?: string;
  passed?: boolean;
  needs_review?: boolean;
  rounds?: number;
  repairs?: number;
  reason?: string;
};
type RunAttempts = {
  id: number;
  attempts?: Array<{
    step_key: string;
    number: number;
    started_at: string | null;
    finished_at: string | null;
    metrics?: { verification?: AttemptVerification } | null;
  }>;
};
type VerificationRow = {
  run: number;
  step: string;
  n: number;
  at: string | null;
  v: AttemptVerification;
};
const fmt = (n: number | null | undefined, d = 0) =>
  n == null || Number.isNaN(n)
    ? "—"
    : n.toLocaleString(uiLocale() === "vi" ? "vi-VN" : "en-GB", {
        maximumFractionDigits: d,
      });

/** Landing dashboard: real workflow activity, a live mini office, recent work and harness health. */
export function OverviewPage() {
  const { t } = useI18n();
  const { data: runs, error: runsError, reload: reloadRuns } = useApi<OverviewRun[]>("/api/runs");
  const {
    data: questions,
    error: qError,
    reload: reloadQ,
  } = useApi<OverviewQuestion[]>("/api/questions");
  const {
    data: metrics,
    error: mError,
    reload: reloadM,
  } = useApi<MetricsSummary>("/api/metrics/summary?days=30");
  useLive(null, (p) => {
    if (!p || p.kind === "status") void (reloadRuns(), reloadQ());
  });
  useEffect(() => {
    // 30-day aggregates: a minute-old figure is fine, and nobody needs it in a hidden tab.
    const t = setInterval(() => document.visibilityState === "visible" && void reloadM(), 60_000);
    return () => clearInterval(t);
  }, [reloadM]);

  const list = Array.isArray(runs) ? runs : [];
  const qList = Array.isArray(questions) ? questions : [];
  const active = list.filter((r) => ACTIVE.includes(r.status));
  const officeRun = active[0]?.id ?? null;
  const counts = {
    running: list.filter((r) => r.status === "RUNNING").length,
    waiting: list.filter(
      (r) => r.status === "WAITING" || r.status === "PAUSED" || r.open_questions > 0,
    ).length,
    completed: list.filter((r) => r.status === "COMPLETED").length,
    failed: list.filter((r) => r.status === "FAILED").length,
  };

  return (
    <div className="ov">
      <Hero active={active.length} waiting={qList.length} />

      {(runsError || qError || mError) && (
        <ErrorBox
          error={runsError || qError || mError || ""}
          onRetry={() => {
            if (runsError) reloadRuns();
            if (qError) reloadQ();
            if (mError) reloadM();
          }}
        />
      )}

      <section aria-label={t("ov.activity")} className="grid4 ov-stats">
        <StatCard
          icon={Activity}
          tone="run"
          label={t("status.RUNNING")}
          value={runs ? counts.running : null}
          hint={active.length ? t("ov.activeRuns", { n: active.length }) : t("office.none")}
          onClick={() => navigate("/runs")}
        />
        <StatCard
          icon={Inbox}
          tone="wait"
          label={t("ov.waitingYou")}
          value={runs ? counts.waiting : null}
          hint={t("ov.openQuestions", { n: qList.length })}
          onClick={() => navigate("/questions")}
        />
        <StatCard
          icon={CheckCircle2}
          tone="ok"
          label={t("status.COMPLETED")}
          value={runs ? counts.completed : null}
          hint={t("ov.ofRecent", { n: list.length })}
          onClick={() => navigate("/runs")}
        />
        <StatCard
          icon={XCircle}
          tone="err"
          label={t("status.FAILED")}
          value={runs ? counts.failed : null}
          hint={t("ov.needsReview")}
          onClick={() => navigate("/runs")}
        />
      </section>

      <div className="ov-main">
        {/* Two columns of similar height: the attendance table is tall, so the office, inbox and health stack against it. */}
        <div className="stack">
          <MiniOffice runId={officeRun} />
          <ActionInbox questions={qList} />
          <HarnessHealth m={metrics} />
        </div>
        <div className="stack">
          <TimesheetCard />
        </div>
      </div>

      <div className="ov-bottom">
        <RecentRuns runs={list.slice(0, 7)} />
        <RecentVerification runs={list.slice(0, 6)} />
      </div>
    </div>
  );
}

function Hero({ active, waiting }: { active: number; waiting: number }) {
  const { t } = useI18n();
  return (
    <section className="ov-hero card">
      <div className="ov-hero-text">
        <div className="ov-hero-kicker">{BRAND.tagline}</div>
        <h1>{t("ov.welcome", { product: BRAND.product })}</h1>
        <p>
          {active ? (
            <>
              {t("ov.heroActive", { n: active })}
              {waiting ? <> {t("ov.heroWaiting", { n: waiting })}</> : ""}. {t("ov.heroOffice")}
            </>
          ) : (
            <>{t("ov.heroEmpty")}</>
          )}
        </p>
        <div className="row">
          <a className="btn" href="#/work-items">
            <PlayCircle size={16} /> {t("ov.start")}
          </a>
          <a className="btn ghost" href="#/office">
            <Building2 size={16} /> {t("ov.enterOffice")}
          </a>
          {waiting > 0 && (
            <a className="btn ghost" href="#/questions">
              <Inbox size={16} /> {t("ov.answerN", { n: waiting })}
            </a>
          )}
        </div>
      </div>
      <div className="ov-mascot" aria-hidden>
        <svg viewBox="-6 -10 42 54" shapeRendering="crispEdges" className="office">
          <ellipse cx={15} cy={39} rx={11} ry={2} fill="rgba(160, 60, 40, .16)" />
          <ChibiAgent role="pr" pose="greet" activity={null} x={0} y={0} walking={false} />
        </svg>
        <div className="ov-mascot-bubble">{t("ov.hello")}</div>
      </div>
    </section>
  );
}

function MiniOffice({ runId }: { runId: number | null }) {
  const { t, locale } = useI18n();
  const { snapshot } = useOfficeExecutionState(runId, null);
  const now = useNow(1000);
  const snap = snapshot ?? EMPTY;
  const agents = useMemo(() => mapOffice(snap, now, locale), [snap, now, locale]);
  const working = agents.filter((a) => a.pose === "work").length;
  const waiting = agents.filter((a) => a.pose === "ask" || a.pose === "approval").length;
  return (
    <section className="card ov-office">
      <div className="card-head">
        <Building2 size={18} color="var(--brand)" />
        <h4>{t("nav.office")}</h4>
        <span className="sub">
          {snap.run ? (
            <span className="ov-sub-meta">
              <span>{t("common.runN", { id: snap.run.id })}</span>
              <span>{t("ov.working", { n: working })}</span>
              {waiting > 0 && <span>{t("ov.needYou", { n: waiting })}</span>}
            </span>
          ) : (
            t("ov.officeIdle")
          )}
        </span>
        <a className="btn ghost sm" href={runId ? `#/office/${runId}` : "#/office"}>
          {t("ov.expand")} <ArrowRight size={14} />
        </a>
      </div>
      <div
        className="office office--mini"
        onClick={() => navigate(runId ? `/office/${runId}` : "/office")}
        role="link"
        tabIndex={0}
        aria-label={t("ov.openOffice")}
        onKeyDown={(e) => e.key === "Enter" && navigate(runId ? `/office/${runId}` : "/office")}
      >
        <OfficeScene
          agents={agents}
          now={now}
          still={false}
          selected={null}
          onSelect={() => navigate(runId ? `/office/${runId}` : "/office")}
          showBubbles={!!snap.run}
        />
      </div>
      <p className="small muted ov-note">{t("ov.officeNote")}</p>
    </section>
  );
}

function ActionInbox({ questions }: { questions: OverviewQuestion[] }) {
  const { t } = useI18n();
  const qList = Array.isArray(questions) ? questions : [];
  const byStep = new Map<string, OverviewQuestion[]>();
  for (const q of qList)
    byStep.set(`${q.run_id}/${q.step_key}`, [
      ...(byStep.get(`${q.run_id}/${q.step_key}`) ?? []),
      q,
    ]);
  return (
    <section className="card ov-inbox">
      <div className="card-head">
        <Inbox size={18} color="var(--st-wait)" />
        <h4>{t("inbox.tip")}</h4>
        <a className="small" href="#/questions">
          {t("ov.seeAll")}
        </a>
      </div>
      {byStep.size === 0 ? (
        <div className="ov-inbox-empty">
          <BadgeCheck size={18} color="var(--st-ok)" /> {t("ov.noQuestions")}
        </div>
      ) : (
        <ul className="ov-list">
          {[...byStep.entries()].slice(0, 4).map(([k, qs]) => (
            <li key={k}>
              <a href={`#/runs/${qs[0].run_id}/${encodeURIComponent(qs[0].step_key)}`}>
                <span className="ov-dot wait" />
                <span className="ov-li-main">
                  <b>
                    {t("common.runN", { id: qs[0].run_id })} / {qs[0].step_key}
                  </b>
                  <span className="muted small ov-li-meta">
                    <span>{t("office.bubble.questions", { n: qs.length })}</span>
                    <span>{String(qs[0].question ?? "").slice(0, 90)}</span>
                  </span>
                </span>
                <ArrowRight size={15} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HarnessHealth({ m }: { m: MetricsSummary | null }) {
  const { t } = useI18n();
  const e = m?.evaluation;
  const v = e?.verification;
  const runs = m?.by_profile ?? [];
  const totalRuns = runs.reduce((s, r) => s + (r.runs ?? 0), 0);
  const avgWall = totalRuns
    ? runs.reduce((s, r) => s + Number(r.avg_wall_min ?? 0) * (r.runs ?? 0), 0) / totalRuns
    : null;
  const cost = (m?.by_workflow ?? []).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  const rows: Array<[typeof ShieldCheck, string, string, string?]> = [
    [
      ShieldCheck,
      t("ov.health.pass"),
      v?.pass_rate_pct != null ? `${v.pass_rate_pct}%` : "—",
      v
        ? t("ov.health.passHint", {
            passed: v.passed,
            verified: v.verified,
            extra: v.accepted_preexisting
              ? t("ov.health.preexisting", { n: v.accepted_preexisting })
              : "",
          })
        : t("ov.health.noData"),
    ],
    [
      Wrench,
      t("ov.health.repairs"),
      v?.avg_repairs != null ? fmt(Number(v.avg_repairs), 2) : "—",
      v
        ? t("ov.health.repairsHint", {
            stopped: v.stopped_no_progress ?? 0,
            exhausted: v.repair_budget_exhausted ?? 0,
          })
        : undefined,
    ],
    [
      Clock,
      t("ov.health.time"),
      avgWall != null && totalRuns ? t("ov.health.minutes", { n: fmt(avgWall, 1) }) : "—",
      totalRuns ? t("ov.health.runs30", { n: totalRuns }) : undefined,
    ],
    [Coins, t("ov.health.cost"), m ? `$${fmt(cost, 2)}` : "—", t("ov.health.costHint")],
    [
      UserRound,
      t("ov.health.human"),
      e?.human_intervention?.rate_pct != null ? `${e.human_intervention.rate_pct}%` : "—",
      e
        ? t("ov.health.humanHint", {
            answers: e.human_intervention.answers ?? 0,
            reexec: e.human_intervention.reexecutions ?? 0,
          })
        : undefined,
    ],
  ];
  return (
    <section className="card ov-health">
      <div className="card-head">
        <HeartPulse size={18} color="var(--brand)" />
        <h4>{t("ov.health.title")}</h4>
        <a className="small" href="#/insights">
          {t("nav.insights")}
        </a>
      </div>
      {!m ? (
        <div className="stack" style={{ gap: 8 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton" style={{ height: 30 }} />
          ))}
        </div>
      ) : (
        <ul className="ov-health-list">
          {rows.map(([I, label, value, hint]) => (
            <li key={label}>
              <span className="ov-health-icon">
                <I size={15} />
              </span>
              <span className="ov-li-main">
                <span className="small">{label}</span>
                {hint && <span className="muted ov-hint">{hint}</span>}
              </span>
              <b>{value}</b>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentRuns({ runs }: { runs: OverviewRun[] }) {
  const { t } = useI18n();
  const runList = Array.isArray(runs) ? runs : [];
  return (
    <section className="card">
      <div className="card-head">
        <PlayCircle size={18} color="var(--brand)" />
        <h4>{t("ov.recent")}</h4>
        <a className="small" href="#/runs">
          {t("ov.allRuns")}
        </a>
      </div>
      {!runList.length ? (
        <EmptyState
          title={t("runs.emptyTitle")}
          action={
            <a className="btn sm" href="#/work-items">
              {t("ov.start")}
            </a>
          }
        >
          {t("ov.firstRun")}
        </EmptyState>
      ) : (
        <ul className="ov-list">
          {runList.map((r) => {
            const steps = (Array.isArray(r?.steps) ? r.steps : []) as Array<{
              status: string;
            }>;
            const done = steps.filter((s) => ["COMPLETED", "SKIPPED"].includes(s?.status)).length;
            return (
              <li key={r.id}>
                <a href={`#/runs/${r.id}`}>
                  <span className="ov-run-id">#{r.id}</span>
                  <span className="ov-li-main">
                    <b className="ov-ellipsis">{r.title}</b>
                    <span className="muted small ov-li-meta">
                      <span>{r.definition_key}</span>
                      <span>{t("common.ago", { when: ago(r.updated_at) })}</span>
                    </span>
                  </span>
                  <span
                    className="ov-run-progress"
                    title={t("runs.progressAria", {
                      done,
                      total: steps.length,
                    })}
                  >
                    <span className="progress">
                      <span
                        style={{
                          width: `${steps.length ? (done / steps.length) * 100 : 0}%`,
                          background: r.status === "FAILED" ? "var(--st-err)" : "var(--st-ok)",
                        }}
                      />
                    </span>
                  </span>
                  <Badge s={r.status} label />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Verification outcomes of the coding attempts in the latest runs (from attempt metrics; real data only). */
function RecentVerification({ runs }: { runs: OverviewRun[] }) {
  const { t } = useI18n();
  const runList = Array.isArray(runs) ? runs : [];
  const ids = runList.map((r) => r.id).join(",");
  const [rows, setRows] = useState<VerificationRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all(
      ids
        .split(",")
        .filter(Boolean)
        .slice(0, 6)
        .map((id) => api<RunAttempts>(`/api/runs/${id}`).catch(() => null)),
    ).then((details) => {
      if (!alive) return;
      const out: VerificationRow[] = [];
      for (const d of details) {
        if (!d) continue;
        for (const a of d.attempts ?? []) {
          const v = a.metrics?.verification;
          if (v)
            out.push({
              run: d.id,
              step: a.step_key,
              n: a.number,
              at: a.finished_at ?? a.started_at,
              v,
            });
        }
      }
      setRows(out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6));
    });
    return () => void (alive = false);
  }, [ids]);
  return (
    <section className="card">
      <div className="card-head">
        <ShieldCheck size={18} color="var(--brand)" />
        <h4>{t("ov.verify")}</h4>
        <span className="sub">{t("ov.verifySub")}</span>
      </div>
      {rows === null ? (
        <div className="stack" style={{ gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 36 }} />
          ))}
        </div>
      ) : !rows.length ? (
        <div className="ov-inbox-empty">
          <RefreshCw size={16} /> {t("ov.verifyEmpty")}
        </div>
      ) : (
        <ul className="ov-list">
          {rows.map((r) => {
            const status = String(r.v.status ?? r.v.outcome ?? "—");
            const tone =
              r.v.passed === true
                ? status === "accepted_with_preexisting" || r.v.needs_review
                  ? "WAITING"
                  : "COMPLETED"
                : r.v.passed === false
                  ? "FAILED"
                  : "PENDING";
            return (
              <li key={`${r.run}-${r.step}-${r.n}`}>
                <a href={`#/runs/${r.run}/${encodeURIComponent(r.step)}`}>
                  <span className="ov-li-main">
                    <b>
                      {t("common.runN", { id: r.run })} / {r.step} #{r.n}
                    </b>
                    <span className="muted small ov-li-meta">
                      <span>
                        {typeof r.v.rounds === "number"
                          ? t("ov.verifyRounds", {
                              rounds: r.v.rounds,
                              repairs: r.v.repairs ?? 0,
                            })
                          : (r.v.reason ?? "")}
                      </span>
                      {r.v.needs_review && <span>{t("ov.needsReview")}</span>}
                    </span>
                  </span>
                  <Badge s={tone}>{status}</Badge>
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {rows && rows.some((r) => r.v.passed === false) && (
        <div className="small ov-warn">
          <AlertTriangle size={14} /> {t("ov.verifyFail")}
        </div>
      )}
    </section>
  );
}
