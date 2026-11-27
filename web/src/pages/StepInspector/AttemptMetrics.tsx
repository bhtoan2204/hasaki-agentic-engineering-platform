import { Check, Cpu, X } from "lucide-react";
import { defaultModelKey } from "../../agentMetrics.ts";
import { agentKey } from "../../agentProvider.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { type AttemptMetricsData } from "./shared.tsx";

export function AttemptMetrics({ m }: { m: AttemptMetricsData }) {
  const { t } = useI18n();
  const tools = Object.entries<number>(m.tool_calls ?? {}).sort((a, b) => b[1] - a[1]);
  const modelMeta = [
    m.provider ? t(agentKey(m.provider, true)) : null,
    m.model ||
      (m.provider && defaultModelKey(m.provider) ? t(defaultModelKey(m.provider)!) : null),
    m.reasoning_effort,
  ].filter(Boolean);
  return (
    <div className="rv-card">
      <div className="rv-card-head">
        <h4>
          <Cpu size={16} /> {t("si.metrics")}
        </h4>
        <span className="mono muted small rv-inline-meta" title={m.model_source ?? ""}>
          {modelMeta.map((part, i) => (
            <span key={i}>{part}</span>
          ))}
        </span>
      </div>
      <div className="rv-minis si-minis-mb">
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
                  <div key={s.key} className="rv-inline-meta" title={s.evidence.join(", ")}>
                    <span className="mono">
                      {s.key}@v{s.version}
                    </span>
                    <span>{s.tier}</span>
                    <span>{s.tokens} tokens</span>
                    <span>{s.states.join(" → ")}</span>
                    {s.loaded_unused && <span>loaded_unused</span>}
                    {s.provider_limited && <span>provider_limited</span>}
                  </div>
                ),
              )}
            </span>
          </>
        )}
        <span>{t("si.integration")}</span>
        <span className="small rv-inline-meta">
          {m.integration_calls?.length
            ? m.integration_calls.map((c, i) => (
                <span key={`${c.name}-${i}`} className="rv-inline-meta">
                  {c.ok ? (
                    <Check size={12} aria-hidden className="okc" />
                  ) : (
                    <X size={12} aria-hidden className="err" />
                  )}
                  <span>
                    {c.name} {c.ms}ms
                  </span>
                </span>
              ))
            : "—"}
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
