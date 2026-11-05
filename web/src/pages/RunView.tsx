import { useEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow, type Node } from "@xyflow/react";
import {
  Activity, AlertTriangle, CalendarClock, ChevronRight, ClipboardList, FileDiff, FolderGit2, GitBranch, GitPullRequest, Hand, Hourglass,
  Info, ListTree, MessageCircleQuestion, MessageSquareText, Pause, Play, Send, Square, StepForward, Ticket, Timer, Workflow, Zap, CheckCircle2, XCircle, GitMerge, Ban, PenLine,
} from "lucide-react";
import { api, STATUS_COLORS, useApi, useLive } from "../api.ts";
import { useI18n } from "../i18n/index.tsx";
import { act, Badge, Copy, ErrorBox, Loading, navigate, time } from "../ui.tsx";
import { autoLayout, nodeTypes, toEdges, type StepNodeData } from "../graph.tsx";
import { StepInspector } from "./StepInspector.tsx";
import { ProfileBadge } from "./ProfilePreview.tsx";
import { Changes } from "./Changes.tsx";
import "./RunView.css";

/** Display order of statuses in the run summary strip. */
const STATUS_ORDER = ["COMPLETED", "RUNNING", "RETRYING", "READY", "WAITING_INPUT", "WAITING_APPROVAL", "WAITING", "PAUSED", "PENDING", "FAILED", "STALE", "SKIPPED", "CANCELED"];
const byOrder = (a: string, b: string) => (STATUS_ORDER.indexOf(a) + 1 || 99) - (STATUS_ORDER.indexOf(b) + 1 || 99);

