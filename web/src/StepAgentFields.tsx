import { useI18n } from "./i18n/index.tsx";
import { useApi } from "./api.ts";
import {
  AgentValueFields,
  type AgentControls,
  type AgentCatalogModel,
} from "./AgentValueFields.tsx";
import { Field } from "./ui.tsx";

/** Shared configuration form; the server validates inherited providers and CLI capabilities. */
export function StepAgentFields({
  value = {},
  onChange,
  allowVerification = true,
}: {
  allowVerification?: boolean;
  value?: Record<string, any>;
  onChange: (v: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const { data: providers } = useApi<
    Array<{
      id: string;
      models?: AgentCatalogModel[];
      controls?: AgentControls;
      discovery?: string;
    }>
  >("/api/agent-providers");
  const set = (key: string, val: unknown) => {
    const next = { ...value };
    if (val === undefined) delete next[key];
    else next[key] = val;
    onChange(next);
  };
  const provider = value.provider;
  return (
    <>
      {allowVerification && (
        <details>
          <summary>{t("saf.fallbackPolicy")}</summary>
          <Field label={t("saf.fallbackMode")}>
            <select
              value={value.fallback?.mode ?? "manual"}
              onChange={(e) => set("fallback", { ...value.fallback, mode: e.target.value })}
            >
              {["disabled", "manual", "automatic"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label={t("saf.fallbackOrder")}>
            <input
              value={(
                value.fallback?.providers ?? ["claude", "codex", "cursor", "antigravity", "copilot"]
              ).join(", ")}
              onChange={(e) =>
                set("fallback", {
                  ...value.fallback,
                  providers: e.target.value
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field label={t("saf.maxSwitches")}>
            <input
              type="number"
              min={0}
              max={10}
              value={value.fallback?.max_switches ?? 2}
              onChange={(e) =>
                set("fallback", {
                  ...value.fallback,
                  max_switches: Number(e.target.value),
                })
              }
            />
          </Field>
          <label>
            <input
              type="checkbox"
              checked={value.fallback?.auto_health ?? true}
              onChange={(e) =>
                set("fallback", {
                  ...value.fallback,
                  auto_health: e.target.checked,
                })
              }
            />
            {t("saf.skipUnhealthy")}
          </label>
          <label>
            <input
              type="checkbox"
              checked={value.fallback?.allow_unknown_cost ?? false}
              onChange={(e) =>
                set("fallback", {
                  ...value.fallback,
                  allow_unknown_cost: e.target.checked,
                })
              }
            />
            {t("saf.allowUnknownCost")}
          </label>
          <label>
            <input
              type="checkbox"
              checked={value.fallback?.allow_budget_failure ?? false}
              onChange={(e) =>
                set("fallback", {
                  ...value.fallback,
                  allow_budget_failure: e.target.checked,
                })
              }
            />
            {t("saf.allowBudgetFailure")}
          </label>
        </details>
      )}

      <div className="grid2">
        <Field label={t("saf.agentProvider")}>
          <select
            aria-label={t("saf.agentProvider")}
            value={provider ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                provider: e.target.value || undefined,
                model: undefined,
                reasoning_effort: undefined,
                max_turns: undefined,
                options: undefined,
              })
            }
          >
            <option value="">{t("saf.inheritRun")}</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="cursor">Cursor</option>
            <option value="antigravity">Antigravity</option>
            <option value="copilot">Copilot</option>
          </select>
        </Field>
        <AgentValueFields
          label="Step"
          value={value}
          onChange={(fields) =>
            onChange({
              ...value,
              ...fields,
              model: fields.model,
              reasoning_effort: fields.reasoning_effort,
              max_turns: fields.max_turns,
              timeout_ms: fields.timeout_ms,
              options: fields.options,
            })
          }
          controls={providers?.find((entry) => entry.id === provider)?.controls}
          models={providers?.find((entry) => entry.id === provider)?.models}
          discovery={providers?.find((entry) => entry.id === provider)?.discovery}
        />
        <Field label={t("saf.executionProfile")}>
          <select
            value={value.execution_profile ?? ""}
            onChange={(e) => set("execution_profile", e.target.value || undefined)}
          >
            <option value="">{t("saf.runDefault")}</option>
            {["MICRO", "FAST", "STANDARD", "DEEP"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
        <Field label={t("saf.tokenBudget")}>
          <input
            type="number"
            min={2000}
            max={64000}
            value={value.context_tokens ?? ""}
            onChange={(e) =>
              set("context_tokens", e.target.value ? Number(e.target.value) : undefined)
            }
          />
        </Field>
        <Field label={t("saf.idleTimeout")}>
          <input
            type="number"
            min={10000}
            max={86400000}
            value={value.idle_timeout_ms ?? ""}
            placeholder={t("saf.platformDefault")}
            onChange={(e) =>
              set("idle_timeout_ms", e.target.value ? Number(e.target.value) : undefined)
            }
          />
        </Field>
        <Field label={t("saf.toolBudget")}>
          <input
            type="number"
            min={1}
            max={10000}
            value={value.max_tool_calls ?? ""}
            placeholder={t("saf.platformDefault")}
            onChange={(e) =>
              set("max_tool_calls", e.target.value ? Number(e.target.value) : undefined)
            }
          />
        </Field>
        <Field label={t("saf.retryAttempts")}>
          <input
            type="number"
            min={1}
            max={10}
            value={value.retry?.max_attempts ?? ""}
            onChange={(e) =>
              set(
                "retry",
                e.target.value
                  ? { ...value.retry, max_attempts: Number(e.target.value) }
                  : undefined,
              )
            }
          />
        </Field>
        <Field label={t("saf.retryBackoff")}>
          <input
            type="number"
            min={0}
            max={3600}
            disabled={!value.retry}
            value={value.retry?.backoff_seconds ?? ""}
            onChange={(e) =>
              set("retry", {
                ...value.retry,
                backoff_seconds: Number(e.target.value),
              })
            }
          />
        </Field>
      </div>
      {allowVerification && (
        <Field label={t("saf.verifyCommand")} hint={t("saf.verifyCommandHint")}>
          <input
            value={value.verification?.command ?? ""}
            onChange={(e) =>
              set(
                "verification",
                e.target.value ? { ...value.verification, command: e.target.value } : undefined,
              )
            }
          />
        </Field>
      )}
      <Field
        label={t("saf.allowedTools")}
        hint={provider === "cursor" ? t("saf.toolsCursorHint") : t("saf.toolsDefaultHint")}
      >
        <input
          disabled={provider === "cursor"}
          value={value.allowed_tools?.join(", ") ?? ""}
          onChange={(e) =>
            set(
              "allowed_tools",
              e.target.value.trim()
                ? e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
                : null,
            )
          }
        />
      </Field>
    </>
  );
}
