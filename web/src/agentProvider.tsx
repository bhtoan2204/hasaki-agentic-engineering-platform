import { useApi } from "./api.ts";
import { useI18n } from "./i18n/index.tsx";
import { Field } from "./ui.tsx";

/** Default agent providers a run can be created with. Agent steps can override this default. */
export const AGENT_PROVIDERS = ["claude", "cursor", "codex"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export function asProvider(v: unknown): AgentProvider {
  return (AGENT_PROVIDERS as readonly unknown[]).includes(v) ? (v as AgentProvider) : "claude";
}

/** i18n key of a provider's name: full ("Claude Code", "OpenAI Codex") or short ("Claude", "Codex"). */
export const agentKey = (p: unknown, short = false) => `run.${short ? "agentShort" : "agent"}.${asProvider(p)}`;

interface ProviderStatus {
  id: AgentProvider;
  ok: boolean;
  error?: string;
  version?: string;
  auth?: string;
  model?: string | null;
  reasoning_effort?: string | null;
}

/** Provider select for run forms. For Codex it states whose account runs the work and whether the worker is ready. */
export function AgentProviderField({ value, onChange }: { value: AgentProvider; onChange: (p: AgentProvider) => void }) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t("run.agent")} hint={t("run.agentHint")}>
        <select value={value} onChange={(e) => onChange(asProvider(e.target.value))}>
          {AGENT_PROVIDERS.map((p) => (
            <option key={p} value={p}>{t(agentKey(p))}</option>
          ))}
        </select>
      </Field>
      {value === "codex" && <CodexNotice />}
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
      {error && <p className="agent-notice-err">{t("run.codex.statusUnknown")}: {error}</p>}
      {!data && !error && <p className="muted">{t("run.codex.checking")}</p>}
      {codex && codex.ok && (
        <p className="muted">
          {t("run.codex.ready", { version: codex.version ?? "codex", auth: codex.auth ?? "?" })}
          {" · "}
          {t("run.codex.model", { model: codex.model || t("run.codex.defaultModel"), effort: codex.reasoning_effort || t("run.codex.defaultEffort") })}
        </p>
      )}
      {codex && !codex.ok && <p className="agent-notice-err">{t("run.codex.notReady")}: {codex.error}</p>}
    </div>
  );
}