/** Live execution graph of one run + inspector. Route: #/runs/:id[/:stepKey | /~changes]. */
export function RunView({ id, stepKey }: { id: number; stepKey?: string }) {
  const { t, status } = useI18n();
  const { data: run, error, loading, reload } = useApi<any>(`/api/runs/${id}`);
  const [tick, setTick] = useState(0);
  const live = useLive(id, () => {
    reload();
    setTick((t) => t + 1);
  });
  const [feedback, setFeedback] = useState("");

  const { nodes, edges } = useMemo(() => {
    if (!run) return { nodes: [], edges: [] };
    const specSteps = run.graph.steps as any[];
    const pos = autoLayout(specSteps);
    const st = new Map<string, any>(run.steps.map((s: any) => [s.key, s]));
    const openQ: Record<string, number> = {};
    for (const q of run.questions) if (q.status === "open") openQ[q.step_key] = (openQ[q.step_key] ?? 0) + 1;
    const attempts: Record<string, number> = {};
    for (const a of run.attempts) attempts[a.step_key] = (attempts[a.step_key] ?? 0) + 1;
    const nodes: Node<StepNodeData>[] = specSteps.map((s) => {
      const row = st.get(s.key);
      return {
        id: s.key,
        type: "step",
        position: s.ui ?? pos[s.key],
        data: {
          step: { ...s, name: row?.name ?? s.name, requires_approval: row?.requires_approval ?? s.requires_approval },
          status: row?.status,
          attempts: attempts[s.key],
          openQuestions: openQ[s.key],
          selected: s.key === stepKey,
        },
      };
    });
    return { nodes, edges: toEdges(specSteps, (k) => st.get(k)?.status) };
  }, [run, stepKey]);

  // Deep link (#/runs/:id/:stepKey, e.g. from Telegram) to a step that is not in this run any more: open the run itself.
  useEffect(() => {
    if (run && stepKey && stepKey !== "~changes" && !run.steps.some((s: any) => s.key === stepKey)) navigate(`/runs/${id}`);
  }, [run, stepKey, id]);
  if (loading && !run) return <Loading />;
  if (error) return <div className="page"><ErrorBox error={error} onRetry={reload} /></div>;

  const runAction = async (a: string, body: any = {}) => {
    if (a === "cancel" && !confirm("Cancel this run? Running steps are stopped.")) return;
    if (await act(() => api(`/api/runs/${id}/${a}`, body))) reload();
  };
  const blocked = run.steps.filter((s: any) => s.status === "WAITING_INPUT" || s.status === "WAITING_APPROVAL");
  const counts: Record<string, number> = {};
  for (const s of run.steps) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const countEntries = Object.entries(counts).sort(([a], [b]) => byOrder(a, b));
  const total = run.steps.length;
  const done = (counts.COMPLETED ?? 0) + (counts.SKIPPED ?? 0);
  const hasWorkspaces = run.workspaces.length > 0;
  const canFeedback = run.status !== "CANCELED" && (run.graph.feedback_step || run.steps.some((s: any) => s.type === "coding_agent"));
  const openFeedback = () => {
    if (stepKey) navigate(`/runs/${id}`);
    setTimeout(() => {
      const el = document.getElementById("rv-feedback");
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.focus();
    }, 80);
  };

  return (
    <>
      <header className="rv-head">
        <div className="rv-headrow">
          <nav className="rv-crumbs" aria-label="Breadcrumb">
            <a href="#/runs"><Activity size={13} /> Workflow Runs</a>
            <ChevronRight size={13} aria-hidden />
            <span className={stepKey ? undefined : "rv-cur"}>{stepKey ? <a href={`#/runs/${id}`}>Run #{run.id}</a> : `Run #${run.id}`}</span>
            {stepKey && (
              <>
                <ChevronRight size={13} aria-hidden />
                <span className="rv-cur">{stepKey === "~changes" ? "Changes" : run.steps.find((s: any) => s.key === stepKey)?.name ?? stepKey}</span>
              </>
            )}
          </nav>
          <span className={`rv-live is-${live}`} title="update channel"><i />{live === "sse" ? "Live" : live === "polling" ? "Polling" : "Đang kết nối"}</span>
        </div>

        <div className="rv-top">
          <div className="rv-titlebox">
            <span className="rv-icon"><Workflow size={21} strokeWidth={2} /></span>
            <div style={{ minWidth: 0 }}>
              <h1 className="rv-title">
                <span className="rv-id">#{run.id}</span>
                <span className="rv-name">{run.title || run.definition_key}</span>
                <Badge s={run.status} label />
                <ProfileBadge profile={run.profile} title={(run.profile_decision?.reasons ?? []).join("\n")} />
                <span className="pill" title={run.output_locale ? t("run.outputCurrent") : t("run.outputLegacyHint")}>
                  {t("run.outputCurrent")}: {run.output_locale === "en" ? t("lang.en") : run.output_locale === "vi" ? t("lang.vi") : t("run.outputLegacy")}
                </span>
              </h1>
              <div className="rv-meta">
                <span title="Workflow"><Workflow size={13} /><a href={`#/workflows/${run.definition_key}`}>{run.definition_key}</a> <span className="muted">v{run.definition_version}</span></span>
                <span title="Branch"><GitBranch size={13} /><span className="mono">{run.branch}</span></span>
                {Object.entries((run.inputs?.branches ?? {}) as Record<string, string>).map(([repo, b]) => (
                  <span key={repo} className="pill chip-brand" title={`Làm tiếp branch có sẵn${run.inputs?.branches_source ? ` (từ ${run.inputs.branches_source})` : ""} — không tạo branch mới`}>
                    <GitBranch size={12} /> {repo === "*" ? "mọi repo" : repo} → <span className="mono">{b}</span> (làm tiếp)
                  </span>
                ))}
                {run.work_item && <span title="Work item"><Ticket size={13} /><a href={`#/work-items/${run.work_item.id}`}>{run.work_item.code}</a></span>}
                {run.created_at && <span title="Created"><CalendarClock size={13} />{time(run.created_at)}</span>}
              </div>
            </div>
          </div>
          <div className="rv-actions">
            {run.status === "PENDING" && (
              <>
                <button className="sm" onClick={() => runAction("start")}><Play size={14} /> Start</button>
                <button className="sm ghost" title="Start paused and run steps one by one" onClick={() => runAction("start", { step_mode: true })}><StepForward size={14} /> Step mode</button>
              </>
            )}
            {["RUNNING", "WAITING", "FAILED"].includes(run.status) && <button className="sm ghost" onClick={() => runAction("pause")}><Pause size={14} /> Pause</button>}
            {run.status === "PAUSED" && <button className="sm" onClick={() => runAction("resume")}><Play size={14} /> Resume</button>}
            {canFeedback && <button className="sm ghost" onClick={openFeedback} title="Gửi feedback cho agent"><MessageSquareText size={14} /> Feedback</button>}
            <button className={stepKey === "~changes" ? "sm" : "sm ghost"} disabled={!hasWorkspaces} title={hasWorkspaces ? "" : "No code changes yet"} onClick={() => navigate(`/runs/${id}/~changes`)}><FileDiff size={14} /> Changes</button>
            {!["CANCELED", "COMPLETED"].includes(run.status) && <button className="sm danger" onClick={() => runAction("cancel")}><Square size={13} /> Cancel</button>}
          </div>
        </div>

        {total > 0 && (
          <div className="rv-summary">
            <span className="rv-total">{done}/{total} bước xong</span>
            <div className="progress rv-progress" role="img" aria-label={`${done}/${total} bước xong`}>
              {countEntries.map(([s, n]) => <span key={s} style={{ width: `${(n / total) * 100}%`, background: STATUS_COLORS[s] ?? "var(--st-idle)" }} title={`${status(s)}: ${n}`} />)}
            </div>
            <div className="rv-counts">
              {countEntries.map(([s, n]) => <Badge key={s} s={s}>{status(s)} · {n}</Badge>)}
            </div>
          </div>
        )}
      </header>

      {blocked.length > 0 && (
        <div className="rv-banner wait" role="status">
          <Hand size={16} />
          <b>Đang chờ bạn:</b>
          {blocked.map((s: any) => (
            <button key={s.key} className="ghost xs" onClick={() => navigate(`/runs/${id}/${s.key}`)}>
              {s.status === "WAITING_INPUT" ? <MessageCircleQuestion size={12} /> : <Hand size={12} />} {s.name}
            </button>
          ))}
        </div>
      )}
      <QueueBanner run={run} tick={tick} />
      {run.status === "PAUSED" && (
        <div className="rv-banner idle">
          <Info size={15} />
          <span>Run đang tạm dừng (step mode): chọn một bước <b>READY</b> rồi bấm “Run this step”, hoặc Resume để chạy tự động.</span>
        </div>
      )}
      <div className="split">
        <div className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => navigate(`/runs/${id}/${n.id}`)}
            onPaneClick={() => stepKey && navigate(`/runs/${id}`)}
            nodesConnectable={false}
            fitView
            // Long workflows: fit around the selected step (or the start) at a readable zoom instead of shrinking everything.
            fitViewOptions={{ padding: 0.25, maxZoom: 1, minZoom: 0.7, nodes: focusNodes(nodes.map((n) => n.id), stepKey) }}
            minZoom={0.2}
          >
            <Background gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside className={stepKey === "~changes" ? "inspector wide rv-inspector" : "inspector rv-inspector"}>
          {stepKey === "~changes" ? (
            <div className="rv-pane"><Changes run={run} tick={tick} onChanged={reload} /></div>
          ) : stepKey ? (
            <StepInspector key={stepKey} run={run} stepKey={stepKey} tick={tick} onChanged={reload} />
          ) : (
            <div className="rv-pane">
              <div className="rv-card-head" style={{ marginBottom: 4 }}>
                <h4 style={{ fontSize: "var(--fs-lg)" }}><ListTree size={18} /> Tổng quan run</h4>
              </div>
              <div className="rv-minis">
                <div className="rv-mini"><span>Tổng bước</span><b>{total}</b></div>
                <div className="rv-mini tone-ok"><span>Xong</span><b>{done}</b></div>
                <div className="rv-mini tone-run"><span>Đang chạy</span><b>{(counts.RUNNING ?? 0) + (counts.RETRYING ?? 0)}</b></div>
                <div className="rv-mini tone-wait"><span>Chờ bạn</span><b>{blocked.length}</b></div>
                <div className="rv-mini tone-err"><span>Lỗi</span><b>{counts.FAILED ?? 0}</b></div>
              </div>
              <div className="rv-card">
                <div className="rv-kv">
                  <span>Selected repos</span><span>{run.selected_repositories.join(", ") || <span className="muted">(chưa chọn)</span>}</span>
                  <span>Allowed repos</span><span className="small">{run.allowed_repositories.join(", ")}</span>
                  <span>Created</span><span>{time(run.created_at)}</span>
                  <span>Finished</span><span>{time(run.finished_at) || "—"}</span>
                  {run.error && <><span>Error</span><span className="err">{run.error}</span></>}
                </div>
              </div>
              <ReportCard run={run} />
              <ProfileCard run={run} />
              <RunTotals runId={id} tick={tick} />
              {run.status === "PENDING" && <RepoPicker run={run} onDone={reload} />}
              <div className="rv-note"><Info size={14} />Bấm vào một node để xem cấu hình, input/output, knowledge, hội thoại Claude, câu hỏi và lịch sử attempt.</div>
              {run.pull_requests.length > 0 && (
                <div className="rv-sec">
                  <div className="rv-sec-title"><GitPullRequest size={14} /> Pull requests</div>
                  {run.pull_requests.map((p: any) => (
                    <div key={p.id} className="rv-card soft" style={{ padding: "9px 12px", margin: "6px 0" }}>
                      <div className="small"><b>{p.repo}</b> · <a href={p.url} target="_blank" rel="noopener">{p.title}</a></div>
                    </div>
                  ))}
                </div>
              )}
              {canFeedback && (
                <div className="rv-sec">
                  <div className="rv-sec-title"><MessageSquareText size={14} /> Feedback cho agent</div>
                  <div className="rv-card">
                    <div className="muted small">Chạy lại bước nhận feedback (<span className="mono">{run.graph.feedback_step ?? "coding step"}</span>); test và PR chạy lại sau đó, PR cũ được cập nhật.</div>
                    <textarea id="rv-feedback" rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Mô tả điều cần agent sửa…" style={{ marginTop: 8 }} />
                    <div className="row">
                      <button className="sm" disabled={!feedback.trim()} onClick={async () => (await act(() => api(`/api/runs/${id}/feedback`, { message: feedback }), "Feedback sent")) && (setFeedback(""), reload())}><Send size={13} /> Gửi feedback</button>
                    </div>
                  </div>
                </div>
              )}
              <RunTimeline runId={id} tick={tick} />
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

/** READY steps that no worker has picked up yet: say who is holding the workers and for how long. */
function QueueBanner({ run, tick }: { run: any; tick: number }) {
  const waiting = run.steps.filter((s: any) => s.status === "READY" || s.status === "RETRYING");
  const { data, reload } = useApi<any>(waiting.length && !["PAUSED", "CANCELED"].includes(run.status) ? "/api/scheduler" : null);
  useEffect(() => void reload(), [tick, waiting.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!waiting.length || !data) return null;
  const others = data.running.filter((j: any) => j.run_id !== run.id);
  if (!others.length) return null;
  const fmt = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}`);
  return (
    <div className="rv-banner brand">
      <Hourglass size={15} />
      <span>
        <b>{waiting.map((s: any) => s.name).join(", ")}</b> đang chờ worker ({data.workers} worker chung + {data.light_workers} worker cho bước nhẹ). Đang bận:{" "}
        {others.map((j: any) => (
          <a key={j.job_id} href={`#/runs/${j.run_id}/${j.step_key}`} style={{ marginRight: 10 }}>
            run #{j.run_id} · {j.step_name} ({fmt(j.running_seconds ?? 0)})
          </a>
        ))}
        <span className="muted small">— tăng scheduler.workers trong config.json để chạy song song.</span>
      </span>
    </div>
  );
}

