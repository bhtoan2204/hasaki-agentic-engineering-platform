import { useEffect } from "react";
import { agentKey } from "../../agentProvider.tsx";
import { Timer } from "lucide-react";
import { useApi } from "../../api.ts";
import { useI18n } from "../../i18n/index.tsx";
import { type RunMetrics, fmtS } from "./shared.tsx";

/** Latency breakdown: measured queue / machine / human time per step (+ Claude, tools, commands), cost as an estimate. */
export function RunTotals({ runId, tick }: { runId: number; tick: number }) {
  const { t, locale } = useI18n();
  const { data, reload } = useApi<RunMetrics>(`/api/metrics/runs/${runId}`);
  useEffect(() => void reload(), [reload, tick]);
  if (!data) return null;
  const totals = data.totals;
  const num = (n: number | null | undefined) =>
    n == null ? "—" : n.toLocaleString(locale === "vi" ? "vi-VN" : "en-GB");
  const steps = Object.entries(data.per_step);
  const max = Math.max(1, ...steps.map(([, s]) => s.queue_ms + s.exec_ms + s.human_ms));
  const C = {
    queue: "var(--st-idle)",
    claude: "var(--brand)",
    command: "var(--st-wait)",
    other: "var(--st-ok)",
    human: "color-mix(in srgb, var(--st-wait) 40%, transparent)",
  };
  return (
    <div className="rv-card">
      <div className="rv-card-head">
        <h4>
          <Timer size={16} /> {t("rv.latency")}
        </h4>
        <span className="muted small">{t("rv.latencyHint")}</span>
      </div>
      <div className="rv-minis" style={{ marginBottom: 10 }}>
        <div className="rv-mini">
          <span>{t("rv.wall")}</span>
          <b>{fmtS(data.wall_ms)}</b>
        </div>
        <div className="rv-mini">
          <span>{t("rv.machine")}</span>
          <b>{fmtS(totals.exec_ms)}</b>
        </div>
        <div className="rv-mini">
          <span>{t("rv.queue")}</span>
          <b>{fmtS(totals.queue_ms)}</b>
        </div>
        <div className="rv-mini">
          <span>{t("rv.humanWait")}</span>
          <b>{fmtS(totals.human_ms)}</b>
        </div>
      </div>
      <div className="rv-kv">
        <span>{t(agentKey(data.agent_provider, true))}</span>
        <span>
          {totals.cost_unknown || totals.cost_usd == null
            ? t("rv.agentLineNoCost", {
                sessions: totals.claude_sessions,
                time: fmtS(totals.claude_ms),
                turns: totals.turns,
              })
            : t("rv.claudeLine", {
                sessions: totals.claude_sessions,
                time: fmtS(totals.claude_ms),
                turns: totals.turns,
                cost: totals.cost_usd.toFixed(3),
              })}
        </span>
        <span>{t("common.tokens")}</span>
        <span>
          {t("rv.tokens", {
            inn: num(totals.input_tokens),
            out: num(totals.output_tokens),
            cache: num(totals.cache_read_tokens),
          })}
        </span>
        <span>{t("common.tools")}</span>
        <span>
          {t("rv.tools", {
            calls: totals.tool_calls,
            tool: fmtS(totals.tool_ms),
            command: fmtS(totals.command_ms),
            integration: totals.integration_calls,
            skills: totals.skills_loaded,
          })}
        </span>
        <span>{t("rv.retries")}</span>
        <span>
          {data.bottleneck
            ? t("rv.retrySlow", {
                retries: totals.retries,
                failed: totals.failed,
                step: data.bottleneck,
              })
            : t("rv.retryLine", {
                retries: totals.retries,
                failed: totals.failed,
              })}
        </span>
      </div>
      <div style={{ marginTop: 12 }}>
        {steps.map(([k, s]) => (
          <div
            key={k}
            className="small"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(80px, 120px) 1fr 64px",
              gap: 8,
              alignItems: "center",
              margin: "4px 0",
            }}
          >
            <span
              className="mono"
              title={t("rv.attemptTip", { type: s.type, n: s.attempts })}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {k}
            </span>
            <span
              className="progress"
              style={{ height: 8 }}
              title={`${t("rv.barTip", { queue: fmtS(s.queue_ms), exec: fmtS(s.exec_ms), human: fmtS(s.human_ms) })}${s.claude_ms ? t("rv.barClaude", { time: fmtS(s.claude_ms), turns: s.turns }) : ""}`}
            >
              <span
                style={{
                  width: `${(s.queue_ms / max) * 100}%`,
                  background: C.queue,
                }}
              />
              <span
                style={{
                  width: `${(s.exec_ms / max) * 100}%`,
                  background: s.type === "command" ? C.command : s.claude_ms ? C.claude : C.other,
                }}
              />
              <span
                style={{
                  width: `${(s.human_ms / max) * 100}%`,
                  background: C.human,
                }}
              />
            </span>
            <span className="mono muted" style={{ textAlign: "right" }}>
              {fmtS(s.queue_ms + s.exec_ms + s.human_ms)}
            </span>
          </div>
        ))}
        <div className="rv-chipline muted small" style={{ marginTop: 8, gap: 12 }}>
          {(["queue", "claude", "command", "other", "human"] as const).map((k) => (
            <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <i
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 3,
                  background: C[k],
                  display: "inline-block",
                }}
              />
              {k === "claude" ? "Claude" : t(`rv.legend.${k}`)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
