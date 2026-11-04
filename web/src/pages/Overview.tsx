import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, ArrowRight, BadgeCheck, Building2, CheckCircle2, Clock, Coins, HeartPulse, Inbox, PlayCircle, RefreshCw, ShieldCheck, Sparkles, UserRound, Wrench, XCircle } from "lucide-react";
import { api, useApi, useLive } from "../api.ts";
import { BRAND } from "../brand/brand.ts";
import { ago, Badge, EmptyState, navigate, StatCard } from "../ui.tsx";
import { ChibiAgent } from "../office/ChibiAgent.tsx";
import { OfficeScene } from "../office/OfficeScene.tsx";
import { useNow, useOfficeExecutionState } from "../office/useOfficeExecutionState.ts";
import { mapOffice } from "../office/workflowToAgentMapper.ts";
import type { OfficeSnapshot } from "../office/types.ts";
import "../office/office.css";
import "./Overview.css";

const EMPTY: OfficeSnapshot = { run: null, steps: [], graph: [], attempts: [], questions: [], events: {} };
const ACTIVE = ["RUNNING", "WAITING", "PAUSED"];
const fmt = (n: number | null | undefined, d = 0) => (n == null || Number.isNaN(n) ? "—" : n.toLocaleString("vi-VN", { maximumFractionDigits: d }));

