import { Field } from "./ui.tsx";

export interface AgentValues {
  model?: string | null;
  reasoning_effort?: string | null;
  max_turns?: number;
  timeout_ms?: number;
  options?: { sandbox?: boolean; max_concurrent?: number };
}
export interface AgentControls {
  max_turns: boolean;
  efforts: string[];
  options: string[];
}
export interface AgentCatalogModel {
  slug: string;
  name?: string;
  efforts?: string[];
}

/** Shared capability-driven controls for provider defaults, profile mappings and step overrides. */
export function AgentValueFields({
  value,
  onChange,
  controls,
  models = [],
  label = "",
  discovery,
}: {
  value: AgentValues;
  onChange: (value: AgentValues) => void;
  controls?: AgentControls;
  models?: AgentCatalogModel[];
  label?: string;
  discovery?: string;
}) {
  const set = (key: keyof AgentValues, next: unknown) => {
    const result = { ...value };
    if (next === undefined) delete result[key];
    else Object.assign(result, { [key]: next });
    onChange(result);
  };
  const selected = models.find((model) => model.slug === value.model);
  const efforts = selected?.efforts ?? controls?.efforts ?? [];
  const name = (text: string) => `${label}${label ? " " : ""}${text}`;
  return (
    <div className="agent-value-fields">
      <Field
        label={name("model")}
        hint={
          value.model === null
            ? "Account/CLI default (external)"
            : "Empty inherits from the next configuration level"
        }
      >
        <input
          aria-label={name("model")}
          value={value.model ?? ""}
          placeholder="Inherit"
          onChange={(event) => set("model", event.target.value || undefined)}
        />
        <select
          aria-label={name("model selection")}
          value={value.model === null ? "__account__" : (value.model ?? "")}
          onChange={(event) =>
            set(
              "model",
              event.target.value === "__account__" ? null : event.target.value || undefined,
            )
          }
        >
          <option value="">Inherit</option>
          <option value="__account__">Account/CLI default</option>
          {value.model && !selected && (
            <option value={value.model}>{value.model} (saved selection)</option>
          )}
          {models.map((model) => (
            <option key={model.slug} value={model.slug}>
              {model.name ?? model.slug}
            </option>
          ))}
        </select>
        {discovery === "available" && value.model && !selected && (
          <small className="set-warn">
            Model is absent from the current catalog; execution will validate availability.
          </small>
        )}
      </Field>
      {!!efforts.length && (
        <Field label={name("reasoning effort")}>
          <select
            aria-label={name("reasoning effort")}
            value={value.reasoning_effort === null ? "__account__" : (value.reasoning_effort ?? "")}
            onChange={(event) =>
              set(
                "reasoning_effort",
                event.target.value === "__account__" ? null : event.target.value || undefined,
              )
            }
          >
            <option value="">Inherit</option>
            <option value="__account__">Account/CLI default</option>
            {value.reasoning_effort && !efforts.includes(value.reasoning_effort) && (
              <option value={value.reasoning_effort}>
                {value.reasoning_effort} (saved; unavailable for this model)
              </option>
            )}
            {efforts.map((effort) => (
              <option key={effort}>{effort}</option>
            ))}
          </select>
        </Field>
      )}
      {controls?.max_turns && (
        <Field label={name("maximum turns")}>
          <input
            aria-label={name("maximum turns")}
            type="number"
            min={1}
            max={500}
            value={value.max_turns ?? ""}
            placeholder="Inherit"
            onChange={(event) =>
              set("max_turns", event.target.value ? Number(event.target.value) : undefined)
            }
          />
        </Field>
      )}
      <Field label={name("timeout (ms)")}>
        <input
          aria-label={name("timeout (ms)")}
          type="number"
          min={1000}
          max={86400000}
          value={value.timeout_ms ?? ""}
          placeholder="Inherit"
          onChange={(event) =>
            set("timeout_ms", event.target.value ? Number(event.target.value) : undefined)
          }
        />
      </Field>
      {controls?.options.includes("sandbox") && (
        <Field label={name("sandbox")}>
          <select
            aria-label={name("sandbox")}
            value={value.options?.sandbox === undefined ? "" : String(value.options.sandbox)}
            onChange={(event) =>
              set("options", {
                ...value.options,
                sandbox: event.target.value === "" ? undefined : event.target.value === "true",
              })
            }
          >
            <option value="">Inherit</option>
            <option value="true">Enabled</option>
            <option value="false">Disabled (existing isolation gates still apply)</option>
          </select>
        </Field>
      )}
      {controls?.options.includes("max_concurrent") && (
        <Field label={name("maximum concurrent executions")}>
          <input
            aria-label={name("maximum concurrent executions")}
            type="number"
            min={1}
            max={8}
            value={value.options?.max_concurrent ?? ""}
            onChange={(event) =>
              set("options", {
                ...value.options,
                max_concurrent: event.target.value ? Number(event.target.value) : undefined,
              })
            }
          />
        </Field>
      )}
    </div>
  );
}