/** Shortcut to the Task Result Report (when this run has one). */
function ReportCard({ run }: { run: any }) {
  const s = run.steps.find((x: any) => x.type === "task_result_report");
  if (!s) return null;
  const report = s.output?.report ?? s.approval?.request?.report;
  const md = s.output?.markdown ?? s.approval?.request?.markdown;
  const waiting = s.status === "WAITING_APPROVAL";
  return (
    <div className={waiting ? "rv-attn" : "rv-card"} style={waiting ? { padding: "12px 14px" } : undefined}>
      <div className="rv-card-head">
        <h4><ClipboardList size={16} /> Task Result Report</h4> <Badge s={s.status} label />
      </div>
      {report ? (
        <div className="rv-chipline small">
          <Badge s="COMPLETED"><CheckCircle2 size={11} /> {report.counts.VERIFIED} verified</Badge>
          <Badge s="WAITING"><AlertTriangle size={11} /> {report.counts.PARTIAL} partial</Badge>
          <Badge s="FAILED"><XCircle size={11} /> {report.counts.MISSING} missing</Badge>
          <span className="muted">{s.status === "COMPLETED" ? "đã duyệt" : waiting ? "chờ bạn xem lại" : ""}</span>
        </div>
      ) : (
        <div className="muted small">Được tạo sau khi các bước của task hoàn tất.</div>
      )}
      <div className="row">
        <button className={waiting ? "sm" : "sm ghost"} onClick={() => navigate(`/runs/${run.id}/${s.key}`)}><ClipboardList size={13} /> Mở báo cáo</button>
        {md && <Copy text={md} label="Copy Markdown" />}
      </div>
    </div>
  );
}

