import { useEffect, useRef, useState } from "react";
import { api, useApi } from "../api.ts";
import { act, Badge, Copy, Empty, ErrorBox, JsonBlock, Loading, Markdown, Tabs, time, navigate } from "../ui.tsx";
import { STEP_ICONS } from "../graph.tsx";
import { Transcript } from "./Transcript.tsx";
import { ReportPanel } from "./Report.tsx";

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

/** Render a step output: Markdown for summary-like strings, then the full structure. */
export function OutputView({ value }: { value: any }) {
  if (value == null) return <Empty>Chưa có output.</Empty>;
  const text = typeof value === "string" ? value : value.summary ?? value.report ?? null;
  return (
    <div>
      {typeof text === "string" && (
        <div className="card" style={{ padding: 10 }}>
          <div className="row tight"><b className="small">Summary</b><span className="grow" /><Copy text={text} /></div>
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
    <div className="card" style={{ borderColor: "var(--warn)" }}>
      <h4>❓ Claude đang chờ câu trả lời ({questions.length})</h4>
      {questions.map((q) => (
        <div key={q.id} className="q">
          <div className="row tight"><b className="grow">{q.question}</b><Copy text={q.question} /></div>
          {q.context && <div className="muted small" style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{q.context}</div>}
          {!!q.options?.length && (
            <div className="row tight" style={{ margin: "6px 0" }}>
              {q.options.map((o: string, i: number) => (
                <button key={o} className={answers[q.id] === o ? "sm" : "ghost sm"} onClick={() => setAnswers({ ...answers, [q.id]: o })}>
                  {i === 0 && "★ "}{o}
                </button>
              ))}
            </div>
          )}
          <textarea rows={2} placeholder={q.suggested_answer ? `Gợi ý: ${q.suggested_answer}` : "Câu trả lời…"} value={answers[q.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
        </div>
      ))}
      <div className="row">
        <button disabled={busy || !Object.values(answers).some((a) => a.trim())} onClick={submit}>{busy ? "Đang gửi…" : "Gửi trả lời & tiếp tục bước"}</button>
        <span className="muted small">Trả lời được lưu vào PostgreSQL; bước tiếp tục từ checkpoint khi mọi câu đã được trả lời.</span>
      </div>
    </div>
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
  return (
    <div className="card" style={{ borderColor: "var(--warn)" }}>
      <h4>✋ {gate ? "Cần duyệt trước khi chạy bước này" : req?.message ?? "Cần duyệt"}</h4>
      {step.type === "git_pull_request" && (
        <div className="row tight" style={{ marginBottom: 8 }}>
          <button className="ghost sm" onClick={() => navigate(`/runs/${run.id}/~changes`)}>🔍 Xem thay đổi & PR preview trước khi duyệt</button>
        </div>
      )}
      {req?.select_repositories && (
        <div>
          <div className="small muted">{req.ambiguous ? "⚠️ Gợi ý chưa chắc chắn — hãy chọn repo." : "Repo được gợi ý:"}</div>
          {(req.candidates ?? []).map((c: any) => (
            <label key={c.repo} style={{ display: "flex", gap: 8, margin: "6px 0", alignItems: "flex-start" }}>
              <input type="checkbox" checked={repos.includes(c.repo)} onChange={(e) => setRepos(e.target.checked ? [...repos, c.repo] : repos.filter((r) => r !== c.repo))} />
              <span>
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
        <details key={k} open>
          <summary>Output của bước {k}</summary>
          <OutputView value={v} />
        </details>
      ))}
      <textarea rows={2} placeholder="Nhận xét / feedback (gửi cho bước được làm lại khi reject)" value={comment} onChange={(e) => setComment(e.target.value)} />
      <div className="row">
        <button className="ok" onClick={() => send(true)}>Approve</button>
        <button className="danger" onClick={() => send(false)}>Reject{step.config?.on_reject?.reexecute ? ` → làm lại "${step.config.on_reject.reexecute}"` : ""}</button>
      </div>
    </div>
  );
}

export function StepInspector({ run, stepKey, tick, onChanged }: { run: any; stepKey: string; tick: number; onChanged: () => void }) {
  const { data, error, loading, reload } = useApi<any>(`/api/runs/${run.id}/steps/${stepKey}`);
  const [tab, setTab] = useState<Tab>(stepKey === "task_result_report" ? "report" : "overview");
  const [attemptId, setAttemptId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState("");
  useEffect(() => void reload(), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setAttemptId(null), [stepKey]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
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

  const tabs: Array<[Tab, React.ReactNode]> = [
    ...(step.type === "task_result_report" ? ([["report", "📋 Report"]] as Array<[Tab, React.ReactNode]>) : []),
    ["overview", "Overview"],
    ...(isAgent ? ([["execution", <>Claude {live && <span className="spinner" />}</>]] as Array<[Tab, React.ReactNode]>) : []),
    ...(step.type === "command" ? ([["execution", <>Live output {live && <span className="spinner" />}</>]] as Array<[Tab, React.ReactNode]>) : []),
    ["input", "Input"],
    ["output", "Output"],
    ["knowledge", `Knowledge${snapshot ? ` (${snapshot.content.knowledge.length})` : ""}`],
    ["qa", `Q&A${questions.length ? ` (${questions.length})` : ""}`],
    ["artifacts", `Artifacts${artifacts.length ? ` (${artifacts.length})` : ""}`],
    ["history", `History (${attempts.length})`],
  ];

  return (
    <div>
      <div className="row tight">
        <h2 className="grow" style={{ margin: 0 }}>{STEP_ICONS[step.type]} {step.name}</h2>
        <button className="ghost xs" onClick={() => navigate(`/runs/${run.id}`)}>✕</button>
      </div>
      <div className="muted small">
        <span className="mono">{step.key}</span> · {step.type} · gen {step.generation} · {attempts.length} attempt(s) · <Badge s={step.status} />
      </div>
      <div className="row">
        {canRun && <button className="sm" onClick={() => action("run", {}, "Step queued")}>▶ Run this step</button>}
        {canRetry && <button className="sm warn" onClick={() => action("retry", {}, "Retrying")}>↻ Retry</button>}
        {canRetry && step.type === "command" && step.config?.baseline_compare !== "go" && (
          <button className="sm ghost" title="Re-run; Go test failures that also fail on the base branch are reported as pre-existing instead of failing the step"
            onClick={() => action("retry", { input: { config_overrides: { baseline_compare: "go" } } }, "Retrying with baseline comparison")}>↻ Retry với so baseline (Go)</button>
        )}
        {canSkip && <button className="sm ghost" onClick={() => confirm("Skip this step?") && action("skip")}>⤼ Skip</button>}
        {["RUNNING", "RETRYING"].includes(step.status) && (
          <button className="sm danger" onClick={() => confirm("Dừng bước đang chạy? Process (Claude / command) bị kill, bước chuyển FAILED và có thể Retry hoặc Skip.") && action("stop", {}, "Stopped")}>■ Stop</button>
        )}
        {attempts.length > 1 && (
          <select style={{ width: "auto" }} value={attempt?.id} onChange={(e) => setAttemptId(Number(e.target.value))}>
            {attempts.map((a: any) => (
              <option key={a.id} value={a.id}>attempt #{a.number} · gen {a.generation} · {a.status}{a.invalidated_at ? " (invalidated)" : ""}</option>
            ))}
          </select>
        )}
      </div>
      {step.status === "WAITING_INPUT" && <QuestionsForm questions={open} onDone={refresh} />}
      {step.status === "WAITING_APPROVAL" && step.type !== "task_result_report" && <ApprovalPanel run={run} step={step} onDone={refresh} />}
      {step.type === "task_result_report" && step.status === "WAITING_APPROVAL" && tab !== "report" && (
        <div className="card" style={{ borderColor: "var(--warn)" }}>✋ Báo cáo đang chờ bạn xem lại — <a style={{ cursor: "pointer" }} onClick={() => setTab("report")}>mở tab Report</a></div>
      )}
      {step.error && (
        <div className="errorbox">
          <div className="row tight"><b className="grow">Error</b><Copy text={step.error} /></div>
          <div className="mono" style={{ whiteSpace: "pre-wrap" }}>{step.error}</div>
        </div>
      )}
      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === "report" && <ReportPanel run={run} step={step} artifacts={artifacts} attempts={attempts} onChanged={refresh} />}
      {tab === "overview" && (
        <div>
          {step.type === "command" && <TestFailurePanel attempts={attempts} questions={questions} current={attempt} step={step} />}
          {step.type === "command" && <BaselineSummary results={(attempt?.output ?? attempt?.error?.details)?.results} />}
          {attempt?.metrics && <AttemptMetrics m={attempt.metrics} />}
          <div className="kv">
            <span>Status</span><span><Badge s={step.status} /></span>
            <span>Depends on</span><span className="mono">{step.depends_on.join(", ") || "—"}</span>
            <span>Max attempts</span><span>{step.max_attempts} (backoff {step.retry_backoff_s}s)</span>
            <span>Approval gate</span><span>{step.requires_approval ? "yes" : "no"}</span>
            {step.run_if && <><span>Run if</span><span className="mono">{JSON.stringify(step.run_if)}</span></>}
            <span>Started</span><span>{time(step.started_at)}</span>
            <span>Finished</span><span>{time(step.finished_at)}</span>
            {sessions.length > 0 && <><span>Claude session</span><span className="mono">{sessions[sessions.length - 1].session_id} {sessions[sessions.length - 1].model && `(${sessions[sessions.length - 1].model})`}</span></>}
          </div>
          {step.config?.instructions && (
            <div className="card" style={{ marginTop: 10, padding: 10 }}>
              <div className="row tight"><b className="small grow">Instructions</b><Copy text={step.config.instructions} /></div>
              <Markdown text={step.config.instructions} />
            </div>
          )}
          <JsonBlock value={step.config} title="Configuration" />
          {attempt?.input?.pending?.reexecute && <ReexecuteInfo rx={attempt.input.pending.reexecute} prev={attempt.input.previous_attempt?.number} />}
          {canReexec && <ReexecuteDialog run={run} step={step} onSubmit={(body) => action("reexecute", body, "Đã mở attempt mới")} />}
          {checkpoints.length > 0 && (
            <details>
              <summary>Checkpoints ({checkpoints.length})</summary>
              {checkpoints.map((c: any) => (
                <div key={c.id} className="small"><span className="muted">{time(c.created_at)}</span> <b>{c.reason}</b> <span className="mono">{JSON.stringify(c.data).slice(0, 300)}</span></div>
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
            <div key={q.id} className="q">
              <b>{q.question}</b> <Badge s={q.status === "answered" ? "COMPLETED" : q.status === "open" ? "WAITING_INPUT" : "CANCELED"}>{q.status}</Badge>
              {q.context && <div className="muted small" style={{ whiteSpace: "pre-wrap" }}>{q.context}</div>}
              {q.answer && <div>→ {q.answer} <span className="muted small">{q.answered_by} {time(q.answered_at)}</span></div>}
              <div className="muted small">attempt {attempts.find((a: any) => a.id === q.attempt_id)?.number ?? "?"} · {time(q.created_at)}</div>
            </div>
          ))
        ) : (
          <Empty>Bước này chưa hỏi gì.</Empty>
        ))}
      {tab === "artifacts" && <Artifacts artifacts={artifacts} />}
      {tab === "history" && (
        <div>
          <table>
            <thead><tr><th>#</th><th>Gen</th><th>Status</th><th>Started</th><th>Finished</th><th>Worker</th><th>Error</th></tr></thead>
            <tbody>
              {attempts.map((a: any) => (
                <tr key={a.id} className="click" style={{ opacity: a.invalidated_at ? 0.6 : 1 }} onClick={() => (setAttemptId(a.id), setTab(isAgent ? "execution" : "output"))}>
                  <td>{a.number}</td><td>{a.generation}</td><td><Badge s={a.status} />{a.invalidated_at && <div className="muted small">invalidated</div>}
                    {a.input?.pending?.reexecute && (
                      <div className="small" style={{ marginTop: 2 }}>
                        ↻ {a.input.pending.reexecute.instructions ? `“${String(a.input.pending.reexecute.instructions).slice(0, 80)}”` : "re-execute"}
                        {a.input.pending.reexecute.skills?.length > 0 && <span className="muted"> · {a.input.pending.reexecute.skills.map((s: any) => `${s.key}@v${s.version}`).join(", ")}</span>}
                      </div>
                    )}
                  </td>
                  <td>{time(a.started_at)}</td><td>{time(a.finished_at)}</td><td className="mono small">{(a.worker ?? "").split(":").slice(-1)[0]}</td>
                  <td className="err small">{a.error?.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Jobs</h3>
          {jobs.map((j: any) => (
            <div key={j.id} className="small mono">#{j.id} {j.status} gen{j.generation} claims={j.claims}{j.force ? " force" : ""} {j.lease_owner ?? ""} {j.last_error ?? ""}</div>
          ))}
        </div>
      )}
    </div>
  );
}

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
    <div className="card" style={{ padding: 10, borderColor: step.status === "WAITING_INPUT" ? "var(--warn)" : undefined }}>
      <div className="row tight"><h4 className="grow" style={{ margin: 0 }}>🧪 Chẩn đoán test</h4>{step.output?.test_status === "FAILED" && <Badge s="FAILED">test FAILED</Badge>}</div>
      {d && (
        <>
          <div className="small" style={{ margin: "4px 0" }}><b>{d.summary}</b></div>
          <div className="muted small mono" style={{ wordBreak: "break-all" }}>{d.command.split("\n").find((l: string) => l.includes("go test")) ?? d.command.split("\n")[0]}</div>
          <div className="muted small">
            {d.results.map((r: any) => `${r.repo}: exit ${r.timed_out ? "timeout" : r.exit_code}`).join(" · ")} · baseline {d.baseline_available ? <span className="mono">{String(d.base_sha).slice(0, 9)}</span> : "không có"}
          </div>
          {d.explanation && (
            <div className="card" style={{ padding: 8, margin: "6px 0", background: "var(--panel2)" }}>
              <div className="small"><b>{d.explanation.by === "claude" ? "AI" : "Tóm tắt"}:</b> {d.explanation.text}</div>
              <div className="small" style={{ marginTop: 2 }}><b>Đề xuất:</b> {d.explanation.suggestion}</div>
            </div>
          )}
          {groups.map((g) => (
            <div key={g} style={{ marginTop: 6 }}>
              <Badge s={CAT[g][0]}>{CAT[g][1]} · {d.failures.filter((f: any) => f.category === g).length}</Badge>
              {d.failures.filter((f: any) => f.category === g).map((f: any, i: number) => (
                <details key={i} style={{ marginLeft: 8 }}>
                  <summary style={{ color: "var(--text)" }}>
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
        <div className="small" style={{ marginTop: 8, color: "var(--warn)" }}>
          ⚠ Đã chấp nhận ngoại lệ baseline ({exception.failures.length} lỗi) — kết quả test vẫn FAILED, được ghi vào PR và báo cáo.
        </div>
      )}
      {(questions.length > 0 || decisions.length > 0) && (
        <div style={{ marginTop: 8 }}>
          <b className="small">Trao đổi & quyết định</b>
          {attempts.map((a) => {
            const qs = questions.filter((q: any) => q.attempt_id === a.id);
            const dec = payload(a)?.decision;
            if (!qs.length && !dec) return null;
            return (
              <div key={a.id} className="small" style={{ margin: "4px 0", paddingLeft: 8, borderLeft: "2px solid var(--line)" }}>
                <span className="muted">attempt #{a.number} · {a.status}</span>
                {dec && <div>→ quyết định: <b>{DECISION[dec.kind] ?? dec.kind}</b>{dec.target ? ` (${dec.target})` : ""}{dec.instructions ? ` — “${dec.instructions}”` : ""}</div>}
                {qs.map((q: any) => (
                  <div key={q.id}>❓ {q.question}{q.answer ? <> <br />💬 <b>{q.answer}</b></> : q.status === "open" ? <span className="muted"> (đang chờ)</span> : <span className="muted"> ({q.status})</span>}</div>
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
      <span className="mono">{x.package}</span>
      {x.tests.map((t: string) => <div key={t} className="mono" style={{ marginLeft: 12 }}>✗ {t}</div>)}
      {x.build_errors.map((e: string) => <div key={e} className="mono" style={{ marginLeft: 12 }}>⚙ {e}</div>)}
    </div>
  );
  return (
    <div className="card" style={{ padding: 10 }}>
      <h4>So với baseline</h4>
      {withBase.map((r) => (
        <div key={r.repo}>
          <b>{r.repo}</b> {r.baseline.note ? <span className="muted small">— {r.baseline.note}</span> : <span className="muted small mono">base {String(r.baseline.base_sha).slice(0, 9)}</span>}{" "}
          {r.baseline.regressions && (r.baseline.regressions.length ? <Badge s="FAILED">{r.baseline.regressions.length} regression</Badge> : <Badge s="COMPLETED">không có regression</Badge>)}
          {r.baseline.regressions?.length > 0 && <div className="err small" style={{ marginTop: 4 }}>Lỗi mới do thay đổi của run:</div>}
          {r.baseline.regressions?.map((x: any) => <Item key={x.package} x={x} />)}
          {r.baseline.pre_existing?.length > 0 && <div className="muted small" style={{ marginTop: 4 }}>Lỗi có sẵn trên base (không chặn):</div>}
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
      <div className="row tight">
        <span className="small muted grow">
          {live ? <><span className="spinner" /> đang chạy {Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)}s · output cuối {quiet}s trước</> : "đã xong"}
          {live && quiet > 60 && <span style={{ color: "var(--warn)" }}> — không có output hơn 1 phút: có thể test đang chờ mạng/DB; dùng ■ Stop nếu cần</span>}
        </span>
        <label className="small muted"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
        <Copy text={text} />
      </div>
      <pre ref={box} style={{ maxHeight: "62vh" }}>{text || "(chưa có output)"}</pre>
    </div>
  );
}

function AttemptMetrics({ m }: { m: any }) {
  const tools = Object.entries<number>(m.tool_calls ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="card" style={{ padding: 10 }}>
      <h4>Metrics attempt</h4>
      <div className="kv">
        <span>Model</span><span className="mono">{m.model}</span>
        <span>Cost / turns</span><span>${Number(m.cost_usd ?? 0).toFixed(4)} · {m.turns} turns · {Math.round((m.duration_ms ?? 0) / 1000)}s · {m.sessions} session</span>
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
    <div className="card" style={{ padding: 10, borderColor: "var(--accent)" }}>
      <b className="small">↻ Lần chạy lại này</b> <span className="muted small">{rx.requested_by ? `bởi ${rx.requested_by} · ` : ""}{time(rx.at)}{prev ? ` · sửa từ attempt #${prev}` : ""}</span>
      {rx.instructions ? <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{rx.instructions}</div> : <div className="muted small">(không có chỉ dẫn)</div>}
      {rx.skills?.length > 0 && <div className="small" style={{ marginTop: 4 }}>Skills: {rx.skills.map((s: any) => <span key={s.key} className="pill">{s.title ?? s.key} <span className="muted mono">v{s.version}</span></span>)}</div>}
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
  if (!open) return <div className="row"><button className="sm" onClick={() => setOpen(true)}>↻ Re-execute…</button><span className="muted small">chạy lại bước này (có thể kèm chỉ dẫn / skill)</span></div>;
  return (
    <div className="card" style={{ padding: 10, borderColor: "var(--accent)" }}>
      <div className="row tight"><b className="grow">↻ Chạy lại “{step.name}” với chỉ dẫn</b><button className="xs ghost" onClick={() => setOpen(false)}>✕</button></div>
      <textarea rows={4} autoFocus placeholder="Chỉ dẫn cho lần chạy lại (tuỳ chọn), vd: Xem lại call sang service B. Dữ liệu đã có trong payload" value={text} onChange={(e) => setText(e.target.value)} style={{ marginTop: 6 }} />
      <div className="small" style={{ marginTop: 6 }}>
        <b>Skills cho lần này</b> <span className="muted">(tuỳ chọn; ghim theo version hiện tại)</span>
        <div>
          {skills.map((k) => (
            <span key={k} className="pill">{catalog?.find((c) => c.key === k)?.title ?? k}<button onClick={() => setSkills(skills.filter((x) => x !== k))}>✕</button></span>
          ))}
        </div>
        <select value="" onChange={(e) => e.target.value && setSkills([...skills, e.target.value])}>
          <option value="">+ thêm skill…</option>
          {(catalog ?? []).filter((c) => !skills.includes(c.key)).map((c) => <option key={c.key} value={c.key}>{c.title} ({c.key} v{c.current_version}){c.enabled ? "" : " [off]"}</option>)}
        </select>
      </div>
      <div className="small" style={{ marginTop: 6 }}>
        <b>Sẽ chạy lại:</b> <span className="mono">{step.key}</span>
        {affected.length ? (
          <> → {affected.map((k) => {
            const s: any = byKey.get(k);
            const gate = s?.requires_approval || s?.type === "human_approval" || s?.type === "task_result_report" || (s?.type === "git_pull_request" && s?.config?.mode === "approval");
            return <span key={k} className="pill">{s?.name ?? k}{gate ? " ✋ duyệt lại" : ""}</span>;
          })}</>
        ) : <span className="muted"> (không có bước phụ thuộc)</span>}
        <div className="muted">Các bước phía trước giữ nguyên kết quả; attempt cũ vẫn xem được trong History.</div>
      </div>
      <div className="row">
        <button disabled={busy} onClick={async () => {
          setBusy(true);
          const r = await onSubmit({ ...(text.trim() ? { feedback: text.trim() } : {}), ...(skills.length ? { skills } : {}) });
          setBusy(false);
          if (r !== undefined) (setOpen(false), setText(""), setSkills([]));
        }}>{busy ? "Đang tạo…" : "Xác nhận chạy lại"}</button>
        <button className="ghost" onClick={() => setOpen(false)}>Huỷ</button>
      </div>
    </div>
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
      <div className="muted small">
        Snapshot #{snapshot.id} · <span className="mono">{snapshot.hash.slice(0, 16)}</span> · project {c.project || "—"} · repos {c.repositories.join(", ") || "—"} · {time(snapshot.created_at)}
      </div>
      {!c.knowledge.length && <Empty>Không có knowledge nào áp dụng cho bước này.</Empty>}
      {Object.entries(groups).map(([cat, items]) => (
        <div key={cat}>
          <h3>{CATEGORY_LABEL[cat] ?? cat}</h3>
          {items.map((k) => (
            <details key={k.key} className="card" style={{ padding: "6px 10px", marginBottom: 6 }}>
              <summary style={{ color: "var(--text)" }}>
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
            <div key={k} className="small"><b>{k}</b> {u.direct && <span className="muted">(trực tiếp)</span>} — {u.mode === "full" ? "đầy đủ" : <span style={{ color: "var(--warn)" }}>tóm tắt</span>} ~{u.tokens} / {u.full_tokens} tokens</div>
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
        <div key={a.id} className="row tight" style={{ margin: "4px 0" }}>
          <button className={openId === a.id ? "sm" : "ghost sm"} onClick={() => setOpenId(openId === a.id ? null : a.id)}>📎 {a.name}</button>
          <span className="muted small">{a.kind} · {a.size} chars{a.data?.exit_code != null && ` · exit ${a.data.exit_code}`}</span>
        </div>
      ))}
      {openId && data && data.id === openId && (
        <div className="card">
          <div className="row tight"><b className="grow">{data.name}</b><Copy text={data.content} /></div>
          {data.name.endsWith(".md") ? <Markdown text={data.content} /> : <pre>{data.content}</pre>}
          {data.data && <JsonBlock value={data.data} title="Data" />}
        </div>
      )}
    </div>
  );
}
