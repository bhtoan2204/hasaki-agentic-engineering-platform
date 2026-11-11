import { useApi } from "./api.ts";
import { useI18n } from "./i18n/index.tsx";
import { Field } from "./ui.tsx";

/** Default agent providers a run can be created with. Agent steps can override this default. */
export const AGENT_PROVIDERS = ["claude", "cursor", "codex", "antigravity"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export function asProvider(v: unknown): AgentProvider {
  return (AGENT_PROVIDERS as readonly unknown[]).includes(v) ? (v as AgentProvider) : "claude";
}

/** i18n key of a provider's name: full ("Claude Code", "OpenAI Codex", "Google Antigravity") or short ("Claude", "Codex", "Antigravity"). */
export const agentKey = (p: unknown, short = false) =>
  `run.${short ? "agentShort" : "agent"}.${asProvider(p)}`;

interface ProviderStatus {
  id: AgentProvider;
  ok: boolean;
  error?: string;
  version?: string;
  auth?: string;
  model?: string | null;
  reasoning_effort?: string | null;
}

/** Provider select for run forms. For Codex and Antigravity it states readiness and account context. */
export function AgentProviderField({
  value,
  onChange,
}: {
  value: AgentProvider;
  onChange: (p: AgentProvider) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t("run.agent")} hint={t("run.agentHint")}>
        <select value={value} onChange={(e) => onChange(asProvider(e.target.value))}>
          {AGENT_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {t(agentKey(p))}
            </option>
          ))}
        </select>
      </Field>
      {value === "codex" && <CodexNotice />}
      {value === "antigravity" && <AntigravityNotice />}
    </>
  );
}

function CodexNotice() {
  const { t } = useI18n();
  const { data, error } = useApi<ProviderStatus[]>("/api/agent-providers");
  const codex = data?.find((p) => p.id === "codex");
  return (
    <div className="agent-notice" role="note">
      <p>{t("run.codex.account")}</p>
      {error && (
        <p className="agent-notice-err">
          {t("run.codex.statusUnknown")}: {error}
        </p>
      )}
      {!data && !error && <p className="muted">{t("run.codex.checking")}</p>}
      {codex && codex.ok && (
        <p className="muted">
          {t("run.codex.ready", {
            version: codex.version ?? "codex",
            auth: codex.auth ?? "?",
          })}
          {" · "}
          {t("run.codex.model", {
            model: codex.model || t("run.codex.defaultModel"),
            effort: codex.reasoning_effort || t("run.codex.defaultEffort"),
          })}
        </p>
      )}
      {codex && !codex.ok && (
        <p className="agent-notice-err">
          {t("run.codex.notReady")}: {codex.error}
        </p>
      )}
    </div>
  );
}

function AntigravityNotice() {
  const { t } = useI18n();
  const { data, error } = useApi<ProviderStatus[]>("/api/agent-providers");
  const agy = data?.find((p) => p.id === "antigravity");
  return (
    <div className="agent-notice" role="note">
      <p>{t("run.antigravity.account")}</p>
      {error && (
        <p className="agent-notice-err">
          {t("run.antigravity.statusUnknown")}: {error}
        </p>
      )}
      {!data && !error && <p className="muted">{t("run.antigravity.checking")}</p>}
      {agy && agy.ok && (
        <p className="muted">
          {t("run.antigravity.ready", {
            version: agy.version ?? "agy",
            auth: agy.auth ?? "?",
          })}
          {" · "}
          {t("run.antigravity.model", {
            model: agy.model || t("run.antigravity.defaultModel"),
            effort: agy.reasoning_effort || t("run.antigravity.defaultEffort"),
          })}
        </p>
      )}
      {agy && !agy.ok && (
        <p className="agent-notice-err">
          {t("run.antigravity.notReady")}: {agy.error}
        </p>
      )}
    </div>
  );
}
