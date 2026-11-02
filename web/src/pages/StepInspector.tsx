import { useEffect, useRef, useState } from "react";
import { api, useApi } from "../api.ts";
import { act, Badge, Copy, Empty, ErrorBox, JsonBlock, Loading, Markdown, Tabs, time, navigate } from "../ui.tsx";
import { STEP_ICONS } from "../graph.tsx";
import { Transcript } from "./Transcript.tsx";

const AGENT_TYPES = ["agent", "coding_agent"];
type Tab = "overview" | "execution" | "input" | "output" | "knowledge" | "qa" | "artifacts" | "history";

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
  const [tab, setTab] = useState<Tab>("overview");
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
    if (await act(() => api(`/api/runs/${run.id}/steps/${step.key}/${path}`, body), ok)) refresh();
  };
  const canRun = run.status === "PAUSED" && ["READY", "RETRYING"].includes(step.status);
  const canRetry = runActive && ["FAILED", "CANCELED"].includes(step.status);
  const canReexec = runActive && ["COMPLETED", "SKIPPED", "WAITING_INPUT", "WAITING_APPROVAL", "FAILED"].includes(step.status);
  const canSkip = runActive && ["PENDING", "READY", "FAILED", "WAITING_INPUT", "WAITING_APPROVAL"].includes(step.status);

  const tabs: Array<[Tab, React.ReactNode]> = [
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
      {step.status === "WAITING_APPROVAL" && <ApprovalPanel run={run} step={step} onDone={refresh} />}
      {step.error && (
        <div className="errorbox">
          <div className="row tight"><b className="grow">Error</b><Copy text={step.error} /></div>
          <div className="mono" style={{ whiteSpace: "pre-wrap" }}>{step.error}</div>
        </div>
      )}
      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === "overview" && (
        <div>
          {step.type === "command" && <BaselineSummary results={(attempt?.output ?? attempt?.error?.details)?.results} />}
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
          {canReexec && (
            <div className="card" style={{ padding: 10 }}>
              <b className="small">Re-execute from this step</b>
              <div className="muted small">Các bước phía sau sẽ bị invalidate và chạy lại; các bước phía trước được giữ nguyên.</div>
              <textarea rows={2} placeholder="Feedback cho bước (tuỳ chọn)" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
              <div className="row"><button className="sm" onClick={() => action("reexecute", feedback ? { feedback } : {}, "Re-executing").then(() => setFeedback(""))}>↻ Re-execute</button></div>
            </div>
          )}
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
                  <td>{a.number}</td><td>{a.generation}</td><td><Badge s={a.status} />{a.invalidated_at && <div className="muted small">invalidated</div>}</td>
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

function KnowledgeApplied({ snapshot }: { snapshot: any }) {
  if (!snapshot) return <Empty>Chưa có context snapshot (bước chưa chạy).</Empty>;
  const c = snapshot.content;
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
                <b>{k.title}</b> <span className="mono muted">{k.key} v{k.version}</span> <span className="muted small">· {k.reason}</span>
              </summary>
              <Markdown text={k.content} />
              <div className="row tight"><a href={`#/knowledge/${k.key}`} className="small">Mở trong Knowledge →</a></div>
            </details>
          ))}
        </div>
      ))}
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
