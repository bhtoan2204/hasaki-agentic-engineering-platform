import { Circle, ClipboardCheck, CornerDownLeft, FileText, Hand, Lightbulb, MessageSquare, ScrollText, Settings, Wrench, X, type LucideIcon } from "lucide-react";
import { Badge, dur, time } from "../ui.tsx";
import { chibiPalette, chibiSprite, Px } from "./pixels.tsx";
import { ROLE_INFO } from "./workflowToAgentMapper.ts";
import type { AgentView, AttemptLite, EventLite } from "./types.ts";

const ICON: Record<string, LucideIcon> = { tool: Wrench, tool_result: CornerDownLeft, agent: MessageSquare, thinking: Lightbulb, prompt: FileText, system: Settings, status: Circle, system_prompt: ScrollText };

function summarize(e: EventLite): string {
  if (e.kind === "tool" && e.data?.name) {
    const i = e.data.input ?? {};
    const arg = i.file_path ?? i.command ?? i.pattern ?? i.query ?? i.key ?? i.url ?? i.description ?? "";
    return `${String(e.data.name).replace(/^mcp__platform__/, "")} ${String(arg).split("\n")[0].slice(0, 120)}`;
  }
  return String(e.content ?? "").replace(/\s+/g, " ").slice(0, 160);
}

