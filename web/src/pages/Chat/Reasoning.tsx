import { useI18n } from "../../i18n/index.tsx";
import { type TraceItem } from "../chatStream.ts";
import { type ToolCall } from "./shared.tsx";

/**
 * The reasoning panel. Tool entries carry the call's `#seq`, the number the answer cites as `[tool #seq]`; traces saved
 * before the trace recorded it take it from the turn's tool calls.
 */
export function Reasoning({
  trace,
  summary,
  live,
  tools,
}: {
  trace: TraceItem[];
  summary: string;
  live?: boolean;
  tools?: ToolCall[];
}) {
  const { t } = useI18n();
  return (
    <details className={`chat-reasoning${live ? " is-live" : ""}`}>
      <summary>
        {live && <span className="dot" />}
        {summary}
      </summary>
      <div className="chat-reasoning-body">
        {trace.length === 0 && <div className="muted">{t("chat.reasoning.none")}</div>}
        {trace.map((item, i) =>
          item.k === "reasoning" ? (
            <div key={i} className="chat-reasoning-text">
              {item.text}
            </div>
          ) : item.k === "knowledge" ? (
            <div key={i} className="chat-tool" title={item.key}>
              {t("chat.knowledge.item", {
                title: item.title,
                version: item.version,
                how: t(`chat.knowledge.${item.disclosure}`),
              })}
              {item.owner === "own" ? ` · ${t("chat.knowledge.own")}` : ""}
            </div>
          ) : item.k === "activity" ? (
            <div key={i} className="chat-tool">
              {item.label}
            </div>
          ) : (
            <div
              key={i}
              className={`chat-tool${["ok", "running"].includes(item.status) ? "" : " is-err"}`}
            >
              {(() => {
                const seq = item.seq ?? tools?.find((tc) => tc.id === item.id)?.seq;
                return seq != null ? `#${seq} ` : "";
              })()}
              {item.tool} — {item.status}
              {item.ms != null ? ` (${Math.round(item.ms)} ms)` : ""}
            </div>
          ),
        )}
      </div>
    </details>
  );
}
