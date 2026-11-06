import { useEffect, useRef, useState, type ReactNode } from "react";
import { agentKey, asProvider, type AgentProvider } from "../agentProvider.tsx";
import {
  AlertTriangle, ArrowRight, BookOpen, Check, CheckCircle2, ChevronRight, CircleDashed, ClipboardList, Cpu, FileDiff, FileText, FlaskConical, Hand, History,
  Info, Layers, ListChecks, LogIn, LogOut, MessageCircleQuestion, MessagesSquare, Paperclip, Play, RotateCcw, Send, ShieldAlert, ShieldCheck, SkipForward,
  Square, SquareTerminal, Timer, Wrench, X, XCircle, Sparkles, Bot,
} from "lucide-react";
import { api, STATUS_COLORS, useApi } from "../api.ts";
import { act, Badge, Copy, dur, Empty, ErrorBox, JsonBlock, Loading, Markdown, Tabs, time, navigate } from "../ui.tsx";
import { stepTypeIcon } from "../graph.tsx";
import { useI18n } from "../i18n/index.tsx";
import { Transcript } from "./Transcript.tsx";
import { ReportPanel } from "./Report.tsx";
import "./RunView.css";

const AGENT_TYPES = ["agent", "coding_agent"];
type Tab = "report" | "overview" | "execution" | "input" | "output" | "knowledge" | "qa" | "artifacts" | "history";

const TabLabel = ({ icon: I, children }: { icon: typeof Info; children: ReactNode }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><I size={13} strokeWidth={2} />{children}</span>
);

/** Render a step output: Markdown for summary-like strings, then the full structure. */
export function OutputView({ value }: { value: any }) {
  const { t } = useI18n();
  if (value == null) return <Empty>{t("si.noOutput")}</Empty>;
  const text = typeof value === "string" ? value : value.summary ?? value.report ?? null;
  return (
    <div>
      {typeof text === "string" && (
        <div className="rv-card">
          <div className="rv-card-head"><h4><FileText size={15} /> {t("si.summary")}</h4><Copy text={text} /></div>
          <Markdown text={text} />
        </div>
      )}
      <JsonBlock value={value} title={t("si.output")} />
    </div>
  );
}

