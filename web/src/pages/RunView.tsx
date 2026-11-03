import { useEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow, type Node } from "@xyflow/react";
import { api, useApi, useLive } from "../api.ts";
import { act, Badge, Copy, ErrorBox, Loading, navigate, time } from "../ui.tsx";
import { autoLayout, nodeTypes, toEdges, type StepNodeData } from "../graph.tsx";
import { StepInspector } from "./StepInspector.tsx";
import { ProfileBadge } from "./ProfilePreview.tsx";
import { Changes } from "./Changes.tsx";

/** Live execution graph of one run + inspector. Route: #/runs/:id[/:stepKey | /~changes]. */
export function RunView({ id, stepKey }: { id: number; stepKey?: string }) {
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
  const hasWorkspaces = run.workspaces.length > 0;
  const canFeedback = run.status !== "CANCELED" && (run.graph.feedback_step || run.steps.some((s: any) => s.type === "coding_agent"));

  return (
    <>
      <div className="runbar">
        <a href="#/runs" className="small">← Runs</a>
        <b>Run #{run.id}</b>
        <span className="muted" style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{run.title}</span>
        <Badge s={run.status} />
        <ProfileBadge profile={run.profile} title={(run.profile_decision?.reasons ?? []).join("\n")} />
        <span className="muted small">
          <a href={`#/workflows/${run.definition_key}`}>{run.definition_key}</a> v{run.definition_version} · <span className="mono">{run.branch}</span>
          {run.work_item && <> · <a href={`#/work-items/${run.work_item.id}`}>{run.work_item.code}</a></>}
        </span>
        <span className="grow" />
        {run.status === "PENDING" && (
          <>
            <button className="sm" onClick={() => runAction("start")}>▶ Start</button>
            <button className="sm ghost" title="Start paused and run steps one by one" onClick={() => runAction("start", { step_mode: true })}>⏯ Step mode</button>
          </>
        )}
        {["RUNNING", "WAITING", "FAILED"].includes(run.status) && <button className="sm ghost" onClick={() => runAction("pause")}>⏸ Pause</button>}
        {run.status === "PAUSED" && <button className="sm" onClick={() => runAction("resume")}>▶ Resume</button>}
        {!["CANCELED", "COMPLETED"].includes(run.status) && <button className="sm danger" onClick={() => runAction("cancel")}>■ Cancel</button>}
        <button className={stepKey === "~changes" ? "sm" : "sm ghost"} disabled={!hasWorkspaces} title={hasWorkspaces ? "" : "No code changes yet"} onClick={() => navigate(`/runs/${id}/~changes`)}>🔍 Changes</button>
        <span className="muted small" title="update channel">{live === "sse" ? "● live" : live}</span>
      </div>
      {blocked.length > 0 && (
        <div style={{ background: "color-mix(in srgb, var(--warn) 14%, transparent)", padding: "6px 16px", fontSize: 13, borderBottom: "1px solid var(--line)" }}>
          ⏸ Đang chờ bạn:{" "}
          {blocked.map((s: any) => (
            <button key={s.key} className="ghost xs" style={{ marginRight: 6 }} onClick={() => navigate(`/runs/${id}/${s.key}`)}>
              {s.status === "WAITING_INPUT" ? "❓" : "✋"} {s.name}
            </button>
          ))}
        </div>
      )}
      <QueueBanner run={run} tick={tick} />
      {run.status === "PAUSED" && (
        <div style={{ background: "var(--panel2)", padding: "6px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }} className="muted">
          Run đang tạm dừng (step mode): chọn một bước <b>READY</b> rồi bấm “▶ Run this step”, hoặc Resume để chạy tự động.
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
            fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            minZoom={0.2}
          >
            <Background gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside className={stepKey === "~changes" ? "inspector wide" : "inspector"}>
          {stepKey === "~changes" ? (
            <Changes run={run} tick={tick} onChanged={reload} />
          ) : stepKey ? (
            <StepInspector key={stepKey} run={run} stepKey={stepKey} tick={tick} onChanged={reload} />
          ) : (
            <div>
              <h4>Tổng quan run</h4>
              <div className="row tight" style={{ gap: 6 }}>
                {Object.entries(counts).map(([s, n]) => <Badge key={s} s={s}>{s} · {n}</Badge>)}
              </div>
              <div className="kv" style={{ marginTop: 10 }}>
                <span>Selected repos</span><span>{run.selected_repositories.join(", ") || "(chưa chọn)"}</span>
                <span>Allowed repos</span><span className="small">{run.allowed_repositories.join(", ")}</span>
                <span>Created</span><span>{time(run.created_at)}</span>
                <span>Finished</span><span>{time(run.finished_at)}</span>
                {run.error && <><span>Error</span><span className="err">{run.error}</span></>}
              </div>
              <ReportCard run={run} />
              <ProfileCard run={run} />
              <RunTotals runId={id} tick={tick} />
              {run.status === "PENDING" && <RepoPicker run={run} onDone={reload} />}
              <p className="muted small">Bấm vào một node để xem cấu hình, input/output, knowledge, hội thoại Claude, câu hỏi và lịch sử attempt.</p>
              {run.pull_requests.length > 0 && (
                <>
                  <h3>Pull requests</h3>
                  {run.pull_requests.map((p: any) => <div key={p.id} className="small"><b>{p.repo}</b> · <a href={p.url} target="_blank" rel="noopener">{p.title}</a></div>)}
                </>
              )}
              {canFeedback && (
                <>
                  <h3>Feedback cho agent</h3>
                  <div className="muted small">Chạy lại bước nhận feedback ({run.graph.feedback_step ?? "coding step"}); test và PR chạy lại sau đó, PR cũ được cập nhật.</div>
                  <textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
                  <div className="row">
                    <button className="sm" disabled={!feedback.trim()} onClick={async () => (await act(() => api(`/api/runs/${id}/feedback`, { message: feedback }), "Feedback sent")) && (setFeedback(""), reload())}>Gửi feedback</button>
                  </div>
                </>
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
    <div style={{ background: "color-mix(in srgb, var(--accent) 10%, transparent)", padding: "6px 16px", fontSize: 13, borderBottom: "1px solid var(--line)" }}>
      ⏳ <b>{waiting.map((s: any) => s.name).join(", ")}</b> đang chờ worker ({data.workers} worker chung + {data.light_workers} worker cho bước nhẹ). Đang bận:{" "}
      {others.map((j: any) => (
        <a key={j.job_id} href={`#/runs/${j.run_id}/${j.step_key}`} style={{ marginRight: 10 }}>
          run #{j.run_id} · {j.step_name} ({fmt(j.running_seconds ?? 0)})
        </a>
      ))}
      <span className="muted small">— tăng scheduler.workers trong config.json để chạy song song.</span>
    </div>
  );
}

/** Shortcut to the Task Result Report (when this run has one). */
function ReportCard({ run }: { run: any }) {
  const s = run.steps.find((x: any) => x.type === "task_result_report");
  if (!s) return null;
  const report = s.output?.report ?? s.approval?.request?.report;
  const md = s.output?.markdown ?? s.approval?.request?.markdown;
  return (
    <div className="card" style={{ marginTop: 10, padding: 10, borderColor: s.status === "WAITING_APPROVAL" ? "var(--warn)" : undefined }}>
      <div className="row tight">
        <b className="grow">📋 Task Result Report</b> <Badge s={s.status} />
      </div>
      {report ? (
        <div className="small" style={{ marginTop: 4 }}>✅ {report.counts.VERIFIED} · 🟡 {report.counts.PARTIAL} · ❌ {report.counts.MISSING} {s.status === "COMPLETED" ? "· đã duyệt" : s.status === "WAITING_APPROVAL" ? "· chờ bạn xem lại" : ""}</div>
      ) : (
        <div className="muted small">Được tạo sau khi các bước của task hoàn tất.</div>
      )}
      <div className="row">
        <button className="sm ghost" onClick={() => navigate(`/runs/${run.id}/${s.key}`)}>Mở báo cáo</button>
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
    <div className="card" style={{ marginTop: 10, padding: 10 }}>
      <div className="row tight"><b className="grow">Execution profile</b><ProfileBadge profile={run.profile} /></div>
      <div className="small muted">{d.requested === "AUTO" ? `tự chọn (${d.confidence} confidence)` : "chọn thủ công"}</div>
      <ul className="small" style={{ margin: "4px 0", paddingLeft: 18 }}>{(d.reasons ?? []).map((r: string) => <li key={r}>{r}</li>)}</ul>
      {(d.warnings ?? []).map((w: string) => <div key={w} className="small" style={{ color: "var(--warn)" }}>⚠ {w}</div>)}
      {changes.length > 0 && (
        <details>
          <summary>{changes.length} thay đổi so với definition</summary>
          {changes.map((c) => <div key={c.step + c.action} className="small">{c.action === "merged_into" ? "⊕" : c.action === "removed" ? "⊘" : "✎"} <span className="mono">{c.step}</span> {c.action === "merged_into" ? `→ ${c.into}` : c.action} — <span className="muted">{c.detail}</span></div>)}
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
  return (
    <div className="card" style={{ marginTop: 10, padding: 10 }}>
      <b>⏱ Latency</b> <span className="muted small">(đo từ PostgreSQL; chi phí là ước tính của SDK)</span>
      <div className="kv" style={{ marginTop: 6 }}>
        <span>Tổng (wall)</span><span><b>{fmtS(data.wall_ms)}</b> · máy {fmtS(t.exec_ms)} · chờ queue {fmtS(t.queue_ms)} · chờ người {fmtS(t.human_ms)}</span>
        <span>Claude</span><span>{t.claude_sessions} session · {fmtS(t.claude_ms)} · {t.turns} turns · ≈${t.cost_usd.toFixed(3)} (ước tính)</span>
        <span>Tokens</span><span>in {t.input_tokens.toLocaleString()} · out {t.output_tokens.toLocaleString()} · cache {t.cache_read_tokens.toLocaleString()}</span>
        <span>Tools</span><span>{t.tool_calls} calls · {fmtS(t.tool_ms)} · command/test {fmtS(t.command_ms)} · {t.integration_calls} integration · {t.skills_loaded} skill</span>
        <span>Retry / lỗi</span><span>{t.retries} retry · {t.failed} attempt lỗi{data.bottleneck && <> · chậm nhất: <b className="mono">{data.bottleneck}</b></>}</span>
      </div>
      <div style={{ marginTop: 8 }}>
        {steps.map(([k, s]) => (
          <div key={k} className="small" style={{ display: "grid", gridTemplateColumns: "120px 1fr 64px", gap: 6, alignItems: "center", margin: "2px 0" }}>
            <span className="mono" title={`${s.type} · ${s.attempts} attempt`} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k}</span>
            <span style={{ display: "flex", height: 10, background: "var(--code)", borderRadius: 3, overflow: "hidden" }} title={`queue ${fmtS(s.queue_ms)} · exec ${fmtS(s.exec_ms)} · human ${fmtS(s.human_ms)}${s.claude_ms ? ` · claude ${fmtS(s.claude_ms)} / ${s.turns} turns` : ""}`}>
              <span style={{ width: `${(s.queue_ms / max) * 100}%`, background: "var(--muted)" }} />
              <span style={{ width: `${(s.exec_ms / max) * 100}%`, background: s.type === "command" ? "var(--warn)" : s.claude_ms ? "var(--accent)" : "var(--ok)" }} />
              <span style={{ width: `${(s.human_ms / max) * 100}%`, background: "color-mix(in srgb, var(--warn) 45%, transparent)" }} />
            </span>
            <span className="mono muted" style={{ textAlign: "right" }}>{fmtS(s.queue_ms + s.exec_ms + s.human_ms)}</span>
          </div>
        ))}
        <div className="muted small" style={{ marginTop: 4 }}>▮ xám = chờ queue · ▮ xanh dương = Claude · ▮ cam = command/test · ▮ xanh lá = bước khác · ▮ cam nhạt = chờ người</div>
      </div>
    </div>
  );
}

function RepoPicker({ run, onDone }: { run: any; onDone: () => void }) {
  const [sel, setSel] = useState<string[]>(run.selected_repositories);
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <b className="small">Repositories cho run này</b>
      <div>
        {run.allowed_repositories.map((r: string) => (
          <label key={r} style={{ marginRight: 12, fontSize: 13 }}>
            <input type="checkbox" checked={sel.includes(r)} onChange={(e) => setSel(e.target.checked ? [...sel, r] : sel.filter((x) => x !== r))} /> {r}
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
    <>
      <h3>Timeline</h3>
      <div style={{ maxHeight: 360, overflow: "auto" }}>
        {data.slice().reverse().slice(0, 300).map((e) => (
          <div key={e.id} className="small" style={{ borderBottom: "1px dashed var(--line)", padding: "3px 0" }}>
            <span className="muted">{time(e.created_at)}</span> <span className="mono muted">{e.step_key ?? "run"}</span> <b className="muted">{e.kind}</b>{" "}
            <span style={{ whiteSpace: "pre-wrap", color: e.kind === "user" ? "var(--accent)" : undefined }}>{e.content}</span>
          </div>
        ))}
      </div>
    </>
  );
}
