import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle, ArrowRight, BookOpen, Check, CheckCircle2, ChevronRight, CircleDashed, ClipboardList, Cpu, FileDiff, FileText, FlaskConical, Hand, History,
  Info, Layers, ListChecks, LogIn, LogOut, MessageCircleQuestion, MessagesSquare, Paperclip, Play, RotateCcw, Send, ShieldAlert, ShieldCheck, SkipForward,
  Square, SquareTerminal, Timer, Wrench, X, XCircle, Sparkles, Bot,
} from "lucide-react";
import { api, STATUS_COLORS, useApi } from "../api.ts";
import { act, Badge, Copy, dur, Empty, ErrorBox, JsonBlock, Loading, Markdown, Tabs, time, navigate } from "../ui.tsx";
import { stepTypeIcon } from "../graph.tsx";
import { Transcript } from "./Transcript.tsx";
import { ReportPanel } from "./Report.tsx";
import "./RunView.css";

const AGENT_TYPES = ["agent", "coding_agent"];
type Tab = "report" | "overview" | "execution" | "input" | "output" | "knowledge" | "qa" | "artifacts" | "history";

const CATEGORY_LABEL: Record<string, string> = {
  business_rule: "Business rules",
  architecture_guideline: "Architecture guidelines",
  coding_standard: "Coding standards",
  domain_knowledge: "Domain knowledge",
  security_policy: "Security policies",
  agent_skill: "Agent skills",
  repository_convention: "Repository conventions",
};

const TabLabel = ({ icon: I, children }: { icon: typeof Info; children: ReactNode }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><I size={13} strokeWidth={2} />{children}</span>
);

/** Render a step output: Markdown for summary-like strings, then the full structure. */
export function OutputView({ value }: { value: any }) {
  if (value == null) return <Empty>Chưa có output.</Empty>;
  const text = typeof value === "string" ? value : value.summary ?? value.report ?? null;
  return (
    <div>
      {typeof text === "string" && (
        <div className="rv-card">
          <div className="rv-card-head"><h4><FileText size={15} /> Summary</h4><Copy text={text} /></div>
          <Markdown text={text} />
        </div>
      )}
      <JsonBlock value={value} title="Output" />
    </div>
  );
}