export function QuestionsForm({ questions, onDone, provider = "claude" }: { questions: any[]; onDone: () => void; provider?: AgentProvider }) {
  const { t } = useI18n();
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
    <section className="rv-attn" aria-label={t("si.questionsWaiting")}>
      <div className="rv-attn-head">
        <span className="rv-attn-icon"><MessageCircleQuestion size={20} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h4>{t("si.waitingAnswers", { n: questions.length, name: t(agentKey(provider, true)) })}</h4>
          <div className="rv-attn-sub">{t("si.pausedUntil")}</div>
        </div>
      </div>
      {questions.map((q) => (
        <div key={q.id} className="q">
          <div className="row tight" style={{ alignItems: "flex-start" }}><b className="grow">{q.question}</b><Copy text={q.question} /></div>
          {q.context && <div className="muted small" style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>{q.context}</div>}
          {!!q.options?.length && (
            <div className="rv-option-row">
              {q.options.map((o: string, i: number) => (
                <button key={o} className={answers[q.id] === o ? "sm" : "ghost sm"} aria-pressed={answers[q.id] === o} onClick={() => setAnswers({ ...answers, [q.id]: o })} title={i === 0 ? t("si.suggested") : undefined}>
                  {answers[q.id] === o ? <Check size={13} /> : i === 0 ? <Sparkles size={13} /> : null}{o}
                </button>
              ))}
            </div>
          )}
          <textarea rows={2} placeholder={q.suggested_answer ? t("si.suggestion", { text: q.suggested_answer }) : t("si.answerPh")} value={answers[q.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
        </div>
      ))}
      <div className="rv-attn-actions">
        <button className="big" disabled={busy || !Object.values(answers).some((a) => a.trim())} onClick={submit}><Send size={15} />{busy ? t("si.sending") : t("si.sendContinue")}</button>
      </div>
      <div className="rv-note" style={{ marginBottom: 0 }}><Info size={13} />{t("si.savedNote")}</div>
    </section>
  );
}

export function ApprovalPanel({ run, step, onDone }: { run: any; step: any; onDone: () => void }) {
  const { t } = useI18n();
  const req = step.approval?.request;
  const gate = step.approval?.gate && !step.approval?.granted;
  const [comment, setComment] = useState("");
  const [repos, setRepos] = useState<string[]>(req?.recommended ?? run.selected_repositories ?? []);
  const [branch, setBranch] = useState<string>(req?.branch ?? "");
  const [branches, setBranches] = useState<Record<string, string>>(() => ({ ...(req?.branches ?? {}) }));
  const [repoFilter, setRepoFilter] = useState("");
  const allowed: string[] = req?.allowed ?? run.allowed_repositories ?? [];
  const candidateNames = new Set<string>((req?.candidates ?? []).map((c: any) => c.repo));
  // Every allowed repository the discovery did not suggest, plus anything already selected that is not a candidate
  // (e.g. reused from an earlier run), so the reviewer can add or remove any repo, not only the suggested ones.
  const others = [...new Set([...allowed, ...repos])].filter((r) => !candidateNames.has(r)).sort();
  const f = repoFilter.trim().toLowerCase();
  const shownOthers = f ? others.filter((r) => r.toLowerCase().includes(f) || repos.includes(r)) : others;
  const toggleRepo = (r: string, on: boolean) => setRepos((cur) => (on ? [...new Set([...cur, r])] : cur.filter((x) => x !== r)));
  // "payment-fiserv: Nhánh split/8-channel-splitting  payment_gateway_global: Nhánh split/6-channel-splitting" pasted
  // into the common field fills the per-repository fields instead.
  const onCommon = (v: string) => {
    const names: string[] = [...new Set([...(req?.candidates ?? []).map((c: any) => c.repo), ...(req?.allowed ?? run.allowed_repositories ?? [])])];
    const found: Record<string, string> = {};
    for (const m of v.matchAll(/([A-Za-z0-9._-]+)\s*:\s*(?:nhánh|branch)?\s*([A-Za-z0-9][A-Za-z0-9._\/-]*)/gi)) if (names.includes(m[1])) found[m[1]] = m[2];
    if (Object.keys(found).length) {
      setBranches((b) => ({ ...b, ...found }));
      setRepos((r) => [...new Set([...r, ...Object.keys(found)])]);
      setBranch("");
    } else setBranch(v);
  };
  const send = async (approve: boolean) => {
    const body: any = { comment };
    if (approve && req?.select_repositories) body.repositories = repos;
    if (approve && req?.ask_branch) body.data = { branch: branch.trim(), branches: Object.fromEntries(repos.map((r) => [r, (branches[r] ?? "").trim()])) };
    const r = await act(() => api(`/api/runs/${run.id}/steps/${step.key}/${approve ? "approve" : "reject"}`, body), approve ? t("si.approved") : t("si.rejected"));
    if (r) onDone();
  };
  const reexec = step.config?.on_reject?.reexecute;
  return (
    <section className="rv-attn" aria-label={t("si.needsApproval")}>
      <div className="rv-attn-head">
        <span className="rv-attn-icon"><Hand size={20} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h4>{gate ? t("si.approveBefore") : req?.message ?? t("si.needsApproval")}</h4>
          <div className="rv-attn-sub">{t("si.stoppedAt", { step: step.name })}</div>
        </div>
      </div>
      {step.type === "git_pull_request" && (
        <div className="row">
          <button className="ghost sm" onClick={() => navigate(`/runs/${run.id}/~changes`)}><FileDiff size={14} /> {t("si.seeChanges")}</button>
        </div>
      )}
      {req?.select_repositories && (
        <div style={{ marginTop: 10 }}>
          <div className="small" style={{ color: req.ambiguous ? "var(--st-wait)" : "var(--ink-2)", fontWeight: 600, display: "flex", gap: 6, alignItems: "center" }}>
            {req.ambiguous && <AlertTriangle size={14} />}{req.ambiguous ? t("si.ambiguous") : t("si.suggestedRepos")}
          </div>
          {(req.candidates ?? []).map((c: any) => (
            <label key={c.repo} className="rv-repo-opt">
              <input type="checkbox" checked={repos.includes(c.repo)} onChange={(e) => toggleRepo(c.repo, e.target.checked)} />
              <span style={{ minWidth: 0 }}>
                <b>{c.repo}</b> <span className="muted small">{t("si.score", { n: c.score })}</span>
                <br />
                <span className="muted small">{(c.reasons ?? []).join(" · ")}</span>
              </span>
            </label>
          ))}
          {others.length > 0 && (
            <div className="rv-repo-more">
              <div className="rv-repo-more-head">
                <span className="small" style={{ fontWeight: 600, color: "var(--ink-2)" }}>{t("si.otherRepos", { n: others.length })}</span>
                {others.length > 8 && <input className="sm" type="search" value={repoFilter} placeholder={t("si.filterRepos")} aria-label={t("si.filterRepos")} onChange={(e) => setRepoFilter(e.target.value)} />}
              </div>
              <div className="rv-repo-chips">
                {shownOthers.map((r) => (
                  <label key={r} className={`rv-repo-chip${repos.includes(r) ? " on" : ""}`}>
                    <input type="checkbox" checked={repos.includes(r)} onChange={(e) => toggleRepo(r, e.target.checked)} />
                    <span className="mono">{r}</span>
                  </label>
                ))}
                {shownOthers.length === 0 && <span className="muted small">{t("si.noRepoMatch")}</span>}
              </div>
            </div>
          )}
          {req.ask_branch && (
            <div className="si-branch">
              <span className="small" style={{ fontWeight: 600, color: "var(--ink-2)" }}>{t("si.branch")}</span>
              <input className="mono" value={branch} placeholder={t("si.branchCommonPh")} onChange={(e) => onCommon(e.target.value)} />
              {repos.length > 0 && (
                <div className="si-branch-grid">
                  {repos.map((r) => (
                    <label key={r} className="si-branch-row">
                      <span className="mono small">{r}</span>
                      <input className="mono" value={branches[r] ?? ""} placeholder={branch.trim() || t("si.branchBase")} onChange={(e) => setBranches((b) => ({ ...b, [r]: e.target.value }))} />
                    </label>
                  ))}
                </div>
              )}
              <span className="muted small">{t("si.branchHint")}</span>
            </div>
          )}
        </div>
      )}
      {Object.entries(req?.outputs ?? {}).map(([k, v]) => (
        <details key={k} open style={{ marginTop: 8 }}>
          <summary>{t("si.stepOutput", { step: k })}</summary>
          <OutputView value={v} />
        </details>
      ))}
      <textarea rows={2} placeholder={gate ? t("si.gateCommentPh") : t("si.commentPh")} value={comment} onChange={(e) => setComment(e.target.value)} style={{ marginTop: 10, background: "var(--surface)" }} />
      <div className="rv-consequence">
        <CheckCircle2 size={14} color="var(--st-ok)" /><span>{req?.select_repositories ? t("si.approveRepos", { n: repos.length }) : t("si.approveDoes")}</span>
        <XCircle size={14} color="var(--st-err)" /><span>{reexec ? t("si.rejectRedo", { step: reexec }) : t("si.rejectDoes")}</span>
      </div>
      <div className="rv-attn-actions">
        <button className="ok big" onClick={() => send(true)}><ShieldCheck size={16} /> {t("si.approve")}</button>
        {gate && (
          <button className="ghost" title={t("si.skipGateHint")} onClick={async () => (await act(() => api(`/api/runs/${run.id}/steps/${step.key}/skip`, { reason: comment || "skipped by user" }), t("si.skipped"))) && onDone()}>
            {t("si.skipGate")}
          </button>
        )}
        <button className="danger" onClick={() => send(false)}><X size={15} /> {reexec ? t("si.rejectRedoBtn", { step: reexec }) : t("si.reject")}</button>
      </div>
    </section>
  );
}

export function StepInspector({ run, stepKey, tick, onChanged }: { run: any; stepKey: string; tick: number; onChanged: () => void }) {
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi<any>(`/api/runs/${run.id}/steps/${stepKey}`);
  const [tab, setTab] = useState<Tab>(stepKey === "task_result_report" ? "report" : "overview");
  const [attemptId, setAttemptId] = useState<number | null>(null);
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
    ...(step.type === "task_result_report" ? ([["report", <TabLabel icon={ClipboardList}>{t("si.tab.report")}</TabLabel>]] as Array<[Tab, React.ReactNode]>) : []),
    ["overview", <TabLabel icon={Info}>{t("si.tab.overview")}</TabLabel>],
    ...(isAgent ? ([["execution", <TabLabel icon={Bot}>{t(agentKey(run.agent_provider, true))} {live && <span className="spinner" />}</TabLabel>]] as Array<[Tab, React.ReactNode]>) : []),
    ...(step.type === "command" ? ([["execution", <TabLabel icon={SquareTerminal}>{t("si.tab.live")} {live && <span className="spinner" />}</TabLabel>]] as Array<[Tab, React.ReactNode]>) : []),
    ["input", <TabLabel icon={LogIn}>{t("si.tab.input")}</TabLabel>],
    ["output", <TabLabel icon={LogOut}>{t("si.tab.output")}</TabLabel>],
    ["knowledge", <TabLabel icon={BookOpen}>{`${t("si.tab.knowledge")}${snapshot ? ` (${snapshot.content.knowledge.length})` : ""}`}</TabLabel>],
    ["qa", <TabLabel icon={MessagesSquare}>{`${t("si.tab.qa")}${questions.length ? ` (${questions.length})` : ""}`}</TabLabel>],
    ["artifacts", <TabLabel icon={Paperclip}>{`${t("si.tab.artifacts")}${artifacts.length ? ` (${artifacts.length})` : ""}`}</TabLabel>],
    ["history", <TabLabel icon={History}>{`${t("si.tab.history")} (${attempts.length})`}</TabLabel>],
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
              <span>{t("cl.gen")} {step.generation}</span>
              <span>{attempt ? t("si.attemptN", { n: attempt.number }) : t("si.notRun")}{attempts.length > 1 ? ` / ${attempts.length}` : ""}</span>
            </div>
          </div>
          <button className="quiet icon" aria-label={t("si.closeInspector")} title={t("common.close")} onClick={() => navigate(`/runs/${run.id}`)}><X size={18} /></button>
        </div>
        {(canRun || canRetry || canSkip || ["RUNNING", "RETRYING"].includes(step.status) || attempts.length > 1) && (
          <div className="si-actions">
            {canRun && <button className="sm" onClick={() => action("run", {}, t("si.queued"))}><Play size={13} /> {t("si.runStep")}</button>}
            {canRetry && <button className="sm warn" onClick={() => action("retry", {}, t("si.retrying"))}><RotateCcw size={13} /> {t("si.retry")}</button>}
            {canRetry && step.type === "command" && step.config?.baseline_compare !== "go" && (
              <button className="sm ghost" title={t("si.retryBaselineTip")}
                onClick={() => action("retry", { input: { config_overrides: { baseline_compare: "go" } } }, t("si.retryingBaseline"))}><Layers size={13} /> {t("si.retryBaseline")}</button>
            )}
            {canSkip && <button className="sm ghost" onClick={() => confirm(t("si.skipAsk")) && action("skip")}><SkipForward size={13} /> {t("si.skip")}</button>}
            {["RUNNING", "RETRYING"].includes(step.status) && (
              <button className="sm danger" onClick={() => confirm(t("si.stopAsk")) && action("stop", {}, t("si.stopped"))}><Square size={12} /> {t("si.stop")}</button>
            )}
            {attempts.length > 1 && (
              <select aria-label={t("si.pickAttempt")} value={attempt?.id} onChange={(e) => setAttemptId(Number(e.target.value))}>
                {attempts.map((a: any) => (
                  <option key={a.id} value={a.id}>{t("si.attemptN", { n: a.number })} · {t("cl.gen")} {a.generation} · {t("status." + a.status)}{a.invalidated_at ? ` (${t("si.invalidated")})` : ""}</option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      <div className="si-body">
        {step.status === "WAITING_INPUT" && <QuestionsForm questions={open} onDone={refresh} provider={asProvider(run.agent_provider)} />}
        {step.status === "WAITING_APPROVAL" && step.type !== "task_result_report" && <ApprovalPanel run={run} step={step} onDone={refresh} />}
        {step.type === "task_result_report" && step.status === "WAITING_APPROVAL" && tab !== "report" && (
          <div className="rv-attn" style={{ padding: "12px 16px" }}>
            <div className="rv-attn-head" style={{ alignItems: "center" }}>
              <span className="rv-attn-icon"><Hand size={18} /></span>
              <div style={{ flex: 1 }}><b>{t("si.reportWaiting")}</b></div>
              <button className="sm" onClick={() => setTab("report")}>{t("si.openReport")} <ArrowRight size={13} /></button>
            </div>
          </div>
        )}
        {step.error && (
          <div className="errorbox">
            <div className="row tight"><XCircle size={15} color="var(--st-err)" /><b className="grow">{t("common.error")}</b><Copy text={step.error} /></div>
            <div className="mono" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{step.error}</div>
          </div>
        )}
        <Tabs tabs={tabs} value={tab} onChange={setTab} />

        {tab === "report" && <ReportPanel run={run} step={step} artifacts={artifacts} attempts={attempts} onChanged={refresh} />}
        {tab === "overview" && (
          <div>
            {verification && <VerificationCard v={verification} />}
            {(attempt?.output?.verdict || attempt?.error?.details?.verdict) && <VerdictCard v={attempt.output?.verdict ? attempt.output : attempt.error.details} />}
            {attempt?.error?.failure && <FailureCard f={attempt.error.failure} />}
            {step.type === "command" && <TestFailurePanel attempts={attempts} questions={questions} current={attempt} step={step} />}
            {step.type === "command" && <BaselineSummary results={(attempt?.output ?? attempt?.error?.details)?.results} />}
            {attempt?.metrics && <AttemptMetrics m={attempt.metrics} />}
            <div className="rv-card">
              <div className="rv-card-head"><h4><ListChecks size={15} /> {t("si.details")}</h4></div>
              <div className="rv-kv">
                <span>{t("wi.status")}</span><span><Badge s={step.status} /></span>
                <span>{t("si.depends")}</span><span className="mono">{step.depends_on.join(", ") || "—"}</span>
                <span>{t("si.maxAttempts")}</span><span>{step.max_attempts} ({t("si.backoff", { n: step.retry_backoff_s })})</span>
                <span>{t("si.gate")}</span><span>{step.requires_approval ? t("si.yes") : t("si.no")}</span>
                {step.run_if && <><span>{t("si.runIf")}</span><span className="mono">{JSON.stringify(step.run_if)}</span></>}
                <span>{t("si.started")}</span><span>{time(step.started_at) || "—"}</span>
                <span>{t("si.finished")}</span><span>{time(step.finished_at) || "—"}</span>
                {sessions.length > 0 && <><span>{t("si.session")}</span><span className="mono small">{sessions[sessions.length - 1].session_id} {sessions[sessions.length - 1].model && `(${sessions[sessions.length - 1].model})`}</span></>}
              </div>
            </div>
            {step.config?.instructions && (
              <div className="rv-card">
                <div className="rv-card-head"><h4><FileText size={15} /> {t("si.instructions")}</h4><Copy text={step.config.instructions} /></div>
                <Markdown text={step.config.instructions} />
              </div>
            )}
            <JsonBlock value={step.config} title={t("si.config")} />
            {attempt?.input?.pending?.reexecute && <ReexecuteInfo rx={attempt.input.pending.reexecute} prev={attempt.input.previous_attempt?.number} />}
            {canReexec && <ReexecuteDialog run={run} step={step} onSubmit={(body) => action("reexecute", body, t("si.reopened"))} />}
            {checkpoints.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary>{t("si.checkpoints", { n: checkpoints.length })}</summary>
                {checkpoints.map((c: any) => (
                  <div key={c.id} className="small" style={{ padding: "3px 0", borderBottom: "1px dashed var(--line)" }}><span className="muted">{time(c.created_at)}</span> <b>{c.reason}</b> <span className="mono">{JSON.stringify(c.data).slice(0, 300)}</span></div>
                ))}
              </details>
            )}
          </div>
        )}
        {tab === "execution" && (!attempt ? <Empty>{t("si.notStarted")}</Empty> : isAgent ? <Transcript attemptId={attempt.id} live={live} tick={tick} provider={asProvider(run.agent_provider)} /> : <CommandLog attemptId={attempt.id} live={live} tick={tick} startedAt={attempt.started_at} />)}
        {tab === "input" && (attempt ? <JsonBlock value={attempt.input} title={t("si.resolvedInput", { n: attempt.number })} /> : <Empty>{t("si.inputLater")}</Empty>)}
        {tab === "output" && (
          <div>
            <OutputView value={attempt && attempt.id !== step.current_attempt_id ? attempt.output : step.output} />
            {attempt?.error && <JsonBlock value={attempt.error} title={t("si.attemptError")} />}
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
                <div className="muted small" style={{ marginTop: 6 }}>{t("si.attemptOf", { n: attempts.find((a: any) => a.id === q.attempt_id)?.number ?? "?" })} · {time(q.created_at)}</div>
              </div>
            ))
          ) : (
            <Empty>{t("si.noQuestions")}</Empty>
          ))}
        {tab === "artifacts" && <Artifacts artifacts={artifacts} />}
        {tab === "history" && (
          <div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>#</th><th>{t("cl.gen")}</th><th>{t("wi.status")}</th><th>{t("si.started")}</th><th>{t("si.finished")}</th><th>{t("si.worker")}</th><th>{t("common.error")}</th></tr></thead>
                <tbody>
                  {attempts.map((a: any) => (
                    <tr key={a.id} className="click" style={{ opacity: a.invalidated_at ? 0.6 : 1, background: a.id === attempt?.id ? "var(--sel)" : undefined }} onClick={() => (setAttemptId(a.id), setTab(isAgent ? "execution" : "output"))}>
                      <td><b>{a.number}</b></td><td>{a.generation}</td><td><Badge s={a.status} />{a.invalidated_at && <div className="muted small">{t("si.invalidated")}</div>}
                        {a.input?.pending?.reexecute && (
                          <div className="small" style={{ marginTop: 2 }}>
                            <RotateCcw size={11} style={{ verticalAlign: -1 }} /> {a.input.pending.reexecute.instructions ? `“${String(a.input.pending.reexecute.instructions).slice(0, 80)}”` : t("si.reexecuteWord")}
                            {a.input.pending.reexecute.skills?.length > 0 && <span className="muted"> · {a.input.pending.reexecute.skills.map((s: any) => `${s.key}@v${s.version}`).join(", ")}</span>}
                          </div>
                        )}
                      </td>
                      <td className="small">{time(a.started_at)}</td><td className="small">{time(a.finished_at)}</td><td className="mono small">{(a.worker ?? "").split(":").slice(-1)[0]}</td>
                      <td className="err small">{a.error?.failure && <span className="pill" title={a.error.failure.reason}>{a.error.failure.class} → {a.error.failure.action}</span>} {a.error?.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rv-sec">
              <div className="rv-sec-title"><Cpu size={14} /> {t("si.jobs")}</div>
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

const VF_TONE: Record<string, "ok" | "err" | "wait" | "idle"> = {
  passed: "ok", failed: "err", no_progress: "err", error: "err", canceled: "idle", stopped: "wait", skipped: "idle", accepted_with_preexisting: "wait",
};
const TONE_STATUS = { ok: "COMPLETED", err: "FAILED", wait: "WAITING", idle: "SKIPPED" } as const;
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Harness verification-and-repair result (attempt metrics / output `verification`). Renders only the fields present. */
function VerificationCard({ v }: { v: any }) {
  const { t } = useI18n();
  if (!v || typeof v !== "object") return null;
  const outcome = typeof v.outcome === "string" ? v.outcome : v.passed === true ? "passed" : v.passed === false ? "failed" : "";
  const tone = VF_TONE[outcome] ?? (v.passed === true ? "ok" : v.passed === false ? "err" : "idle");
  const label = VF_TONE[outcome] ? t(`si.vf.${outcome}`) : (outcome || t("si.unknown"));
  const rounds = num(v.rounds);
  const repairs = num(v.repairs);
  const maxRepairs = num(v.max_repairs);
  const sigs = arr(v.failure_signatures);
  const last = arr(v.last);
  return (
    <section className={`vf tone-${tone}`} aria-label={t("si.verify")}>
      <div className="rv-card-head" style={{ marginBottom: 4 }}>
        <h4><FlaskConical size={16} /> {t("si.verify")}</h4>
        <Badge s={TONE_STATUS[tone]}>{label}</Badge>
        {num(v.duration_ms) != null && <span className="muted small" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}><Timer size={12} />{dur(v.duration_ms)}</span>}
      </div>
      {v.reason && <div className="muted small">{String(v.reason)}</div>}
      {rounds != null && rounds > 0 && (
        <div className="vf-steps" role="list" aria-label={t("si.rounds")}>
          {Array.from({ length: rounds }, (_, i) => {
            const state = i < sigs.length ? "fail" : v.passed === true && i === rounds - 1 ? "pass" : "unknown";
            return (
              <div key={i} style={{ display: "contents" }}>
                {i > 0 && <span className="vf-link" aria-hidden />}
                <div className="vf-step" role="listitem" title={state === "fail" ? String(sigs[i]) : undefined}>
                  <span className={`vf-dot ${state}`}>{state === "pass" ? <Check size={13} strokeWidth={3} /> : state === "fail" ? <X size={13} strokeWidth={3} /> : <CircleDashed size={13} />}</span>
                  <span>{i === 0 ? t("si.check") : t("si.repairN", { n: i })}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {(repairs != null || rounds != null) && (
        <div className="vf-budget" style={{ marginTop: 6, flexWrap: "wrap" }}>
          {rounds != null && <span>{t("si.roundN", { n: rounds })}</span>}
          {repairs != null && (
            <>
              <span>· {t("si.repairs", { n: repairs })}{maxRepairs != null ? ` / ${maxRepairs}` : ""}</span>
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
              {r?.timed_out ? <Badge s="FAILED">{t("si.timeout")}</Badge> : r?.exit_code != null && <span className="mono muted small">{t("si.exit", { code: String(r.exit_code) })}</span>}
              {r?.artifact_id != null && <a className="small" href={`/api/artifacts/${r.artifact_id}/raw`} target="_blank" rel="noopener">{t("si.log")}</a>}
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
                <ShieldAlert size={13} style={{ flex: "none", marginTop: 2 }} /><span>{t("si.weakened", { list: weakened.join(", ") })}</span>
              </div>
            )}
            {pre != null && pre > 0 && <div className="muted small" style={{ marginTop: 4 }}>{t("si.preexisting", { n: pre })}</div>}
            {r?.note && <div className="muted small" style={{ marginTop: 4 }}>{String(r.note)}</div>}
          </div>
        );
      })}
      {sigs.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary>{t("si.signatures", { n: sigs.length })}</summary>
          {sigs.map((s: unknown, i: number) => <div key={i} className="mono small" style={{ overflowWrap: "anywhere", padding: "2px 0" }}>{i + 1}. {String(s)}</div>)}
        </details>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- command steps

const CAT_STATUS: Record<string, string> = { new: "FAILED", pre_existing: "WAITING", environment: "PAUSED", insufficient: "PENDING" };

/** Test failure diagnosis (real output + baseline), AI explanation, and the exchange/decision history of this step. */
function TestFailurePanel({ attempts, questions, current, step }: { attempts: any[]; questions: any[]; current: any; step: any }) {
  const { t } = useI18n();
  const payload = (a: any) => a?.output ?? a?.error?.details;
  const withDiag = [...attempts].reverse().find((a) => payload(a)?.diagnosis);
  const d = payload(current)?.diagnosis ?? payload(withDiag)?.diagnosis;
  const decisions = attempts.filter((a) => payload(a)?.decision).map((a) => ({ n: a.number, ...payload(a).decision }));
  const exception = step.output?.accepted_exception;
  if (!d && !decisions.length) return null;
  const groups = (["new", "pre_existing", "environment", "insufficient"] as const).filter((k) => d?.failures.some((f: any) => f.category === k));
  return (
    <div className={step.status === "WAITING_INPUT" ? "rv-attn" : "rv-card"} style={step.status === "WAITING_INPUT" ? { boxShadow: "none" } : undefined}>
      <div className="rv-card-head"><h4><FlaskConical size={16} /> {t("si.diagnosis")}</h4>{step.output?.test_status === "FAILED" && <Badge s="FAILED">{t("si.testFailed")}</Badge>}</div>
      {d && (
        <>
          <div style={{ margin: "4px 0", fontWeight: 600 }}>{d.summary}</div>
          <div className="mono small" style={{ wordBreak: "break-all", background: "var(--code)", padding: "6px 9px", borderRadius: "var(--r-sm)", margin: "6px 0" }}>{d.command.split("\n").find((l: string) => l.includes("go test")) ?? d.command.split("\n")[0]}</div>
          <div className="muted small">
            {d.results.map((r: any) => `${r.repo}: ${t("si.exit", { code: r.timed_out ? t("si.timeout") : r.exit_code })}`).join(" · ")} · baseline {d.baseline_available ? <span className="mono">{String(d.base_sha).slice(0, 9)}</span> : t("si.noBaseline")}
          </div>
          {d.explanation && (
            <div className="rv-card soft" style={{ padding: "10px 12px" }}>
              <div className="small"><b>{d.explanation.by === "claude" ? t("si.ai") : t("si.brief")}:</b> {d.explanation.text}</div>
              <div className="small" style={{ marginTop: 4 }}><b>{t("si.proposal")}:</b> {d.explanation.suggestion}</div>
            </div>
          )}
          {groups.map((g) => (
            <div key={g} style={{ marginTop: 8 }}>
              <Badge s={CAT_STATUS[g]}>{t(`si.cat.${g}`)} · {d.failures.filter((f: any) => f.category === g).length}</Badge>
              {d.failures.filter((f: any) => f.category === g).map((f: any, i: number) => (
                <details key={i} style={{ marginLeft: 8 }}>
                  <summary style={{ color: "var(--ink)" }}>
                    <span className="mono small">{f.repo} {f.package?.split("/").slice(-2).join("/")} {f.test ?? f.build_error ?? ""}</span> <span className="muted small">— {f.reason}{f.env_signal && g !== "environment" ? ` ${t("si.envHint")}` : ""}</span>
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
          <AlertTriangle size={14} />{t("si.acceptedBaseline", { n: exception.failures.length })}
        </div>
      )}
      {(questions.length > 0 || decisions.length > 0) && (
        <div style={{ marginTop: 10 }}>
          <b className="small">{t("si.exchange")}</b>
          {attempts.map((a) => {
            const qs = questions.filter((q: any) => q.attempt_id === a.id);
            const dec = payload(a)?.decision;
            if (!qs.length && !dec) return null;
            return (
              <div key={a.id} className="small" style={{ margin: "6px 0", paddingLeft: 10, borderLeft: "2px solid var(--line-strong)" }}>
                <span className="muted">attempt #{a.number} · {a.status}</span>
                {dec && <div><ChevronRight size={12} style={{ verticalAlign: -2 }} /> {t("si.decision", { kind: t(`si.dec.${dec.kind}`) === `si.dec.${dec.kind}` ? dec.kind : t(`si.dec.${dec.kind}`) })}{dec.target ? ` (${dec.target})` : ""}{dec.instructions ? ` — “${dec.instructions}”` : ""}</div>}
                {qs.map((q: any) => (
                  <div key={q.id}>
                    <MessageCircleQuestion size={12} style={{ verticalAlign: -2, color: "var(--st-wait)" }} /> {q.question}
                    {q.answer ? <> <br /><MessagesSquare size={12} style={{ verticalAlign: -2, color: "var(--st-ok)" }} /> <b>{q.answer}</b></> : q.status === "open" ? <span className="muted"> ({t("si.waiting")})</span> : <span className="muted"> ({q.status})</span>}
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
  const { t } = useI18n();
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
      <div className="rv-card-head"><h4><Layers size={16} /> {t("si.vsBaseline")}</h4></div>
      {withBase.map((r) => (
        <div key={r.repo} className="vf-repo">
          <div className="vf-repo-head">
            <b className="grow">{r.repo}</b>
            {r.baseline.regressions && (r.baseline.regressions.length ? <Badge s="FAILED">{t("si.regressions", { n: r.baseline.regressions.length })}</Badge> : <Badge s="COMPLETED">{t("si.noRegression")}</Badge>)}
          </div>
          {r.baseline.note ? <div className="muted small">{r.baseline.note}</div> : <div className="muted small mono">base {String(r.baseline.base_sha).slice(0, 9)}</div>}
          {r.baseline.regressions?.length > 0 && <div className="err small" style={{ marginTop: 6, fontWeight: 600 }}>{t("si.newFaults")}</div>}
          {r.baseline.regressions?.map((x: any) => <Item key={x.package} x={x} />)}
          {r.baseline.pre_existing?.length > 0 && <div className="muted small" style={{ marginTop: 6 }}>{t("si.oldFaults")}</div>}
          {r.baseline.pre_existing?.map((x: any) => <Item key={"p" + x.package} x={x} />)}
        </div>
      ))}
    </div>
  );
}

/** Live stdout/stderr of a command step, streamed as "log" events while it runs. */
function CommandLog({ attemptId, live, tick, startedAt }: { attemptId: number; live: boolean; tick: number; startedAt: string }) {
  const { t } = useI18n();
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
          {live ? <><span className="spinner" /> {t("si.runningFor", { secs: Math.round((Date.now() - new Date(startedAt).getTime()) / 1000), quiet })}</> : <><CheckCircle2 size={13} /> {t("si.done")}</>}
          {live && quiet > 60 && <span style={{ color: "var(--st-wait)" }}> — {t("si.quiet")}</span>}
        </span>
        <label><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> {t("si.follow")}</label>
        <Copy text={text} />
      </div>
      <pre ref={box} className="rv-term">{text || t("si.noLog")}</pre>
    </div>
  );
}

function AttemptMetrics({ m }: { m: any }) {
  const { t } = useI18n();
  const tools = Object.entries<number>(m.tool_calls ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rv-card">
      <div className="rv-card-head"><h4><Cpu size={16} /> {t("si.metrics")}</h4><span className="mono muted small" title={m.model_source ?? ""}>{[m.provider ? t(agentKey(m.provider, true)) : null, m.model || (m.provider && m.provider !== "claude" ? t("run.codex.defaultModel") : null), m.reasoning_effort].filter(Boolean).join(" · ")}</span></div>
      <div className="rv-minis" style={{ marginBottom: 10 }}>
        <div className="rv-mini"><span>{t("si.cost")}</span><b>{m.cost_usd == null ? "—" : `$${Number(m.cost_usd).toFixed(4)}`}</b></div>
        <div className="rv-mini"><span>{t("si.turns")}</span><b>{m.turns ?? "—"}</b></div>
        <div className="rv-mini"><span>{t("si.duration")}</span><b>{Math.round((m.duration_ms ?? 0) / 1000)}s</b></div>
        <div className="rv-mini"><span>{t("si.session")}</span><b>{m.sessions ?? "—"}</b></div>
      </div>
      <div className="rv-kv">
        <span>{t("common.tokens")}</span><span>{m.tokens ? t("si.tokenLine", { inn: m.tokens.input, out: m.tokens.output, read: m.tokens.cache_read, write: m.tokens.cache_creation }) + (m.tokens.reasoning_output ? ` · ${t("si.reasoningTokens", { n: m.tokens.reasoning_output })}` : "") : "—"}</span>
        <span>{t("si.disclosure")}</span><span>{t("si.disclosureLine", { inline: m.disclosure?.inline, index: m.disclosure?.index, search: m.disclosure?.search, full: m.upstream?.full, summary: m.upstream?.summary })}</span>
        <span>{t("common.tools")}</span><span className="small">{tools.map(([k, v]) => `${k.replace("mcp__platform__", "platform·")}×${v}`).join(", ") || "—"}{m.tool_errors ? ` · ${t("si.toolErrors", { n: m.tool_errors })}` : ""}</span>
        <span>{t("si.skillsLoaded")}</span><span className="small">{(m.skills_loaded ?? []).join(", ") || "—"}{m.knowledge_searches?.length ? ` · ${t("si.searched", { q: m.knowledge_searches.map((q: string) => `"${q}"`).join(", ") })}` : ""}</span>
        <span>{t("si.integration")}</span><span className="small">{(m.integration_calls ?? []).map((c: any) => `${c.name} ${c.ok ? "✓" : "✗"} ${c.ms}ms`).join(", ") || "—"}</span>
        <span>{t("si.subagents")}</span><span className="small">{(m.subagents ?? []).map((s: any) => s.type).join(", ") || "—"}</span>
        {m.denied?.length > 0 && <><span>{t("si.blocked")}</span><span className="small err">{m.denied.map((d: any) => `${d.tool}${d.subagent ? ` (${d.subagent})` : ""}: ${d.reason}`).join(" · ")}</span></>}
      </div>
    </div>
  );
}

/** Instructions and skills this attempt was re-executed with (stored with the attempt's input). */
function ReexecuteInfo({ rx, prev }: { rx: any; prev?: number }) {
  const { t } = useI18n();
  return (
    <div className="rv-card" style={{ borderLeft: "3px solid var(--brand)" }}>
      <div className="rv-card-head" style={{ marginBottom: 4 }}>
        <h4><RotateCcw size={15} /> {t("si.thisRerun")}</h4>
        <span className="muted small">{rx.requested_by ? `${t("si.by", { name: rx.requested_by })} · ` : ""}{time(rx.at)}{prev ? ` · ${t("si.fromAttempt", { n: prev })}` : ""}</span>
      </div>
      {rx.instructions ? <div style={{ whiteSpace: "pre-wrap" }}>{rx.instructions}</div> : <div className="muted small">{t("si.noGuidance")}</div>}
      {rx.skills?.length > 0 && <div className="small" style={{ marginTop: 6 }}>{t("kn.cat.agent_skill")}: {rx.skills.map((s: any) => <span key={s.key} className="pill">{s.title ?? s.key} <span className="muted mono">v{s.version}</span></span>)}</div>}
    </div>
  );
}

/** Re-execute this step with optional instructions + skills; shows which dependants will rerun / re-ask approval. */
function ReexecuteDialog({ run, step, onSubmit }: { run: any; step: any; onSubmit: (body: any) => Promise<unknown> }) {
  const { t } = useI18n();
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
        <button className="sm" onClick={() => setOpen(true)}><RotateCcw size={13} /> {t("si.reexecuteWord")}…</button>
        <span className="muted small grow">{t("si.rerunHint")}</span>
      </div>
    );
  return (
    <section className="rv-card" style={{ borderColor: "var(--brand-400)", boxShadow: "0 0 0 3px var(--focus), var(--shadow-2)" }} aria-label={t("si.reexecuteWord")}>
      <div className="rv-card-head">
        <h4><RotateCcw size={16} /> {t("si.rerunTitle", { name: step.name })}</h4>
        <button className="quiet icon" aria-label={t("common.close")} onClick={() => setOpen(false)}><X size={16} /></button>
      </div>
      <label className="field" style={{ marginTop: 0 }}>
        <span>{t("si.guidance")}</span>
        <textarea rows={4} autoFocus placeholder={t("si.guidancePh")} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="field">
        <span>{t("si.skillsThis")} <span className="muted" style={{ fontWeight: 400 }}>({t("si.pinVersion")})</span></span>
        {skills.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {skills.map((k) => (
              <span key={k} className="pill chip-brand">{catalog?.find((c) => c.key === k)?.title ?? k}<button aria-label={t("wfe.remove", { name: k })} onClick={() => setSkills(skills.filter((x) => x !== k))}><X size={11} /></button></span>
            ))}
          </div>
        )}
        <select value="" onChange={(e) => e.target.value && setSkills([...skills, e.target.value])}>
          <option value="">{t("si.addSkill")}</option>
          {(catalog ?? []).filter((c) => !skills.includes(c.key)).map((c) => <option key={c.key} value={c.key}>{c.title} ({c.key} v{c.current_version}){c.enabled ? "" : " [off]"}</option>)}
        </select>
      </div>
      <div className="rv-card soft" style={{ margin: "10px 0 0", padding: "10px 12px" }}>
        <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{t("si.willRerun")}</div>
        <div className="rv-chipline small">
          <span className="pill chip-brand mono">{step.key}</span>
          {affected.length ? affected.map((k) => {
            const s: any = byKey.get(k);
            const gate = s?.requires_approval || s?.type === "human_approval" || s?.type === "task_result_report" || (s?.type === "git_pull_request" && s?.config?.mode === "approval");
            return (
              <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <ChevronRight size={12} color="var(--muted)" />
                <span className="pill" style={{ margin: 0 }}>{s?.name ?? k}{gate && <><Hand size={11} color="var(--st-wait)" /> {t("si.reapprove")}</>}</span>
              </span>
            );
          }) : <span className="muted">{t("si.noDependents")}</span>}
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>{t("si.rerunNote")}</div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button disabled={busy} onClick={async () => {
          setBusy(true);
          const r = await onSubmit({ ...(text.trim() ? { feedback: text.trim() } : {}), ...(skills.length ? { skills } : {}) });
          setBusy(false);
          if (r !== undefined) (setOpen(false), setText(""), setSkills([]));
        }}><RotateCcw size={14} />{busy ? t("pe.creating") : t("si.confirmRerun")}</button>
        <button className="ghost" onClick={() => setOpen(false)}>{t("common.cancel")}</button>
      </div>
    </section>
  );
}

function KnowledgeApplied({ snapshot }: { snapshot: any }) {
  const { t } = useI18n();
  if (!snapshot) return <Empty>{t("si.noSnapshot")}</Empty>;
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
      {!c.knowledge.length && <Empty>{t("si.noKnowledge")}</Empty>}
      {Object.entries(groups).map(([cat, items]) => (
        <div key={cat}>
          <h3>{t(`kn.cat.${cat}`) === `kn.cat.${cat}` ? cat : t(`kn.cat.${cat}`)}</h3>
          {items.map((k) => (
            <details key={k.key} className="rv-card" style={{ padding: "8px 12px", margin: "6px 0" }}>
              <summary style={{ color: "var(--ink)" }}>
                <b>{k.title}</b> <span className="mono muted">{k.key} v{k.version}</span> <span className="muted small">· {k.reason}</span>{" "}
                {plan.get(k.key) && <Badge s={TIER[plan.get(k.key).disclosure]}>{plan.get(k.key).disclosure} · {plan.get(k.key).score}</Badge>}
                {plan.get(k.key) && <div className="muted small" style={{ marginLeft: 16 }}>{plan.get(k.key).why}</div>}
              </summary>
              <Markdown text={k.content} />
              <div className="row tight"><a href={`#/knowledge/${k.key}`} className="small">{t("si.openKnowledge")}</a></div>
            </details>
          ))}
        </div>
      ))}
      {c.prompt_plan?.upstream && Object.keys(c.prompt_plan.upstream).length > 0 && (
        <>
          <h3>{t("si.upstream")}</h3>
          {Object.entries<any>(c.prompt_plan.upstream).map(([k, u]) => (
            <div key={k} className="small" style={{ padding: "2px 0" }}><b>{k}</b> {u.direct && <span className="muted">({t("si.direct")})</span>} — {u.mode === "full" ? t("si.full") : <span style={{ color: "var(--st-wait)" }}>{t("si.summarised")}</span>} ~{u.tokens} / {u.full_tokens} tokens</div>
          ))}
        </>
      )}
      {c.overridden?.length > 0 && (
        <>
          <h3>{t("si.overridden")}</h3>
          {c.overridden.map((o: any) => <div key={o.key} className="small muted">✗ {t("si.overriddenBy", { key: o.key, version: o.version, by: o.by, conflict: o.conflict_key })}</div>)}
        </>
      )}
      {c.missing_explicit?.length > 0 && <div className="errorbox small">{t("si.missing", { list: c.missing_explicit.join(", ") })}</div>}
    </div>
  );
}

export function Artifacts({ artifacts }: { artifacts: any[] }) {
  const { t } = useI18n();
  const [openId, setOpenId] = useState<number | null>(null);
  const { data } = useApi<any>(openId ? `/api/artifacts/${openId}` : null, [openId]);
  if (!artifacts.length) return <Empty>{t("si.noArtifacts")}</Empty>;
  return (
    <div>
      {artifacts.map((a) => (
        <button key={a.id} type="button" className="ghost rp-file" aria-expanded={openId === a.id}
          style={{ width: "100%", justifyContent: "flex-start", whiteSpace: "normal", textAlign: "left", fontWeight: 400, ...(openId === a.id ? { borderColor: "var(--brand)", background: "var(--brand-50)" } : {}) }}
          onClick={() => setOpenId(openId === a.id ? null : a.id)}>
          <Paperclip size={14} color="var(--brand)" />
          <b className="grow" style={{ overflowWrap: "anywhere" }}>{a.name}</b>
          <span className="muted small">{a.kind} · {t("si.chars", { n: a.size })}{a.data?.exit_code != null && ` · ${t("si.exit", { code: a.data.exit_code })}`}</span>
        </button>
      ))}
      {openId && data && data.id === openId && (
        <div className="rv-card">
          <div className="rv-card-head"><h4><Paperclip size={15} /> {data.name}</h4><Copy text={data.content} /></div>
          {data.name.endsWith(".md") ? <Markdown text={data.content} /> : <pre>{data.content}</pre>}
          {data.data && <JsonBlock value={data.data} title={t("si.data")} />}
        </div>
      )}
    </div>
  );
}

/** Independent verification verdict (fresh-session verifier; enforced before the PR). */
function VerdictCard({ v }: { v: any }) {
  const { t } = useI18n();
  const tone = v.verdict === "PASS" ? "COMPLETED" : v.verdict === "FAIL" ? "FAILED" : "WAITING_INPUT";
  const findings = (v.findings ?? []) as any[];
  return (
    <div className="card" style={{ borderLeft: `4px solid var(${v.verdict === "PASS" ? "--st-ok" : v.verdict === "FAIL" ? "--st-err" : "--st-wait"})` }}>
      <div className="card-head"><h4>{t("si.independent")}</h4><Badge s={tone}>{v.verdict}</Badge></div>
      <div className="small muted">{t("si.fresh", { heads: Object.entries(v.verified_heads ?? {}).map(([r, sha]) => `${r}@${String(sha).slice(0, 9)}`).join(", ") || "—" })}</div>
      {v.summary && <p className="small">{v.summary}</p>}
      {v.blocked_reason && <p className="small" style={{ color: "var(--st-wait)" }}>{t("si.blockedReason", { reason: v.blocked_reason })}</p>}
      {findings.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead><tr><th>{t("si.severity")}</th><th>{t("si.location")}</th><th>{t("si.finding")}</th><th>{t("si.evidence")}</th></tr></thead>
            <tbody>
              {findings.map((f, i) => (
                <tr key={i}>
                  <td><Badge s={f.severity === "high" ? "FAILED" : f.severity === "medium" ? "WAITING" : "PENDING"}>{f.severity}</Badge></td>
                  <td className="mono small">{f.file}{f.line ? `:${f.line}` : ""}</td>
                  <td className="small">{f.explanation}</td>
                  <td className="small muted">{f.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Failure classification and the recovery decision the engine took. */
function FailureCard({ f }: { f: any }) {
  const { t } = useI18n();
  return (
    <div className="card tight" style={{ borderLeft: "4px solid var(--st-err)" }}>
      <div className="row tight"><b className="small">{t("si.failure", { class: f.class })}</b><span className="pill">{f.action === "retry" ? t("si.retryIn", { n: f.delay_s }) : f.action === "human" ? t("si.pausedHuman") : t("si.stoppedAction")}</span></div>
      <div className="small muted">{f.reason}</div>
    </div>
  );
}