function ProfileCard({ run }: { run: any }) {
  const d = run.profile_decision;
  const changes: any[] = run.graph?.profile_changes ?? [];
  if (!d) return null;
  return (
    <div className="rv-card">
      <div className="rv-card-head"><h4><Zap size={16} /> Execution profile</h4><ProfileBadge profile={run.profile} /></div>
      <div className="small muted">{d.requested === "AUTO" ? `tự chọn (${d.confidence} confidence)` : "chọn thủ công"}</div>
      <ul className="small" style={{ margin: "6px 0", paddingLeft: 18 }}>{(d.reasons ?? []).map((r: string) => <li key={r}>{r}</li>)}</ul>
      {(d.warnings ?? []).map((w: string) => <div key={w} className="rv-note" style={{ color: "var(--st-wait)", margin: "4px 0" }}><AlertTriangle size={13} />{w}</div>)}
      {changes.length > 0 && (
        <details>
          <summary>{changes.length} thay đổi so với definition</summary>
          {changes.map((c) => <div key={c.step + c.action} className="small">{c.action === "merged_into" ? <GitMerge size={12} style={{ verticalAlign: -2 }} /> : c.action === "removed" ? <Ban size={12} style={{ verticalAlign: -2 }} /> : <PenLine size={12} style={{ verticalAlign: -2 }} />} <span className="mono">{c.step}</span> {c.action === "merged_into" ? `→ ${c.into}` : c.action} — <span className="muted">{c.detail}</span></div>)}
        </details>
      )}
    </div>
  );
}

