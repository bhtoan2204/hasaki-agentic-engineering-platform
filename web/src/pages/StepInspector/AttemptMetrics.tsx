import { defaultModelKey } from "../../agentMetrics.ts";
import { agentKey } from "../../agentProvider.tsx";
import { Cpu } from "lucide-react";
import { useI18n } from "../../i18n/index.tsx";
import { type AttemptMetricsData } from "./shared.tsx";

export function AttemptMetrics({ m }: { m: AttemptMetricsData }) {
  const { t } = useI18n();
  const tools = Object.entries<number>(m.tool_calls ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rv-card">
      <div className="rv-card-head">
        <h4>
          <Cpu size={16} /> {t("si.metrics")}
        </h4>
        <span className="mono muted small" title={m.model_source ?? ""}>
          {[
            m.provider ? t(agentKey(m.provider, true)) : null,
            m.model ||
              (m.provider && defaultModelKey(m.provider) ? t(defaultModelKey(m.provider)!) : null),
            m.reasoning_effort,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <div className="rv-minis" style={{ marginBottom: 10 }}>
        <div className="rv-mini">
          <span>{t("si.cost")}</span>
          <b>{m.cost_usd == null ? "—" : `$${Number(m.cost_usd).toFixed(4)}`}</b>
        </div>
        <div className="rv-mini">
          <span>{t("si.turns")}</span>
          <b>{m.turns ?? "—"}</b>
        </div>
        <div className="rv-mini">
          <span>{t("si.duration")}</span>
          <b>{Math.round((m.duration_ms ?? 0) / 1000)}s</b>
        </div>
        <div className="rv-mini">
          <span>{t("si.session")}</span>
          <b>{m.sessions ?? "—"}</b>
        </div>
      </div>
      <div className="rv-kv">
        <span>{t("common.tokens")}</span>
        <span>
          {m.tokens
            ? t("si.tokenLine", {
                inn: m.tokens.input,
                out: m.tokens.output,
                read: m.tokens.cache_read,
                write: m.tokens.cache_creation,
              }) +
              (m.tokens.reasoning_output
                ? ` · ${t("si.reasoningTokens", { n: m.tokens.reasoning_output })}`
                : "")
            : "—"}
        </span>
        <span>{t("si.disclosure")}</span>
        <span>
          {t("si.disclosureLine", {
            inline: m.disclosure?.inline,
            index: m.disclosure?.index,
            search: m.disclosure?.search,
            full: m.upstream?.full,
            summary: m.upstream?.summary,
          })}
        </span>
        <span>{t("common.tools")}</span>
        <span className="small">
          {tools.map(([k, v]) => `${k.replace("mcp__platform__", "platform·")}×${v}`).join(", ") ||
            "—"}
          {m.tool_errors ? ` · ${t("si.toolErrors", { n: m.tool_errors })}` : ""}
        </span>
        <span>{t("si.skillsLoaded")}</span>
        <span className="small">
          {(m.skills_loaded ?? []).join(", ") || "—"}
          {m.knowledge_searches?.length
            ? ` · ${t("si.searched", { q: m.knowledge_searches.map((q: string) => `"${q}"`).join(", ") })}`
            : ""}
        </span>
        {!!m.skills?.length && (
          <>
            <span>{t("si.skillActivation")}</span>
            <span className="small">
              {m.skills.map(
                (s: {
                  key: string;
                  version: number;
                  tier: string;
                  tokens: number;
                  states: string[];
                  evidence: string[];
                  loaded_unused: boolean;
                  provider_limited: boolean;
                }) => (
                  <div key={s.key} title={s.evidence.join(", ")}>
                    {s.key}@v{s.version} · {s.tier} · {s.tokens} tokens · {s.states.join(" → ")}
                    {s.loaded_unused ? " · loaded_unused" : ""}
                    {s.provider_limited ? " · provider_limited" : ""}
                  </div>
                ),
              )}
            </span>
          </>
        )}
        <span>{t("si.integration")}</span>
        <span className="small">
          {(m.integration_calls ?? [])
            .map((c) => `${c.name} ${c.ok ? "✓" : "✗"} ${c.ms}ms`)
            .join(", ") || "—"}
        </span>
        <span>{t("si.subagents")}</span>
        <span className="small">{(m.subagents ?? []).map((s) => s.type).join(", ") || "—"}</span>
        {!!m.denied?.length && (
          <>
            <span>{t("si.blocked")}</span>
            <span className="small err">
              {m.denied
                .map((d) => `${d.tool}${d.subagent ? ` (${d.subagent})` : ""}: ${d.reason}`)
                .join(" · ")}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