/** Landing dashboard: real workflow activity, a live mini office, recent work and harness health. */
export function OverviewPage() {
  const { data: runs, reload: reloadRuns } = useApi<any[]>("/api/runs");
  const { data: questions, reload: reloadQ } = useApi<any[]>("/api/questions");
  const { data: metrics, reload: reloadM } = useApi<any>("/api/metrics/summary?days=30");
  useLive(null, (p) => {
    if (!p || p.kind === "status") void (reloadRuns(), reloadQ());
  });
  useEffect(() => {
    const t = setInterval(() => void reloadM(), 60_000);
    return () => clearInterval(t);
  }, [reloadM]);

  const list = runs ?? [];
  const active = list.filter((r) => ACTIVE.includes(r.status));
  const officeRun = active[0]?.id ?? null;
  const counts = {
    running: list.filter((r) => r.status === "RUNNING").length,
    waiting: list.filter((r) => r.status === "WAITING" || r.status === "PAUSED" || r.open_questions > 0).length,
    completed: list.filter((r) => r.status === "COMPLETED").length,
    failed: list.filter((r) => r.status === "FAILED").length,
  };

  return (
    <div className="ov">
      <Hero active={active.length} waiting={(questions ?? []).length} />

      <section aria-label="Hoạt động workflow" className="grid4 ov-stats">
        <StatCard icon={Activity} tone="run" label="Đang chạy" value={runs ? counts.running : null} hint={active.length ? `${active.length} run đang hoạt động` : "Không có run nào đang chạy"} onClick={() => navigate("/runs")} />
        <StatCard icon={Inbox} tone="wait" label="Chờ bạn" value={runs ? counts.waiting : null} hint={`${(questions ?? []).length} câu hỏi đang mở`} onClick={() => navigate("/questions")} />
        <StatCard icon={CheckCircle2} tone="ok" label="Hoàn thành" value={runs ? counts.completed : null} hint={`trên ${list.length} run gần nhất`} onClick={() => navigate("/runs")} />
        <StatCard icon={XCircle} tone="err" label="Lỗi" value={runs ? counts.failed : null} hint="cần xem lại" onClick={() => navigate("/runs")} />
      </section>

      <div className="ov-main">
        <MiniOffice runId={officeRun} />
        <div className="stack">
          <ActionInbox questions={questions ?? []} />
          <HarnessHealth m={metrics} />
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
  return (
    <section className="ov-hero card hero">
      <div className="ov-hero-text">
        <div className="ov-hero-kicker"><Sparkles size={14} /> {BRAND.tagline}</div>
        <h1>Welcome to {BRAND.product}</h1>
        <p>
          {active
            ? <>Đang có <b>{active}</b> workflow hoạt động{waiting ? <>, <b>{waiting}</b> câu hỏi đang chờ bạn</> : ""}. Đội AI đang làm việc trong văn phòng.</>
            : <>Chưa có workflow nào đang chạy. Chọn một work item để giao việc cho đội AI — phân tích, code, test, review và mở PR.</>}
        </p>
        <div className="row">
          <a className="btn" href="#/work-items"><PlayCircle size={16} /> Bắt đầu workflow</a>
          <a className="btn ghost" href="#/office"><Building2 size={16} /> Vào Agent Office</a>
          {waiting > 0 && <a className="btn ghost" href="#/questions"><Inbox size={16} /> Trả lời {waiting} câu hỏi</a>}
        </div>
      </div>
      <div className="ov-mascot" aria-hidden>
        <svg viewBox="-6 -10 42 54" shapeRendering="crispEdges" className="office">
          <ellipse cx={15} cy={39} rx={11} ry={2} fill="rgba(160, 60, 40, .16)" />
          <ChibiAgent role="pr" pose="greet" activity={null} x={0} y={0} walking={false} />
        </svg>
        <div className="ov-mascot-bubble">Xin chào! 👋</div>
      </div>
    </section>
  );
}

function MiniOffice({ runId }: { runId: number | null }) {
  const { snapshot } = useOfficeExecutionState(runId, null);
  const now = useNow(1000);
  const snap = snapshot ?? EMPTY;
  const agents = useMemo(() => mapOffice(snap, now), [snap, now]);
  const working = agents.filter((a) => a.pose === "work").length;
  const waiting = agents.filter((a) => a.pose === "ask" || a.pose === "approval").length;
  return (
    <section className="card ov-office">
      <div className="card-head">
        <Building2 size={18} color="var(--brand)" />
        <h4>Agent Office</h4>
        <span className="sub">{snap.run ? <>Run #{snap.run.id} · {working} đang làm{waiting ? ` · ${waiting} cần bạn` : ""}</> : "Văn phòng đang nghỉ — không có run nào chạy"}</span>
        <a className="btn ghost sm" href={runId ? `#/office/${runId}` : "#/office"}>Mở rộng <ArrowRight size={14} /></a>
      </div>
      <div className="office office--mini" onClick={() => navigate(runId ? `/office/${runId}` : "/office")} role="link" tabIndex={0} aria-label="Mở Agent Office" onKeyDown={(e) => e.key === "Enter" && navigate(runId ? `/office/${runId}` : "/office")}>
        <OfficeScene agents={agents} now={now} still={false} selected={null} onSelect={() => navigate(runId ? `/office/${runId}` : "/office")} showBubbles={!!snap.run} />
      </div>
      <p className="small muted ov-note">Mỗi nhân vật là một vai trò logic của workflow; trạng thái lấy từ dữ liệu thật của run.</p>
    </section>
  );
}

function ActionInbox({ questions }: { questions: any[] }) {
  const byStep = new Map<string, any[]>();
  for (const q of questions) byStep.set(`${q.run_id}/${q.step_key}`, [...(byStep.get(`${q.run_id}/${q.step_key}`) ?? []), q]);
  return (
    <section className="card ov-inbox">
      <div className="card-head"><Inbox size={18} color="var(--st-wait)" /><h4>Cần bạn xử lý</h4><a className="small" href="#/questions">Xem tất cả</a></div>
      {byStep.size === 0 ? (
        <div className="ov-inbox-empty"><BadgeCheck size={18} color="var(--st-ok)" /> Không có câu hỏi nào đang chờ.</div>
      ) : (
        <ul className="ov-list">
          {[...byStep.entries()].slice(0, 4).map(([k, qs]) => (
            <li key={k}>
              <a href={`#/runs/${qs[0].run_id}/${encodeURIComponent(qs[0].step_key)}`}>
                <span className="ov-dot wait" />
                <span className="ov-li-main"><b>Run #{qs[0].run_id} · {qs[0].step_key}</b><span className="muted small">{qs.length} câu hỏi · {String(qs[0].question ?? "").slice(0, 90)}</span></span>
                <ArrowRight size={15} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HarnessHealth({ m }: { m: any }) {
  const e = m?.evaluation;
  const v = e?.verification;
  const runs = (m?.by_profile ?? []) as any[];
  const totalRuns = runs.reduce((s, r) => s + (r.runs ?? 0), 0);
  const avgWall = totalRuns ? runs.reduce((s, r) => s + Number(r.avg_wall_min ?? 0) * (r.runs ?? 0), 0) / totalRuns : null;
  const cost = ((m?.by_workflow ?? []) as any[]).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  const rows: Array<[typeof ShieldCheck, string, string, string?]> = [
    [ShieldCheck, "Verification pass", v?.pass_rate_pct != null ? `${v.pass_rate_pct}%` : "—", v ? `${v.passed}/${v.verified} coding attempt${v.accepted_preexisting ? ` · ${v.accepted_preexisting} kèm lỗi có sẵn` : ""}` : "chưa có dữ liệu"],
    [Wrench, "Repairs / attempt", v?.avg_repairs != null ? fmt(Number(v.avg_repairs), 2) : "—", v ? `${v.stopped_no_progress ?? 0} dừng vì không tiến triển · ${v.repair_budget_exhausted ?? 0} hết lượt` : undefined],
    [Clock, "Thời gian / run", avgWall != null && totalRuns ? `${fmt(avgWall, 1)} phút` : "—", totalRuns ? `${totalRuns} run trong 30 ngày` : undefined],
    [Coins, "Chi phí agent (30 ngày)", m ? `$${fmt(cost, 2)}` : "—", "ước tính từ token"],
    [UserRound, "Run cần người", e?.human_intervention?.rate_pct != null ? `${e.human_intervention.rate_pct}%` : "—", e ? `${e.human_intervention.answers ?? 0} câu trả lời · ${e.human_intervention.reexecutions ?? 0} re-execute` : undefined],
  ];
  return (
    <section className="card ov-health">
      <div className="card-head"><HeartPulse size={18} color="var(--brand)" /><h4>Harness Health</h4><a className="small" href="#/insights">Insights</a></div>
      {!m ? (
        <div className="stack" style={{ gap: 8 }}>{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton" style={{ height: 30 }} />)}</div>
      ) : (
        <ul className="ov-health-list">
          {rows.map(([I, label, value, hint]) => (
            <li key={label}>
              <span className="ov-health-icon"><I size={15} /></span>
              <span className="ov-li-main"><span className="small">{label}</span>{hint && <span className="muted ov-hint">{hint}</span>}</span>
              <b>{value}</b>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentRuns({ runs }: { runs: any[] }) {
  return (
    <section className="card">
      <div className="card-head"><PlayCircle size={18} color="var(--brand)" /><h4>Lượt chạy gần đây</h4><a className="small" href="#/runs">Tất cả runs</a></div>
      {!runs.length ? (
        <EmptyState title="Chưa có run nào" action={<a className="btn sm" href="#/work-items">Bắt đầu workflow</a>}>Run đầu tiên sẽ xuất hiện ở đây.</EmptyState>
      ) : (
        <ul className="ov-list">
          {runs.map((r) => {
            const steps = (r.steps ?? []) as Array<{ status: string }>;
            const done = steps.filter((s) => ["COMPLETED", "SKIPPED"].includes(s.status)).length;
            return (
              <li key={r.id}>
                <a href={`#/runs/${r.id}`}>
                  <span className="ov-run-id">#{r.id}</span>
                  <span className="ov-li-main">
                    <b className="ov-ellipsis">{r.title}</b>
                    <span className="muted small">{r.definition_key} · {ago(r.updated_at)} trước</span>
                  </span>
                  <span className="ov-run-progress" title={`${done}/${steps.length} bước`}>
                    <span className="progress"><span style={{ width: `${steps.length ? (done / steps.length) * 100 : 0}%`, background: r.status === "FAILED" ? "var(--st-err)" : "var(--st-ok)" }} /></span>
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
function RecentVerification({ runs }: { runs: any[] }) {
  const ids = runs.map((r) => r.id).join(",");
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all(runs.slice(0, 6).map((r) => api<any>(`/api/runs/${r.id}`).catch(() => null))).then((details) => {
      if (!alive) return;
      const out: any[] = [];
      for (const d of details) {
        if (!d) continue;
        for (const a of d.attempts ?? []) {
          const v = a.metrics?.verification;
          if (v) out.push({ run: d.id, step: a.step_key, n: a.number, at: a.finished_at ?? a.started_at, v });
        }
      }
      setRows(out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6));
    });
    return () => void (alive = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  return (
    <section className="card">
      <div className="card-head"><ShieldCheck size={18} color="var(--brand)" /><h4>Kết quả verification</h4><span className="sub">coding step gần đây</span></div>
      {rows === null ? (
        <div className="stack" style={{ gap: 8 }}>{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 36 }} />)}</div>
      ) : !rows.length ? (
        <div className="ov-inbox-empty"><RefreshCw size={16} /> Chưa có coding step nào chạy qua verification gate.</div>
      ) : (
        <ul className="ov-list">
          {rows.map((r) => {
            const status = String(r.v.status ?? r.v.outcome ?? "—");
            const tone = r.v.passed === true ? (status === "accepted_with_preexisting" || r.v.needs_review ? "WAITING" : "COMPLETED") : r.v.passed === false ? "FAILED" : "PENDING";
            return (
              <li key={`${r.run}-${r.step}-${r.n}`}>
                <a href={`#/runs/${r.run}/${encodeURIComponent(r.step)}`}>
                  <span className={`ov-dot ${tone === "COMPLETED" ? "ok" : tone === "FAILED" ? "err" : tone === "WAITING" ? "wait" : ""}`} />
                  <span className="ov-li-main"><b>Run #{r.run} · {r.step} #{r.n}</b><span className="muted small">{typeof r.v.rounds === "number" ? `${r.v.rounds} vòng · sửa ${r.v.repairs ?? 0}` : r.v.reason ?? ""}{r.v.needs_review ? " · cần xem lại" : ""}</span></span>
                  <Badge s={tone}>{status}</Badge>
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {rows && rows.some((r) => r.v.passed === false) && <div className="small ov-warn"><AlertTriangle size={14} /> Có coding step không qua verification — mở run để xem chẩn đoán.</div>}
    </section>
  );
}