const fmtS = (ms: number) => (ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`);

/** Latency breakdown: measured queue / machine / human time per step (+ Claude, tools, commands), cost as an estimate. */
function RunTotals({ runId, tick }: { runId: number; tick: number }) {
  const { data, reload } = useApi<any>(`/api/metrics/runs/${runId}`);
  useEffect(() => void reload(), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  const t = data.totals;
  const steps = Object.entries<any>(data.per_step);
  const max = Math.max(1, ...steps.map(([, s]) => s.queue_ms + s.exec_ms + s.human_ms));
  const C = { queue: "var(--st-idle)", claude: "var(--brand)", command: "var(--st-wait)", other: "var(--st-ok)", human: "color-mix(in srgb, var(--st-wait) 40%, transparent)" };
  return (
    <div className="rv-card">
      <div className="rv-card-head"><h4><Timer size={16} /> Latency</h4><span className="muted small">đo từ PostgreSQL; chi phí là ước tính của SDK</span></div>
      <div className="rv-minis" style={{ marginBottom: 10 }}>
        <div className="rv-mini"><span>Wall</span><b>{fmtS(data.wall_ms)}</b></div>
        <div className="rv-mini"><span>Máy</span><b>{fmtS(t.exec_ms)}</b></div>
        <div className="rv-mini"><span>Queue</span><b>{fmtS(t.queue_ms)}</b></div>
        <div className="rv-mini"><span>Chờ người</span><b>{fmtS(t.human_ms)}</b></div>
      </div>
      <div className="rv-kv">
        <span>Claude</span><span>{t.claude_sessions} session · {fmtS(t.claude_ms)} · {t.turns} turns · ≈${t.cost_usd.toFixed(3)} (ước tính)</span>
        <span>Tokens</span><span>in {t.input_tokens.toLocaleString()} · out {t.output_tokens.toLocaleString()} · cache {t.cache_read_tokens.toLocaleString()}</span>
        <span>Tools</span><span>{t.tool_calls} calls · {fmtS(t.tool_ms)} · command/test {fmtS(t.command_ms)} · {t.integration_calls} integration · {t.skills_loaded} skill</span>
        <span>Retry / lỗi</span><span>{t.retries} retry · {t.failed} attempt lỗi{data.bottleneck && <> · chậm nhất: <b className="mono">{data.bottleneck}</b></>}</span>
      </div>
      <div style={{ marginTop: 12 }}>
        {steps.map(([k, s]) => (
          <div key={k} className="small" style={{ display: "grid", gridTemplateColumns: "minmax(80px, 120px) 1fr 64px", gap: 8, alignItems: "center", margin: "4px 0" }}>
            <span className="mono" title={`${s.type} · ${s.attempts} attempt`} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k}</span>
            <span className="progress" style={{ height: 8 }} title={`queue ${fmtS(s.queue_ms)} · exec ${fmtS(s.exec_ms)} · human ${fmtS(s.human_ms)}${s.claude_ms ? ` · claude ${fmtS(s.claude_ms)} / ${s.turns} turns` : ""}`}>
              <span style={{ width: `${(s.queue_ms / max) * 100}%`, background: C.queue }} />
              <span style={{ width: `${(s.exec_ms / max) * 100}%`, background: s.type === "command" ? C.command : s.claude_ms ? C.claude : C.other }} />
              <span style={{ width: `${(s.human_ms / max) * 100}%`, background: C.human }} />
            </span>
            <span className="mono muted" style={{ textAlign: "right" }}>{fmtS(s.queue_ms + s.exec_ms + s.human_ms)}</span>
          </div>
        ))}
        <div className="rv-chipline muted small" style={{ marginTop: 8, gap: 12 }}>
          {([["queue", "chờ queue"], ["claude", "Claude"], ["command", "command/test"], ["other", "bước khác"], ["human", "chờ người"]] as const).map(([k, l]) => (
            <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: C[k], display: "inline-block" }} />{l}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function RepoPicker({ run, onDone }: { run: any; onDone: () => void }) {
  const [sel, setSel] = useState<string[]>(run.selected_repositories);
  return (
    <div className="rv-card">
      <div className="rv-card-head"><h4><FolderGit2 size={16} /> Repositories cho run này</h4></div>
      <div className="rv-chipline">
        {run.allowed_repositories.map((r: string) => (
          <label key={r} className="rv-repo-opt" style={{ margin: 0, padding: "6px 10px", alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={sel.includes(r)} onChange={(e) => setSel(e.target.checked ? [...sel, r] : sel.filter((x) => x !== r))} style={{ marginTop: 0 }} /> {r}
          </label>
        ))}
      </div>
      <div className="row"><button className="sm ghost" onClick={async () => (await act(() => api(`/api/runs/${run.id}/repositories`, { repositories: sel }), "Saved")) && onDone()}>Lưu</button></div>
    </div>
  );
}

function RunTimeline({ runId, tick }: { runId: number; tick: number }) {
  const { data, reload } = useApi<any[]>(`/api/runs/${runId}/events`);
  useEffect(() => void reload(), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  return (
    <div className="rv-sec">
      <div className="rv-sec-title"><Activity size={14} /> Timeline</div>
      <div className="rv-tl">
        {data.slice().reverse().slice(0, 300).map((e) => (
          <div key={e.id} className="rv-tl-row">
            <span className="muted">{time(e.created_at)}<br /><span className="mono">{e.step_key ?? "run"}</span></span>
            <span>
              <b className="muted small">{e.kind}</b>{" "}
              <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: e.kind === "user" ? "var(--brand-700)" : undefined }}>{e.content}</span>
            </span>
          </div>
        ))}
        {!data.length && <div className="muted small" style={{ padding: 12 }}>Chưa có sự kiện.</div>}
      </div>
    </div>
  );
}

/** Up to 5 node ids around `key` (or the first 5) for the initial viewport. */
function focusNodes(ids: string[], key?: string) {
  const i = key ? ids.indexOf(key) : -1;
  const from = i < 0 ? 0 : Math.max(0, Math.min(i - 2, ids.length - 5));
  return ids.slice(from, from + 5).map((id) => ({ id }));
}