export function QuestionsForm({ questions, onDone }: { questions: any[]; onDone: () => void }) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  if (!questions.length) return null;
  const submit = async () => {
    setBusy(true);
    const r = await act(() => api("/api/questions/answers", { answers }));
    setBusy(false);
    if (r) {
      setAnswers({});
      onDone();
    }
  };
  return (
    <section className="rv-attn" aria-label="Câu hỏi đang chờ">
      <div className="rv-attn-head">
        <span className="rv-attn-icon"><MessageCircleQuestion size={20} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h4>Claude đang chờ câu trả lời ({questions.length})</h4>
          <div className="rv-attn-sub">Bước đang tạm dừng cho tới khi bạn trả lời.</div>
        </div>
      </div>
      {questions.map((q) => (
        <div key={q.id} className="q">
          <div className="row tight" style={{ alignItems: "flex-start" }}><b className="grow">{q.question}</b><Copy text={q.question} /></div>
          {q.context && <div className="muted small" style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>{q.context}</div>}
          {!!q.options?.length && (
            <div className="rv-option-row">
              {q.options.map((o: string, i: number) => (
                <button key={o} className={answers[q.id] === o ? "sm" : "ghost sm"} aria-pressed={answers[q.id] === o} onClick={() => setAnswers({ ...answers, [q.id]: o })} title={i === 0 ? "Gợi ý" : undefined}>
                  {answers[q.id] === o ? <Check size={13} /> : i === 0 ? <Sparkles size={13} /> : null}{o}
                </button>
              ))}
            </div>
          )}
          <textarea rows={2} placeholder={q.suggested_answer ? `Gợi ý: ${q.suggested_answer}` : "Câu trả lời…"} value={answers[q.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
        </div>
      ))}
      <div className="rv-attn-actions">
        <button className="big" disabled={busy || !Object.values(answers).some((a) => a.trim())} onClick={submit}><Send size={15} />{busy ? "Đang gửi…" : "Gửi trả lời & tiếp tục bước"}</button>
      </div>
      <div className="rv-note" style={{ marginBottom: 0 }}><Info size={13} />Trả lời được lưu vào PostgreSQL; bước tiếp tục từ checkpoint khi mọi câu đã được trả lời.</div>
    </section>
  );
}

export function ApprovalPanel({ run, step, onDone }: { run: any; step: any; onDone: () => void }) {
  const req = step.approval?.request;
  const gate = step.approval?.gate && !step.approval?.granted;
  const [comment, setComment] = useState("");
  const [repos, setRepos] = useState<string[]>(req?.recommended ?? run.selected_repositories ?? []);
  const send = async (approve: boolean) => {
    const body: any = { comment };
    if (approve && req?.select_repositories) body.repositories = repos;
    const r = await act(() => api(`/api/runs/${run.id}/steps/${step.key}/${approve ? "approve" : "reject"}`, body), approve ? "Approved" : "Rejected");
    if (r) onDone();
  };
  const reexec = step.config?.on_reject?.reexecute;
  return (
    <section className="rv-attn" aria-label="Cần duyệt">
      <div className="rv-attn-head">
        <span className="rv-attn-icon"><Hand size={20} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h4>{gate ? "Cần duyệt trước khi chạy bước này" : req?.message ?? "Cần duyệt"}</h4>
          <div className="rv-attn-sub">Run đang dừng ở bước <b>{step.name}</b> chờ quyết định của bạn.</div>
        </div>
      </div>
      {step.type === "git_pull_request" && (
        <div className="row">
          <button className="ghost sm" onClick={() => navigate(`/runs/${run.id}/~changes`)}><FileDiff size={14} /> Xem thay đổi & PR preview trước khi duyệt</button>
        </div>
      )}
      {req?.select_repositories && (
        <div style={{ marginTop: 10 }}>
          <div className="small" style={{ color: req.ambiguous ? "var(--st-wait)" : "var(--ink-2)", fontWeight: 600, display: "flex", gap: 6, alignItems: "center" }}>
            {req.ambiguous && <AlertTriangle size={14} />}{req.ambiguous ? "Gợi ý chưa chắc chắn — hãy chọn repo." : "Repo được gợi ý:"}
          </div>
          {(req.candidates ?? []).map((c: any) => (
            <label key={c.repo} className="rv-repo-opt">
              <input type="checkbox" checked={repos.includes(c.repo)} onChange={(e) => setRepos(e.target.checked ? [...repos, c.repo] : repos.filter((r) => r !== c.repo))} />
              <span style={{ minWidth: 0 }}>
                <b>{c.repo}</b> <span className="muted small">score {c.score}</span>
                <br />
                <span className="muted small">{(c.reasons ?? []).join(" · ")}</span>
              </span>
            </label>
          ))}
          <div className="muted small">Allowed: {(req.allowed ?? run.allowed_repositories).join(", ")}</div>
        </div>
      )}
      {Object.entries(req?.outputs ?? {}).map(([k, v]) => (
        <details key={k} open style={{ marginTop: 8 }}>
          <summary>Output của bước {k}</summary>
          <OutputView value={v} />
        </details>
      ))}
      <textarea rows={2} placeholder="Nhận xét / feedback (gửi cho bước được làm lại khi reject)" value={comment} onChange={(e) => setComment(e.target.value)} style={{ marginTop: 10, background: "var(--surface)" }} />
      <div className="rv-consequence">
        <CheckCircle2 size={14} color="var(--st-ok)" /><span><b>Approve</b> — bước được duyệt và run tiếp tục{req?.select_repositories ? ` với ${repos.length} repo đã chọn` : ""}.</span>
        <XCircle size={14} color="var(--st-err)" /><span><b>Reject</b> — {reexec ? <>bước <span className="mono">{reexec}</span> được làm lại kèm nhận xét của bạn.</> : "bước bị từ chối kèm nhận xét của bạn."}</span>
      </div>
      <div className="rv-attn-actions">
        <button className="ok big" onClick={() => send(true)}><ShieldCheck size={16} /> Approve</button>
        <button className="danger" onClick={() => send(false)}><X size={15} /> Reject{reexec ? ` → làm lại "${reexec}"` : ""}</button>
      </div>
    </section>
  );
}

export function StepInspector({ run, stepKey, tick, onChanged }: { run: any; stepKey: string; tick: number; onChanged: () => void }) {
  const { data, error, loading, reload } = useApi<any>(`/api/runs/${run.id}/steps/${stepKey}`);
  const [tab, setTab] = useState<Tab>(stepKey === "task_result_report" ? "report" : "overview");
  const [attemptId, setAttemptId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState("");
  useEffect(() => void reload(), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setAttemptId(null), [stepKey]);
  if (loading && !data) return <div className="rv-pane"><Loading /></div>;
  if (error) return <div className="rv-pane"><ErrorBox error={error} onRetry={reload} /></div>;
  const { step, attempts, questions, checkpoints, artifacts, sessions, snapshots, jobs } = data;
  const isAgent = AGENT_TYPES.includes(step.type);
  const attempt = attempts.find((a: any) => a.id === attemptId) ?? attempts.find((a: any) => a.id === step.current_attempt_id) ?? attempts[attempts.length - 1];
  const snapshot = snapshots.find((s: any) => s.id === attempt?.context_snapshot_id);
  const open = questions.filter((q: any) => q.status === "open");
  const live = step.status === "RUNNING" && attempt?.id === step.current_attempt_id;
  const runActive = run.status !== "CANCELED";
  const refresh = () => {
    reload();
    onChanged();
  };
  const action = async (path: string, body: any = {}, ok?: string) => {
    const r = await act(() => api(`/api/runs/${run.id}/steps/${step.key}/${path}`, body), ok);
    if (r) refresh();
    return r;
  };
  const canRun = run.status === "PAUSED" && ["READY", "RETRYING"].includes(step.status);
  const canRetry = runActive && ["FAILED", "CANCELED"].includes(step.status);
  const canReexec = runActive && ["COMPLETED", "SKIPPED", "WAITING_INPUT", "WAITING_APPROVAL", "FAILED"].includes(step.status);
  const canSkip = runActive && ["PENDING", "READY", "FAILED", "WAITING_INPUT", "WAITING_APPROVAL"].includes(step.status);
  const verification = attempt
    ? attempt.output?.verification ?? attempt.metrics?.verification ?? attempt.error?.details?.verification ?? (attempt.id === step.current_attempt_id ? step.output?.verification : undefined)
    : step.output?.verification;
  const TypeIcon = stepTypeIcon(step.type);

  const tabs: Array<[Tab, React.ReactNode]> = [
    ...(step.type === "task_result_report" ? ([["report", <TabLabel icon={ClipboardList}>Report</TabLabel>]] as Array<[Tab, React.ReactNode]>) : []),
    ["overview", <TabLabel icon={Info}>Overview</TabLabel>],
    ...(isAgent ? ([["execution", <TabLabel icon={Bot}>Claude {live && <span className="spinner" />}</TabLabel>]] as Array<[Tab, React.ReactNode]>) : []),
    ...(step.type === "command" ? ([["execution", <TabLabel icon={SquareTerminal}>Live output {live && <span className="spinner" />}</TabLabel>]] as Array<[Tab, React.ReactNode]>) : []),
    ["input", <TabLabel icon={LogIn}>Input</TabLabel>],
    ["output", <TabLabel icon={LogOut}>Output</TabLabel>],
    ["knowledge", <TabLabel icon={BookOpen}>{`Knowledge${snapshot ? ` (${snapshot.content.knowledge.length})` : ""}`}</TabLabel>],
    ["qa", <TabLabel icon={MessagesSquare}>{`Q&A${questions.length ? ` (${questions.length})` : ""}`}</TabLabel>],
    ["artifacts", <TabLabel icon={Paperclip}>{`Artifacts${artifacts.length ? ` (${artifacts.length})` : ""}`}</TabLabel>],
    ["history", <TabLabel icon={History}>{`History (${attempts.length})`}</TabLabel>],
  ];

  return (
    <div>
      <div className="si-head">
        <div className="si-top">
          <span className="si-icon" style={{ ["--si-c" as any]: STATUS_COLORS[step.status] ?? "var(--brand)" }}><TypeIcon size={20} strokeWidth={2} /></span>
          <div className="si-title">
            <h2>{step.name}</h2>
            <div className="si-meta">
              <Badge s={step.status} label />
              <span className="mono">{step.key}</span>
              <span>{step.type}</span>
              <span>gen {step.generation}</span>
              <span>{attempt ? `attempt #${attempt.number}` : "chưa chạy"}{attempts.length > 1 ? ` / ${attempts.length}` : ""}</span>
            </div>
          </div>
          <button className="quiet icon" aria-label="Đóng inspector" title="Đóng" onClick={() => navigate(`/runs/${run.id}`)}><X size={18} /></button>
        </div>
        {(canRun || canRetry || canSkip || ["RUNNING", "RETRYING"].includes(step.status) || attempts.length > 1) && (
          <div className="si-actions">
            {canRun && <button className="sm" onClick={() => action("run", {}, "Step queued")}><Play size={13} /> Run this step</button>}
            {canRetry && <button className="sm warn" onClick={() => action("retry", {}, "Retrying")}><RotateCcw size={13} /> Retry</button>}
            {canRetry && step.type === "command" && step.config?.baseline_compare !== "go" && (
              <button className="sm ghost" title="Re-run; Go test failures that also fail on the base branch are reported as pre-existing instead of failing the step"
                onClick={() => action("retry", { input: { config_overrides: { baseline_compare: "go" } } }, "Retrying with baseline comparison")}><Layers size={13} /> Retry với so baseline (Go)</button>
            )}
            {canSkip && <button className="sm ghost" onClick={() => confirm("Skip this step?") && action("skip")}><SkipForward size={13} /> Skip</button>}
            {["RUNNING", "RETRYING"].includes(step.status) && (
              <button className="sm danger" onClick={() => confirm("Dừng bước đang chạy? Process (Claude / command) bị kill, bước chuyển FAILED và có thể Retry hoặc Skip.") && action("stop", {}, "Stopped")}><Square size={12} /> Stop</button>
            )}
            {attempts.length > 1 && (
              <select aria-label="Chọn attempt" value={attempt?.id} onChange={(e) => setAttemptId(Number(e.target.value))}>
                {attempts.map((a: any) => (
                  <option key={a.id} value={a.id}>attempt #{a.number} · gen {a.generation} · {a.status}{a.invalidated_at ? " (invalidated)" : ""}</option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      <div className="si-body">
        {step.status === "WAITING_INPUT" && <QuestionsForm questions={open} onDone={refresh} />}
        {step.status === "WAITING_APPROVAL" && step.type !== "task_result_report" && <ApprovalPanel run={run} step={step} onDone={refresh} />}
        {step.type === "task_result_report" && step.status === "WAITING_APPROVAL" && tab !== "report" && (
          <div className="rv-attn" style={{ padding: "12px 16px" }}>
            <div className="rv-attn-head" style={{ alignItems: "center" }}>
              <span className="rv-attn-icon"><Hand size={18} /></span>
              <div style={{ flex: 1 }}><b>Báo cáo đang chờ bạn xem lại</b></div>
              <button className="sm" onClick={() => setTab("report")}>Mở tab Report <ArrowRight size={13} /></button>
            </div>
          </div>
        )}
        {step.error && (
          <div className="errorbox">
            <div className="row tight"><XCircle size={15} color="var(--st-err)" /><b className="grow">Error</b><Copy text={step.error} /></div>
            <div className="mono" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{step.error}</div>
          </div>
        )}
        <Tabs tabs={tabs} value={tab} onChange={setTab} />

        {tab === "report" && <ReportPanel run={run} step={step} artifacts={artifacts} attempts={attempts} onChanged={refresh} />}
        {tab === "overview" && (
          <div>
            {verification && <VerificationCard v={verification} />}
            {step.type === "command" && <TestFailurePanel attempts={attempts} questions={questions} current={attempt} step={step} />}
            {step.type === "command" && <BaselineSummary results={(attempt?.output ?? attempt?.error?.details)?.results} />}
            {attempt?.metrics && <AttemptMetrics m={attempt.metrics} />}
            <div className="rv-card">
              <div className="rv-card-head"><h4><ListChecks size={15} /> Chi tiết bước</h4></div>
              <div className="rv-kv">
                <span>Status</span><span><Badge s={step.status} /></span>
                <span>Depends on</span><span className="mono">{step.depends_on.join(", ") || "—"}</span>
                <span>Max attempts</span><span>{step.max_attempts} (backoff {step.retry_backoff_s}s)</span>
                <span>Approval gate</span><span>{step.requires_approval ? "yes" : "no"}</span>
                {step.run_if && <><span>Run if</span><span className="mono">{JSON.stringify(step.run_if)}</span></>}
                <span>Started</span><span>{time(step.started_at) || "—"}</span>
                <span>Finished</span><span>{time(step.finished_at) || "—"}</span>
                {sessions.length > 0 && <><span>Claude session</span><span className="mono small">{sessions[sessions.length - 1].session_id} {sessions[sessions.length - 1].model && `(${sessions[sessions.length - 1].model})`}</span></>}
              </div>
            </div>
            {step.config?.instructions && (
              <div className="rv-card">
                <div className="rv-card-head"><h4><FileText size={15} /> Instructions</h4><Copy text={step.config.instructions} /></div>
                <Markdown text={step.config.instructions} />
              </div>
            )}
            <JsonBlock value={step.config} title="Configuration" />
            {attempt?.input?.pending?.reexecute && <ReexecuteInfo rx={attempt.input.pending.reexecute} prev={attempt.input.previous_attempt?.number} />}
            {canReexec && <ReexecuteDialog run={run} step={step} onSubmit={(body) => action("reexecute", body, "Đã mở attempt mới")} />}
            {checkpoints.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary>Checkpoints ({checkpoints.length})</summary>
                {checkpoints.map((c: any) => (
                  <div key={c.id} className="small" style={{ padding: "3px 0", borderBottom: "1px dashed var(--line)" }}><span className="muted">{time(c.created_at)}</span> <b>{c.reason}</b> <span className="mono">{JSON.stringify(c.data).slice(0, 300)}</span></div>
                ))}
              </details>
            )}
          </div>
        )}
        {tab === "execution" && (!attempt ? <Empty>Bước chưa chạy.</Empty> : isAgent ? <Transcript attemptId={attempt.id} live={live} tick={tick} /> : <CommandLog attemptId={attempt.id} live={live} tick={tick} startedAt={attempt.started_at} />)}
        {tab === "input" && (attempt ? <JsonBlock value={attempt.input} title={`Resolved input · attempt #${attempt.number}`} /> : <Empty>Bước chưa chạy — input được tính lúc bắt đầu attempt.</Empty>)}
        {tab === "output" && (
          <div>
            <OutputView value={attempt && attempt.id !== step.current_attempt_id ? attempt.output : step.output} />
            {attempt?.error && <JsonBlock value={attempt.error} title="Attempt error" />}
          </div>
        )}
        {tab === "knowledge" && <KnowledgeApplied snapshot={snapshot} />}
        {tab === "qa" &&
          (questions.length ? (
            questions.map((q: any) => (
              <div key={q.id} className="rv-card" style={{ borderLeft: `3px solid ${q.status === "open" ? "var(--st-wait)" : q.status === "answered" ? "var(--st-ok)" : "var(--line-strong)"}` }}>
                <div className="row tight" style={{ alignItems: "flex-start" }}>
                  <MessageCircleQuestion size={15} color="var(--st-wait)" style={{ marginTop: 2, flex: "none" }} />
                  <b className="grow">{q.question}</b>
                  <Badge s={q.status === "answered" ? "COMPLETED" : q.status === "open" ? "WAITING_INPUT" : "CANCELED"}>{q.status}</Badge>
                </div>
                {q.context && <div className="muted small" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{q.context}</div>}
                {q.answer && (
                  <div style={{ marginTop: 8, padding: "8px 10px", background: "var(--st-ok-bg)", borderRadius: "var(--r-sm)" }}>
                    <ArrowRight size={13} style={{ verticalAlign: -2 }} /> {q.answer} <span className="muted small">{q.answered_by} {time(q.answered_at)}</span>
                  </div>
                )}
                <div className="muted small" style={{ marginTop: 6 }}>attempt {attempts.find((a: any) => a.id === q.attempt_id)?.number ?? "?"} · {time(q.created_at)}</div>
              </div>
            ))
          ) : (
            <Empty>Bước này chưa hỏi gì.</Empty>
          ))}
        {tab === "artifacts" && <Artifacts artifacts={artifacts} />}
        {tab === "history" && (
          <div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>#</th><th>Gen</th><th>Status</th><th>Started</th><th>Finished</th><th>Worker</th><th>Error</th></tr></thead>
                <tbody>
                  {attempts.map((a: any) => (
                    <tr key={a.id} className="click" style={{ opacity: a.invalidated_at ? 0.6 : 1, background: a.id === attempt?.id ? "var(--sel)" : undefined }} onClick={() => (setAttemptId(a.id), setTab(isAgent ? "execution" : "output"))}>
                      <td><b>{a.number}</b></td><td>{a.generation}</td><td><Badge s={a.status} />{a.invalidated_at && <div className="muted small">invalidated</div>}
                        {a.input?.pending?.reexecute && (
                          <div className="small" style={{ marginTop: 2 }}>
                            <RotateCcw size={11} style={{ verticalAlign: -1 }} /> {a.input.pending.reexecute.instructions ? `“${String(a.input.pending.reexecute.instructions).slice(0, 80)}”` : "re-execute"}
                            {a.input.pending.reexecute.skills?.length > 0 && <span className="muted"> · {a.input.pending.reexecute.skills.map((s: any) => `${s.key}@v${s.version}`).join(", ")}</span>}
                          </div>
                        )}
                      </td>
                      <td className="small">{time(a.started_at)}</td><td className="small">{time(a.finished_at)}</td><td className="mono small">{(a.worker ?? "").split(":").slice(-1)[0]}</td>
                      <td className="err small">{a.error?.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rv-sec">
              <div className="rv-sec-title"><Cpu size={14} /> Jobs</div>
              {jobs.length ? jobs.map((j: any) => (
                <div key={j.id} className="small mono" style={{ padding: "4px 0", borderBottom: "1px dashed var(--line)" }}>#{j.id} {j.status} gen{j.generation} claims={j.claims}{j.force ? " force" : ""} {j.lease_owner ?? ""} {j.last_error ?? ""}</div>
              )) : <div className="muted small">—</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- verification (coding steps)

const VF_OUTCOME: Record<string, { tone: "ok" | "err" | "wait" | "idle"; label: string }> = {
  passed: { tone: "ok", label: "Đạt" },
  failed: { tone: "err", label: "Không đạt" },
  no_progress: { tone: "err", label: "Không tiến triển" },
  error: { tone: "err", label: "Lỗi kiểm tra" },
  canceled: { tone: "idle", label: "Đã huỷ" },
  stopped: { tone: "wait", label: "Tạm dừng" },
  skipped: { tone: "idle", label: "Bỏ qua" },
  accepted_with_preexisting: { tone: "wait", label: "Chấp nhận lỗi có sẵn" },
};
const TONE_STATUS = { ok: "COMPLETED", err: "FAILED", wait: "WAITING", idle: "SKIPPED" } as const;
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Harness verification-and-repair result (attempt metrics / output `verification`). Renders only the fields present. */
function VerificationCard({ v }: { v: any }) {
  if (!v || typeof v !== "object") return null;
  const outcome = typeof v.outcome === "string" ? v.outcome : v.passed === true ? "passed" : v.passed === false ? "failed" : "";
  const meta = VF_OUTCOME[outcome] ?? { tone: v.passed === true ? "ok" : v.passed === false ? "err" : "idle", label: outcome || "không rõ" };
  const rounds = num(v.rounds);
  const repairs = num(v.repairs);
  const maxRepairs = num(v.max_repairs);
  const sigs = arr(v.failure_signatures);
  const last = arr(v.last);
  return (
    <section className={`vf tone-${meta.tone}`} aria-label="Verification">
      <div className="rv-card-head" style={{ marginBottom: 4 }}>
        <h4><FlaskConical size={16} /> Verification</h4>
        <Badge s={TONE_STATUS[meta.tone]}>{meta.label}</Badge>
        {num(v.duration_ms) != null && <span className="muted small" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}><Timer size={12} />{dur(v.duration_ms)}</span>}
      </div>
      {v.reason && <div className="muted small">{String(v.reason)}</div>}
      {rounds != null && rounds > 0 && (
        <div className="vf-steps" role="list" aria-label="Các vòng kiểm tra">
          {Array.from({ length: rounds }, (_, i) => {
            const state = i < sigs.length ? "fail" : v.passed === true && i === rounds - 1 ? "pass" : "unknown";
            return (
              <div key={i} style={{ display: "contents" }}>
                {i > 0 && <span className="vf-link" aria-hidden />}
                <div className="vf-step" role="listitem" title={state === "fail" ? String(sigs[i]) : undefined}>
                  <span className={`vf-dot ${state}`}>{state === "pass" ? <Check size={13} strokeWidth={3} /> : state === "fail" ? <X size={13} strokeWidth={3} /> : <CircleDashed size={13} />}</span>
                  <span>{i === 0 ? "Kiểm tra" : `Sửa #${i}`}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {(repairs != null || rounds != null) && (
        <div className="vf-budget" style={{ marginTop: 6, flexWrap: "wrap" }}>
          {rounds != null && <span><b>{rounds}</b> vòng</span>}
          {repairs != null && (
            <>
              <span>· sửa <b>{repairs}</b>{maxRepairs != null ? ` / ${maxRepairs}` : ""}</span>
              {maxRepairs != null && maxRepairs > 0 && (
                <span className="progress" aria-hidden><span style={{ width: `${Math.min(100, (repairs / maxRepairs) * 100)}%`, background: repairs >= maxRepairs ? "var(--st-err)" : "var(--brand)" }} /></span>
              )}
            </>
          )}
        </div>
      )}
      {last.map((r: any, i: number) => {
        const regs = arr(r?.regressions);
        const weakened = arr(r?.weakened);
        const pre = num(r?.pre_existing);
        return (
          <div key={`${r?.repo ?? i}`} className="vf-repo">
            <div className="vf-repo-head">
              {r?.passed ? <CheckCircle2 size={15} color="var(--st-ok)" /> : r?.passed === false ? <XCircle size={15} color="var(--st-err)" /> : <CircleDashed size={15} color="var(--muted)" />}
              <b className="grow">{r?.repo ?? "—"}</b>
              {r?.timed_out ? <Badge s="FAILED">timeout</Badge> : r?.exit_code != null && <span className="mono muted small">exit {String(r.exit_code)}</span>}
              {r?.artifact_id != null && <a className="small" href={`/api/artifacts/${r.artifact_id}/raw`} target="_blank" rel="noopener">log</a>}
            </div>
            {regs.length > 0 && (
              <ul className="vf-list">
                {regs.map((g: any, j: number) => (
                  <li key={j} style={{ flexDirection: "column", gap: 1 }}>
                    <span className="mono" style={{ color: "var(--st-err)", fontWeight: 600 }}>{g?.package}</span>
                    {arr(g?.tests).map((t: string) => <span key={t} className="mono" style={{ marginLeft: 12 }}><X size={10} style={{ verticalAlign: -1 }} /> {t}</span>)}
                    {arr(g?.build_errors).map((e: string) => <span key={e} className="mono" style={{ marginLeft: 12 }}><Wrench size={10} style={{ verticalAlign: -1 }} /> {e}</span>)}
                  </li>
                ))}
              </ul>
            )}
            {weakened.length > 0 && (
              <div className="vf-list" style={{ color: "var(--st-err)", display: "flex", gap: 6, marginTop: 6 }}>
                <ShieldAlert size={13} style={{ flex: "none", marginTop: 2 }} /><span>Test bị xoá / skip (không được phép): <span className="mono">{weakened.join(", ")}</span></span>
              </div>
            )}
            {pre != null && pre > 0 && <div className="muted small" style={{ marginTop: 4 }}>{pre} lỗi có sẵn trên base (không tính là regression)</div>}
            {r?.note && <div className="muted small" style={{ marginTop: 4 }}>{String(r.note)}</div>}
          </div>
        );
      })}
      {sigs.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary>Failure signatures ({sigs.length})</summary>
          {sigs.map((s: unknown, i: number) => <div key={i} className="mono small" style={{ overflowWrap: "anywhere", padding: "2px 0" }}>{i + 1}. {String(s)}</div>)}
        </details>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- command steps

const CAT: Record<string, [string, string]> = {
  new: ["FAILED", "lỗi mới"],
  pre_existing: ["WAITING", "đã có trên baseline"],
  environment: ["PAUSED", "lỗi môi trường"],
  insufficient: ["PENDING", "chưa đủ bằng chứng"],
};
const DECISION: Record<string, string> = { rerun: "Chạy lại test", fix: "Sửa rồi test lại", accept_baseline: "Tiếp tục với lỗi baseline", stop: "Dừng", unclear: "Chưa rõ → hỏi lại" };

/** Test failure diagnosis (real output + baseline), AI explanation, and the exchange/decision history of this step. */
function TestFailurePanel({ attempts, questions, current, step }: { attempts: any[]; questions: any[]; current: any; step: any }) {
  const payload = (a: any) => a?.output ?? a?.error?.details;
  const withDiag = [...attempts].reverse().find((a) => payload(a)?.diagnosis);
  const d = payload(current)?.diagnosis ?? payload(withDiag)?.diagnosis;
  const decisions = attempts.filter((a) => payload(a)?.decision).map((a) => ({ n: a.number, ...payload(a).decision }));
  const exception = step.output?.accepted_exception;
  if (!d && !decisions.length) return null;
  const groups = (["new", "pre_existing", "environment", "insufficient"] as const).filter((k) => d?.failures.some((f: any) => f.category === k));
  return (
    <div className={step.status === "WAITING_INPUT" ? "rv-attn" : "rv-card"} style={step.status === "WAITING_INPUT" ? { boxShadow: "none" } : undefined}>
      <div className="rv-card-head"><h4><FlaskConical size={16} /> Chẩn đoán test</h4>{step.output?.test_status === "FAILED" && <Badge s="FAILED">test FAILED</Badge>}</div>
      {d && (
        <>
          <div style={{ margin: "4px 0", fontWeight: 600 }}>{d.summary}</div>
          <div className="mono small" style={{ wordBreak: "break-all", background: "var(--code)", padding: "6px 9px", borderRadius: "var(--r-sm)", margin: "6px 0" }}>{d.command.split("\n").find((l: string) => l.includes("go test")) ?? d.command.split("\n")[0]}</div>
          <div className="muted small">
            {d.results.map((r: any) => `${r.repo}: exit ${r.timed_out ? "timeout" : r.exit_code}`).join(" · ")} · baseline {d.baseline_available ? <span className="mono">{String(d.base_sha).slice(0, 9)}</span> : "không có"}
          </div>
          {d.explanation && (
            <div className="rv-card soft" style={{ padding: "10px 12px" }}>
              <div className="small"><b>{d.explanation.by === "claude" ? "AI" : "Tóm tắt"}:</b> {d.explanation.text}</div>
              <div className="small" style={{ marginTop: 4 }}><b>Đề xuất:</b> {d.explanation.suggestion}</div>
            </div>
          )}
          {groups.map((g) => (
            <div key={g} style={{ marginTop: 8 }}>
              <Badge s={CAT[g][0]}>{CAT[g][1]} · {d.failures.filter((f: any) => f.category === g).length}</Badge>
              {d.failures.filter((f: any) => f.category === g).map((f: any, i: number) => (
                <details key={i} style={{ marginLeft: 8 }}>
                  <summary style={{ color: "var(--ink)" }}>
                    <span className="mono small">{f.repo} {f.package?.split("/").slice(-2).join("/")} {f.test ?? f.build_error ?? ""}</span> <span className="muted small">— {f.reason}{f.env_signal && g !== "environment" ? " (log có dấu hiệu lỗi mạng/DB)" : ""}</span>
                  </summary>
                  <pre>{f.log}</pre>
                </details>
              ))}
            </div>
          ))}
        </>
      )}
      {exception && (
        <div className="rv-note" style={{ color: "var(--st-wait)" }}>
          <AlertTriangle size={14} />Đã chấp nhận ngoại lệ baseline ({exception.failures.length} lỗi) — kết quả test vẫn FAILED, được ghi vào PR và báo cáo.
        </div>
      )}
      {(questions.length > 0 || decisions.length > 0) && (
        <div style={{ marginTop: 10 }}>
          <b className="small">Trao đổi & quyết định</b>
          {attempts.map((a) => {
            const qs = questions.filter((q: any) => q.attempt_id === a.id);
            const dec = payload(a)?.decision;
            if (!qs.length && !dec) return null;
            return (
              <div key={a.id} className="small" style={{ margin: "6px 0", paddingLeft: 10, borderLeft: "2px solid var(--line-strong)" }}>
                <span className="muted">attempt #{a.number} · {a.status}</span>
                {dec && <div><ChevronRight size={12} style={{ verticalAlign: -2 }} /> quyết định: <b>{DECISION[dec.kind] ?? dec.kind}</b>{dec.target ? ` (${dec.target})` : ""}{dec.instructions ? ` — “${dec.instructions}”` : ""}</div>}
                {qs.map((q: any) => (
                  <div key={q.id}>
                    <MessageCircleQuestion size={12} style={{ verticalAlign: -2, color: "var(--st-wait)" }} /> {q.question}
                    {q.answer ? <> <br /><MessagesSquare size={12} style={{ verticalAlign: -2, color: "var(--st-ok)" }} /> <b>{q.answer}</b></> : q.status === "open" ? <span className="muted"> (đang chờ)</span> : <span className="muted"> ({q.status})</span>}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Branch-vs-base classification of Go test failures for each repo of a command step. */
function BaselineSummary({ results }: { results?: any[] }) {
  const withBase = (results ?? []).filter((r) => r.baseline);
  if (!withBase.length) return null;
  const Item = ({ x }: { x: any }) => (
    <div className="small" style={{ margin: "2px 0 6px 12px" }}>
      <span className="mono" style={{ fontWeight: 600 }}>{x.package}</span>
      {x.tests.map((t: string) => <div key={t} className="mono" style={{ marginLeft: 12 }}><X size={10} style={{ verticalAlign: -1 }} /> {t}</div>)}
      {x.build_errors.map((e: string) => <div key={e} className="mono" style={{ marginLeft: 12 }}><Wrench size={10} style={{ verticalAlign: -1 }} /> {e}</div>)}
    </div>
  );
  return (
    <div className="rv-card">
      <div className="rv-card-head"><h4><Layers size={16} /> So với baseline</h4></div>
      {withBase.map((r) => (
        <div key={r.repo} className="vf-repo">
          <div className="vf-repo-head">
            <b className="grow">{r.repo}</b>
            {r.baseline.regressions && (r.baseline.regressions.length ? <Badge s="FAILED">{r.baseline.regressions.length} regression</Badge> : <Badge s="COMPLETED">không có regression</Badge>)}
          </div>
          {r.baseline.note ? <div className="muted small">{r.baseline.note}</div> : <div className="muted small mono">base {String(r.baseline.base_sha).slice(0, 9)}</div>}
          {r.baseline.regressions?.length > 0 && <div className="err small" style={{ marginTop: 6, fontWeight: 600 }}>Lỗi mới do thay đổi của run:</div>}
          {r.baseline.regressions?.map((x: any) => <Item key={x.package} x={x} />)}
          {r.baseline.pre_existing?.length > 0 && <div className="muted small" style={{ marginTop: 6 }}>Lỗi có sẵn trên base (không chặn):</div>}
          {r.baseline.pre_existing?.map((x: any) => <Item key={"p" + x.package} x={x} />)}
        </div>
      ))}
    </div>
  );
}

/** Live stdout/stderr of a command step, streamed as "log" events while it runs. */
function CommandLog({ attemptId, live, tick, startedAt }: { attemptId: number; live: boolean; tick: number; startedAt: string }) {
  const [events, setEvents] = useState<any[]>([]);
  const last = useRef(0);
  const box = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const [, force] = useState(0);
  useEffect(() => {
    setEvents([]);
    last.current = 0;
  }, [attemptId]);
  useEffect(() => {
    api<any[]>(`/api/attempts/${attemptId}/transcript?after=${last.current}`).then((rows) => {
      if (!rows.length) return;
      last.current = rows[rows.length - 1].id;
      setEvents((p) => [...p, ...rows]);
    });
  }, [attemptId, tick]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [events, follow]);
  const text = events.map((e) => (e.kind === "log" ? e.content : `\n${e.content}\n`)).join("");
  const lastAt = events.length ? events[events.length - 1].created_at : startedAt;
  const quiet = live ? Math.round((Date.now() - new Date(lastAt).getTime()) / 1000) : 0;
  return (
    <div>
      <div className="rv-toolrow">
        <span className="small muted grow" style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {live ? <><span className="spinner" /> đang chạy {Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)}s · output cuối {quiet}s trước</> : <><CheckCircle2 size={13} /> đã xong</>}
          {live && quiet > 60 && <span style={{ color: "var(--st-wait)" }}> — không có output hơn 1 phút: có thể test đang chờ mạng/DB; dùng Stop nếu cần</span>}
        </span>
        <label><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
        <Copy text={text} />
      </div>
      <pre ref={box} className="rv-term">{text || "(chưa có output)"}</pre>
    </div>
  );
}

function AttemptMetrics({ m }: { m: any }) {
  const tools = Object.entries<number>(m.tool_calls ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rv-card">
      <div className="rv-card-head"><h4><Cpu size={16} /> Metrics attempt</h4>{m.model && <span className="mono muted small">{m.model}</span>}</div>
      <div className="rv-minis" style={{ marginBottom: 10 }}>
        <div className="rv-mini"><span>Cost</span><b>${Number(m.cost_usd ?? 0).toFixed(4)}</b></div>
        <div className="rv-mini"><span>Turns</span><b>{m.turns ?? "—"}</b></div>
        <div className="rv-mini"><span>Thời gian</span><b>{Math.round((m.duration_ms ?? 0) / 1000)}s</b></div>
        <div className="rv-mini"><span>Session</span><b>{m.sessions ?? "—"}</b></div>
      </div>
      <div className="rv-kv">
        <span>Tokens</span><span>in {m.tokens?.input} · out {m.tokens?.output} · cache read {m.tokens?.cache_read} · cache write {m.tokens?.cache_creation}</span>
        <span>Disclosure</span><span>{m.disclosure?.inline} inline · {m.disclosure?.index} index · {m.disclosure?.search} search-only · upstream {m.upstream?.full} full / {m.upstream?.summary} tóm tắt</span>
        <span>Tools</span><span className="small">{tools.map(([k, v]) => `${k.replace("mcp__platform__", "platform·")}×${v}`).join(", ") || "—"}{m.tool_errors ? ` · ${m.tool_errors} lỗi` : ""}</span>
        <span>Skills nạp</span><span className="small">{(m.skills_loaded ?? []).join(", ") || "—"}{m.knowledge_searches?.length ? ` · tìm: ${m.knowledge_searches.map((q: string) => `"${q}"`).join(", ")}` : ""}</span>
        <span>Integration</span><span className="small">{(m.integration_calls ?? []).map((c: any) => `${c.name} ${c.ok ? "✓" : "✗"} ${c.ms}ms`).join(", ") || "—"}</span>
        <span>Subagents</span><span className="small">{(m.subagents ?? []).map((s: any) => s.type).join(", ") || "—"}</span>
        {m.denied?.length > 0 && <><span>Bị chặn</span><span className="small err">{m.denied.map((d: any) => `${d.tool}${d.subagent ? ` (${d.subagent})` : ""}: ${d.reason}`).join(" · ")}</span></>}
      </div>
    </div>
  );
}

/** Instructions and skills this attempt was re-executed with (stored with the attempt's input). */
function ReexecuteInfo({ rx, prev }: { rx: any; prev?: number }) {
  return (
    <div className="rv-card" style={{ borderLeft: "3px solid var(--brand)" }}>
      <div className="rv-card-head" style={{ marginBottom: 4 }}>
        <h4><RotateCcw size={15} /> Lần chạy lại này</h4>
        <span className="muted small">{rx.requested_by ? `bởi ${rx.requested_by} · ` : ""}{time(rx.at)}{prev ? ` · sửa từ attempt #${prev}` : ""}</span>
      </div>
      {rx.instructions ? <div style={{ whiteSpace: "pre-wrap" }}>{rx.instructions}</div> : <div className="muted small">(không có chỉ dẫn)</div>}
      {rx.skills?.length > 0 && <div className="small" style={{ marginTop: 6 }}>Skills: {rx.skills.map((s: any) => <span key={s.key} className="pill">{s.title ?? s.key} <span className="muted mono">v{s.version}</span></span>)}</div>}
    </div>
  );
}

/** Re-execute this step with optional instructions + skills; shows which dependants will rerun / re-ask approval. */
function ReexecuteDialog({ run, step, onSubmit }: { run: any; step: any; onSubmit: (body: any) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { data: catalog } = useApi<any[]>(open ? "/api/knowledge?category=agent_skill" : null, [open]);
  const graph: any[] = run.graph?.steps ?? [];
  const affected: string[] = [];
  const stack = [step.key];
  while (stack.length) {
    const k = stack.pop()!;
    for (const s of graph) if ((s.depends_on ?? []).includes(k) && !affected.includes(s.key)) (affected.push(s.key), stack.push(s.key));
  }
  const byKey = new Map(run.steps.map((s: any) => [s.key, s]));
  if (!open)
    return (
      <div className="rv-card soft" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button className="sm" onClick={() => setOpen(true)}><RotateCcw size={13} /> Re-execute…</button>
        <span className="muted small grow">Chạy lại bước này (có thể kèm chỉ dẫn / skill).</span>
      </div>
    );
  return (
    <section className="rv-card" style={{ borderColor: "var(--brand-400)", boxShadow: "0 0 0 3px var(--focus), var(--shadow-2)" }} aria-label="Re-execute">
      <div className="rv-card-head">
        <h4><RotateCcw size={16} /> Chạy lại “{step.name}” với chỉ dẫn</h4>
        <button className="quiet icon" aria-label="Đóng" onClick={() => setOpen(false)}><X size={16} /></button>
      </div>
      <label className="field" style={{ marginTop: 0 }}>
        <span>Chỉ dẫn (tuỳ chọn)</span>
        <textarea rows={4} autoFocus placeholder="Chỉ dẫn cho lần chạy lại (tuỳ chọn), vd: Xem lại call sang service B. Dữ liệu đã có trong payload" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="field">
        <span>Skills cho lần này <span className="muted" style={{ fontWeight: 400 }}>(tuỳ chọn; ghim theo version hiện tại)</span></span>
        {skills.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {skills.map((k) => (
              <span key={k} className="pill chip-brand">{catalog?.find((c) => c.key === k)?.title ?? k}<button aria-label={`Bỏ ${k}`} onClick={() => setSkills(skills.filter((x) => x !== k))}><X size={11} /></button></span>
            ))}
          </div>
        )}
        <select value="" onChange={(e) => e.target.value && setSkills([...skills, e.target.value])}>
          <option value="">+ thêm skill…</option>
          {(catalog ?? []).filter((c) => !skills.includes(c.key)).map((c) => <option key={c.key} value={c.key}>{c.title} ({c.key} v{c.current_version}){c.enabled ? "" : " [off]"}</option>)}
        </select>
      </div>
      <div className="rv-card soft" style={{ margin: "10px 0 0", padding: "10px 12px" }}>
        <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Sẽ chạy lại</div>
        <div className="rv-chipline small">
          <span className="pill chip-brand mono">{step.key}</span>
          {affected.length ? affected.map((k) => {
            const s: any = byKey.get(k);
            const gate = s?.requires_approval || s?.type === "human_approval" || s?.type === "task_result_report" || (s?.type === "git_pull_request" && s?.config?.mode === "approval");
            return (
              <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <ChevronRight size={12} color="var(--muted)" />
                <span className="pill" style={{ margin: 0 }}>{s?.name ?? k}{gate && <><Hand size={11} color="var(--st-wait)" /> duyệt lại</>}</span>
              </span>
            );
          }) : <span className="muted">(không có bước phụ thuộc)</span>}
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>Các bước phía trước giữ nguyên kết quả; attempt cũ vẫn xem được trong History.</div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button disabled={busy} onClick={async () => {
          setBusy(true);
          const r = await onSubmit({ ...(text.trim() ? { feedback: text.trim() } : {}), ...(skills.length ? { skills } : {}) });
          setBusy(false);
          if (r !== undefined) (setOpen(false), setText(""), setSkills([]));
        }}><RotateCcw size={14} />{busy ? "Đang tạo…" : "Xác nhận chạy lại"}</button>
        <button className="ghost" onClick={() => setOpen(false)}>Huỷ</button>
      </div>
    </section>
  );
}

function KnowledgeApplied({ snapshot }: { snapshot: any }) {
  if (!snapshot) return <Empty>Chưa có context snapshot (bước chưa chạy).</Empty>;
  const c = snapshot.content;
  const plan = new Map<string, any>((c.prompt_plan?.knowledge ?? []).map((d: any) => [d.key, d]));
  const TIER: Record<string, string> = { inline: "COMPLETED", index: "READY", search: "PENDING" };
  const groups: Record<string, any[]> = {};
  for (const k of c.knowledge) (groups[k.category] ??= []).push(k);
  return (
    <div>
      <div className="rv-card soft small" style={{ padding: "9px 12px" }}>
        Snapshot #{snapshot.id} · <span className="mono">{snapshot.hash.slice(0, 16)}</span> · project {c.project || "—"} · repos {c.repositories.join(", ") || "—"} · {time(snapshot.created_at)}
      </div>
      {!c.knowledge.length && <Empty>Không có knowledge nào áp dụng cho bước này.</Empty>}
      {Object.entries(groups).map(([cat, items]) => (
        <div key={cat}>
          <h3>{CATEGORY_LABEL[cat] ?? cat}</h3>
          {items.map((k) => (
            <details key={k.key} className="rv-card" style={{ padding: "8px 12px", margin: "6px 0" }}>
              <summary style={{ color: "var(--ink)" }}>
                <b>{k.title}</b> <span className="mono muted">{k.key} v{k.version}</span> <span className="muted small">· {k.reason}</span>{" "}
                {plan.get(k.key) && <Badge s={TIER[plan.get(k.key).disclosure]}>{plan.get(k.key).disclosure} · {plan.get(k.key).score}</Badge>}
                {plan.get(k.key) && <div className="muted small" style={{ marginLeft: 16 }}>{plan.get(k.key).why}</div>}
              </summary>
              <Markdown text={k.content} />
              <div className="row tight"><a href={`#/knowledge/${k.key}`} className="small">Mở trong Knowledge →</a></div>
            </details>
          ))}
        </div>
      ))}
      {c.prompt_plan?.upstream && Object.keys(c.prompt_plan.upstream).length > 0 && (
        <>
          <h3>Upstream trong prompt</h3>
          {Object.entries<any>(c.prompt_plan.upstream).map(([k, u]) => (
            <div key={k} className="small" style={{ padding: "2px 0" }}><b>{k}</b> {u.direct && <span className="muted">(trực tiếp)</span>} — {u.mode === "full" ? "đầy đủ" : <span style={{ color: "var(--st-wait)" }}>tóm tắt</span>} ~{u.tokens} / {u.full_tokens} tokens</div>
          ))}
        </>
      )}
      {c.overridden?.length > 0 && (
        <>
          <h3>Overridden</h3>
          {c.overridden.map((o: any) => <div key={o.key} className="small muted">✗ {o.key} v{o.version} bị ghi đè bởi <b>{o.by}</b> (conflict key {o.conflict_key})</div>)}
        </>
      )}
      {c.missing_explicit?.length > 0 && <div className="errorbox small">Được gán nhưng không tìm thấy/không bật: {c.missing_explicit.join(", ")}</div>}
    </div>
  );
}

export function Artifacts({ artifacts }: { artifacts: any[] }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const { data } = useApi<any>(openId ? `/api/artifacts/${openId}` : null, [openId]);
  if (!artifacts.length) return <Empty>Không có artifact.</Empty>;
  return (
    <div>
      {artifacts.map((a) => (
        <button key={a.id} type="button" className="ghost rp-file" aria-expanded={openId === a.id}
          style={{ width: "100%", justifyContent: "flex-start", whiteSpace: "normal", textAlign: "left", fontWeight: 400, ...(openId === a.id ? { borderColor: "var(--brand)", background: "var(--brand-50)" } : {}) }}
          onClick={() => setOpenId(openId === a.id ? null : a.id)}>
          <Paperclip size={14} color="var(--brand)" />
          <b className="grow" style={{ overflowWrap: "anywhere" }}>{a.name}</b>
          <span className="muted small">{a.kind} · {a.size} chars{a.data?.exit_code != null && ` · exit ${a.data.exit_code}`}</span>
        </button>
      ))}
      {openId && data && data.id === openId && (
        <div className="rv-card">
          <div className="rv-card-head"><h4><Paperclip size={15} /> {data.name}</h4><Copy text={data.content} /></div>
          {data.name.endsWith(".md") ? <Markdown text={data.content} /> : <pre>{data.content}</pre>}
          {data.data && <JsonBlock value={data.data} title="Data" />}
        </div>
      )}
    </div>
  );
}