/** Execution details of the character's step(s) + links into the existing inspector / question & approval flow. */
export function AgentDetailsPanel({ agent, runId, events, now, preview, onClose, attempts = [] }: { agent: AgentView; runId: number | null; events: EventLite[]; now: number; preview: boolean; onClose: () => void; attempts?: AttemptLite[] }) {
  const info = ROLE_INFO[agent.role];
  const s = chibiSprite(agent.role);
  const pal = chibiPalette(agent.role);
  const step = agent.step;
  const link = step && runId && !preview ? `#/runs/${runId}/${encodeURIComponent(step.key)}` : null;
  const recent = events.filter((e) => e.kind !== "system_prompt" && e.kind !== "prompt").slice(-14).reverse();
  const elapsed = agent.attempt?.started_at && !agent.attempt.finished_at ? now - Date.parse(agent.attempt.started_at) : agent.durationMs;
  return (
    <aside className="office-panel" aria-label={`Chi tiết ${info.name} · ${info.title}`}>
      <header className="office-panel-head">
        <svg viewBox="1 0 28 30" className="office-portrait" shapeRendering="crispEdges" aria-hidden>
          <Px rows={s.body} pal={pal} /><Px rows={s.head} pal={pal} /><Px rows={s.eyes} pal={pal} /><Px rows={s.mouth.smile} pal={pal} />
        </svg>
        <div className="grow">
          <div className="office-panel-name">{info.name} <span className="muted">· {info.title}</span></div>
          <div className="muted small">{info.does}</div>
        </div>
        <button className="quiet icon" onClick={onClose} aria-label="Đóng"><X size={17} /></button>
      </header>

      {!step ? (
        <p className="muted">Run này không có bước nào thuộc vai trò {info.title}.</p>
      ) : (
        <>
          <div className="office-panel-now">
            <div className="row tight"><b>{step.name}</b> <Badge s={step.status} />{agent.retrying && <span className="small okc">thử lại</span>}</div>
            <div className="small muted mono">{step.key} · {step.type}{agent.attempt ? ` · attempt #${agent.attempt.number}` : ""}</div>
            <div className="office-panel-activity">{agent.bubble}</div>
            <div className="small muted">
              {agent.attempt?.started_at && <>Bắt đầu {time(agent.attempt.started_at)}</>}
              {elapsed != null && <> · {agent.attempt?.finished_at ? "mất" : "đã chạy"} {dur(elapsed)}</>}
            </div>
          </div>

          {(agent.pose === "ask" || agent.pose === "approval") && (
            <div className="office-panel-cta">
              <span className="row tight" style={{ gap: 6 }}>{agent.pose === "ask" ? <><Hand size={15} /> {agent.bubble}</> : <><ClipboardCheck size={15} /> Bước này đang chờ bạn duyệt</>}</span>
              {link ? <a className="o-btn" href={link}>{agent.pose === "ask" ? "Trả lời câu hỏi" : "Mở phần duyệt"}</a> : <span className="muted small">(xem trước — không có gì để trả lời)</span>}
            </div>
          )}

          <VerificationCard v={agent.attempt?.metrics?.verification ?? agent.attempt?.output?.verification} />

          <h3>Hoạt động gần đây</h3>
          {recent.length ? (
            <ol className="office-events">
              {recent.map((e) => (
                <li key={e.id}>
                  <span className="office-ev-icon" aria-hidden>{(() => { const I = ICON[e.kind] ?? Circle; return <I size={13} />; })()}</span>
                  <span className="office-ev-text">{summarize(e)}</span>
                  <span className="office-ev-time">{time(e.created_at)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">{agent.status === "PENDING" ? "Chưa chạy." : "Chưa có sự kiện nào được ghi cho attempt này."}</p>
          )}
        </>
      )}

      <StepHistory attempts={attempts.filter((a) => agent.steps.some((st) => st.key === a.step_key))} />

      {agent.steps.length > 1 && (
        <>
          <h3>Các bước của {info.title}</h3>
          <ul className="office-steps">
            {agent.steps.map((x) => (
              <li key={x.key}>
                {runId && !preview ? <a href={`#/runs/${runId}/${encodeURIComponent(x.key)}`}>{x.name}</a> : x.name} <Badge s={x.status} />
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="row">
        {link && <a className="o-btn" href={link}>Mở Step Inspector →</a>}
        {runId && !preview && <a className="small" href={`#/runs/${runId}`}>Xem graph của run</a>}
      </div>
    </aside>
  );
}

/** Harness verification of the current attempt (real metrics only; nothing rendered when absent). */
function VerificationCard({ v }: { v: any }) {
  if (!v || typeof v !== "object") return null;
  const tone = v.passed === true ? (v.status === "accepted_with_preexisting" || v.needs_review ? "WAITING" : "COMPLETED") : v.passed === false ? "FAILED" : "PENDING";
  return (
    <>
      <h3>Verification</h3>
      <div className="office-verify">
        <div className="row tight">
          <Badge s={tone}>{String(v.status ?? v.outcome ?? "—")}</Badge>
          {typeof v.rounds === "number" && <span className="small muted">{v.rounds} vòng · sửa {v.repairs ?? 0}/{v.max_repairs ?? "?"}</span>}
          {typeof v.duration_ms === "number" && <span className="small muted">· {dur(v.duration_ms)}</span>}
        </div>
        {(v.last ?? []).map((r: any) => (
          <div key={r.repo} className="small office-verify-repo">
            <b>{r.repo}</b> <span className="mono">{r.status ?? (r.passed ? "passed" : "failed")}</span>
            {r.regressions?.length > 0 && <span> · {r.regressions.map((g: any) => [String(g.package).split("/").pop(), ...(g.tests ?? [])].slice(0, 3).join(" ")).join("; ")}</span>}
            {r.weakened?.length > 0 && <span className="err"> · test bị làm yếu: {r.weakened.join(", ")}</span>}
            {r.note && <div className="muted">{r.note}</div>}
            {r.error && <div className="err">{r.error}</div>}
          </div>
        ))}
        {v.needs_review && <div className="small" style={{ color: "var(--st-wait)" }}>Cần người xem lại: {(v.review_reasons ?? []).join("; ")}</div>}
        {v.reason && <div className="small muted">{v.reason}</div>}
      </div>
    </>
  );
}

/** Attempts of the role's steps (newest first) with their errors. */
function StepHistory({ attempts }: { attempts: AttemptLite[] }) {
  if (!attempts.length) return null;
  const list = [...attempts].sort((a, b) => b.id - a.id).slice(0, 8);
  return (
    <>
      <h3>Lịch sử attempt</h3>
      <ol className="office-history">
        {list.map((a) => (
          <li key={a.id}>
            <span className="mono small">{a.step_key} #{a.number}</span> <Badge s={a.status} />
            {a.started_at && a.finished_at && <span className="small muted"> {dur(Date.parse(a.finished_at) - Date.parse(a.started_at))}</span>}
            {a.error && <div className="small err">{String(typeof a.error === "string" ? a.error : a.error?.message ?? JSON.stringify(a.error)).split("\n")[0].slice(0, 200)}</div>}
          </li>
        ))}
      </ol>
    </>
  );
}
