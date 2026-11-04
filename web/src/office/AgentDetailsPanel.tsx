import { Badge, dur, time } from "../ui.tsx";
import { chibiPalette, chibiSprite, Px } from "./pixels.tsx";
import { ROLE_INFO } from "./workflowToAgentMapper.ts";
import type { AgentView, EventLite } from "./types.ts";

const ICON: Record<string, string> = { tool: "🔧", tool_result: "↩", agent: "💬", thinking: "💭", prompt: "📝", system: "⚙", status: "●", system_prompt: "📜" };

function summarize(e: EventLite): string {
  if (e.kind === "tool" && e.data?.name) {
    const i = e.data.input ?? {};
    const arg = i.file_path ?? i.command ?? i.pattern ?? i.query ?? i.key ?? i.url ?? i.description ?? "";
    return `${String(e.data.name).replace(/^mcp__platform__/, "")} ${String(arg).split("\n")[0].slice(0, 120)}`;
  }
  return String(e.content ?? "").replace(/\s+/g, " ").slice(0, 160);
}

/** Execution details of the character's step(s) + links into the existing inspector / question & approval flow. */
export function AgentDetailsPanel({ agent, runId, events, now, preview, onClose }: { agent: AgentView; runId: number | null; events: EventLite[]; now: number; preview: boolean; onClose: () => void }) {
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
        <button className="ghost sm" onClick={onClose} aria-label="Đóng">✕</button>
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
              <span>{agent.pose === "ask" ? `✋ ${agent.bubble}` : "📋 Bước này đang chờ bạn duyệt"}</span>
              {link ? <a className="o-btn" href={link}>{agent.pose === "ask" ? "Trả lời câu hỏi" : "Mở phần duyệt"}</a> : <span className="muted small">(xem trước — không có gì để trả lời)</span>}
            </div>
          )}

          <h3>Hoạt động gần đây</h3>
          {recent.length ? (
            <ol className="office-events">
              {recent.map((e) => (
                <li key={e.id}>
                  <span className="office-ev-icon" aria-hidden>{ICON[e.kind] ?? "•"}</span>
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
