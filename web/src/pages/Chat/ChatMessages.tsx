import { memo } from "react";
import { Copy, RefreshCw, Workflow, FileSearch, AlertTriangle } from "lucide-react";
import { Markdown, ago } from "../../ui.tsx";
import { Reasoning } from "./Reasoning.tsx";
import {
  type ChatActions,
  DocChips,
  type Message,
  type Operation,
  Operations,
  type T,
  Thumbs,
  type ToolCall,
  type Turn,
  traceSummary,
} from "./shared.tsx";

/**
 * The stored transcript. Memoized: a streamed delta, a status line or a keystroke in the composer re-renders the page
 * but not these messages (with a long conversation that was most of each render), only a new detail does.
 */
export const ChatMessages = memo(function ChatMessages({
  messages,
  turnsById,
  toolsByTurn,
  opsByTurn,
  hasActiveTurn,
  actions,
  t,
}: {
  messages: Message[];
  turnsById: Map<number, Turn>;
  toolsByTurn: Map<number, ToolCall[]>;
  opsByTurn: Map<number | null, Operation[]>;
  hasActiveTurn: boolean;
  actions: ChatActions;
  t: T;
}) {
  return (
    <>
      {messages.map((m) => {
        const turn = m.turn_id ? turnsById.get(m.turn_id) : undefined;
        const tools = m.turn_id ? toolsByTurn.get(m.turn_id) : undefined;
        return (
          <div key={m.id} className="chat-block">
            <article className={`chat-bubble is-${m.role}`}>
              <div className="chat-bubble-meta">
                <span>
                  {m.role === "user"
                    ? t("chat.role.user")
                    : m.role === "assistant"
                      ? t("chat.role.assistant")
                      : t("chat.role.system")}
                </span>
                {m.role === "assistant" && turn?.provider && (
                  <span className="chat-meta-pill">
                    {turn.provider}
                    {turn.model ? ` · ${turn.model}` : ""}
                    {turn.route ? ` · ${turn.route}` : ""}
                  </span>
                )}
                {m.role === "assistant" && turn && ["canceled", "failed"].includes(turn.status) && (
                  <span className="chat-meta-pill is-partial">
                    {t(turn.status === "canceled" ? "chat.partial.stopped" : "chat.partial.failed")}
                  </span>
                )}
                <span>{ago(m.created_at)}</span>
              </div>
              {m.role === "assistant" && !!turn?.trace?.length && (
                <Reasoning trace={turn.trace} summary={traceSummary(turn, t)} tools={tools} />
              )}
              {m.role === "assistant" ? (
                <Markdown text={m.content} />
              ) : (
                <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
              )}
              <Thumbs
                items={(m.attachments ?? [])
                  .filter((a) => a.kind !== "document")
                  .map((a) => ({ key: a.id, src: `/api/chat/attachments/${a.id}` }))}
                label={t("chat.attach.open")}
              />
              <DocChips
                items={(m.attachments ?? [])
                  .filter((a) => a.kind === "document")
                  .map((a) => ({
                    key: a.id,
                    name: a.filename || `#${a.id}`,
                    bytes: a.bytes,
                    href: `/api/chat/attachments/${a.id}`,
                  }))}
              />
              {!!tools?.length && !turn?.trace?.length && (
                <details className="chat-tools">
                  <summary>{t("chat.tools", { n: tools.length })}</summary>
                  {tools.map((tc) => (
                    <div key={tc.id} className={`chat-tool${tc.status === "ok" ? "" : " is-err"}`}>
                      #{tc.seq} {tc.tool} — {tc.status}
                      {tc.duration_ms != null ? ` (${Math.round(tc.duration_ms)} ms)` : ""}
                    </div>
                  ))}
                </details>
              )}
              {!!m.citations?.length && (
                <div className="chat-citations">
                  {m.citations.map((c, i) => (
                    <span key={i} className="chat-cite" title={c.ref}>
                      {c.label}
                    </span>
                  ))}
                </div>
              )}
              {m.role === "assistant" && (
                <div className="chat-bubble-actions">
                  <button
                    type="button"
                    className="ghost xs"
                    aria-label={t("chat.copy")}
                    onClick={() => actions.copy(m.content)}
                  >
                    <Copy size={14} />
                  </button>
                  {m.turn_id && !hasActiveTurn && (
                    <button
                      type="button"
                      className="ghost xs"
                      aria-label={t("chat.regenerate")}
                      onClick={() => actions.regenerate(m.turn_id!)}
                    >
                      <RefreshCw size={14} />
                    </button>
                  )}
                  <span
                    className="chat-bubble-launch"
                    role="group"
                    aria-label={t("chat.startWork")}
                  >
                    <span className="muted small">{t("chat.startWork")}</span>
                    <button
                      type="button"
                      className="ghost xs"
                      onClick={() => actions.delegate("task")}
                    >
                      <Workflow size={14} /> {t("chat.createTask")}
                    </button>
                    <button
                      type="button"
                      className="ghost xs"
                      onClick={() => actions.delegate("delegate")}
                    >
                      {t("chat.delegate")}
                    </button>
                    <button
                      type="button"
                      className="ghost xs"
                      title={t("chat.investigateTip")}
                      onClick={() => actions.delegate("investigation")}
                    >
                      <FileSearch size={14} /> {t("chat.investigate")}
                    </button>
                  </span>
                </div>
              )}
            </article>
            {m.role === "assistant" && m.turn_id != null && (
              <Operations
                ops={opsByTurn.get(m.turn_id) ?? []}
                onDecide={actions.decide}
                onDecideMany={actions.decideMany}
              />
            )}
            {m.role === "user" && turn?.status === "failed" && turn.failure && (
              <div className="chat-failure" role="alert">
                <AlertTriangle size={16} />
                <div>
                  <div className="chat-failure-title">
                    {turn.failure.code ?? "ERROR"}
                    {turn.failure.provider ? ` · ${turn.failure.provider}` : ""}
                  </div>
                  <div>{turn.failure.message}</div>
                  {turn.failure.fallback_attempted && (
                    <div className="muted">{t("chat.failure.fallbackTried")}</div>
                  )}
                  <div className="chat-failure-actions">
                    <button type="button" className="sm" onClick={() => actions.retry(turn)}>
                      {t("chat.retry")}
                    </button>
                    <button
                      type="button"
                      className="ghost sm"
                      onClick={() => actions.retryOther(turn)}
                    >
                      {t("chat.retryOther")}
                    </button>
                    <a className="btn ghost sm" href="#/settings">
                      {t("chat.openSettings")}
                    </a>
                    <button type="button" className="ghost sm" onClick={actions.refreshHealth}>
                      {t("chat.refreshHealth")}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
});
