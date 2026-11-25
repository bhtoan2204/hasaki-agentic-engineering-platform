import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X } from "lucide-react";
import { Field } from "./ui.tsx";
import { useI18n } from "./i18n/index.tsx";
import type { AgentValues } from "./agentConfiguration.ts";
export type { AgentValues } from "./agentConfiguration.ts";

export interface AgentControls {
  model?: boolean | null;
  max_turns: boolean;
  efforts: string[];
  options: string[];
}
export interface AgentCatalogModel {
  slug: string;
  name?: string;
  efforts?: string[];
}

export function resolveSupportedEfforts(
  controls?: AgentControls,
  models: AgentCatalogModel[] = [],
  modelSlug?: string | null,
): string[] {
  const allowed = controls?.efforts ?? [];
  if (!allowed.length) return [];
  const selected = modelSlug ? models.find((model) => model.slug === modelSlug) : undefined;
  if (!selected?.efforts?.length) return allowed;
  const filtered = selected.efforts.filter((effort) => allowed.includes(effort));
  return filtered.length ? filtered : allowed;
}

/**
 * Single Combobox / Autocomplete for model selection:
 * - Supports typing any custom model ID directly
 * - Supports selecting from discovered catalog models, "Inherit", or "Account/CLI default"
 */
export function ModelCombobox({
  value,
  onChange,
  models = [],
  discovery,
  ariaLabel,
  placeholder,
  disabled = false,
}: {
  value?: string | null;
  onChange: (next: string | null | undefined) => void;
  models?: AgentCatalogModel[];
  discovery?: string;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const effectivePlaceholder = placeholder ?? t("set.routingInherit");
  const [open, setOpen] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const textValue = value ?? "";
  const query = filtering ? textValue.trim().toLowerCase() : "";
  const filteredModels = query
    ? models.filter(
        (m) =>
          m.slug.toLowerCase().includes(query) || (m.name && m.name.toLowerCase().includes(query)),
      )
    : models;

  const selectedCatalogModel = value ? models.find((model) => model.slug === value) : undefined;

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const el = wrapRef.current;
      if (!el || !el.isConnected) {
        setOpen(false);
        return;
      }
      const r = el.getBoundingClientRect();
      setMenuRect({
        top: r.bottom + 4,
        left: r.left,
        width: Math.max(r.width, 220),
      });
    };
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !wrapRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
        setFiltering(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  const selectValue = (next: string | null | undefined) => {
    onChange(next);
    setOpen(false);
    setFiltering(false);
    setActiveIndex(-1);
  };

  type ComboOption = {
    key: string;
    label: string;
    sub?: string;
    val: string | null | undefined;
    active: boolean;
  };
  const options: ComboOption[] = [
    {
      key: "__inherit__",
      label: t("set.routingInherit"),
      sub: t("set.comboNextLevel"),
      val: undefined,
      active: value === undefined,
    },
    {
      key: "__account__",
      label: t("set.modelAccount"),
      sub: t("set.comboExternalDefault"),
      val: null,
      active: value === null,
    },
    ...filteredModels.map((m) => ({
      key: m.slug,
      label: m.name && m.name !== m.slug ? m.name : m.slug,
      sub: m.name && m.name !== m.slug ? m.slug : undefined,
      val: m.slug,
      active: value === m.slug,
    })),
  ];

  const isOverridden = value !== undefined;

  return (
    <div className="agent-combobox-wrap" ref={wrapRef}>
      <div
        className={`agent-combobox${isOverridden ? " is-overridden" : ""}${open ? " is-open" : ""}`}
      >
        <input
          ref={inputRef}
          aria-label={ariaLabel}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={textValue}
          placeholder={value === null ? t("set.modelAccount") : effectivePlaceholder}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw ? raw : undefined);
            setFiltering(true);
            setActiveIndex(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (!open) {
                setOpen(true);
                setFiltering(false);
                setActiveIndex(0);
              } else {
                setActiveIndex((i) => Math.min(options.length - 1, i + 1));
              }
            } else if (event.key === "ArrowUp" && open) {
              event.preventDefault();
              setActiveIndex((i) => Math.max(0, i - 1));
            } else if (event.key === "Enter" && open && activeIndex >= 0 && options[activeIndex]) {
              event.preventDefault();
              selectValue(options[activeIndex].val);
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              setOpen(false);
              setFiltering(false);
            }
          }}
          onBlur={() => {
            // Defer closing so option mousedown can fire first if clicked
            setTimeout(() => {
              if (
                !wrapRef.current?.contains(document.activeElement) &&
                !menuRef.current?.contains(document.activeElement)
              ) {
                setOpen(false);
                setFiltering(false);
              }
            }, 120);
          }}
        />
        {value === null && (
          <span className="agent-combo-mode-tag" title={t("set.modelAccount")}>
            {t("set.cliDefaultOnly")}
          </span>
        )}
        {value !== undefined && !disabled && (
          <button
            type="button"
            tabIndex={-1}
            className="agent-combo-clear"
            aria-label={`${t("set.reset")} ${ariaLabel}`}
            title={t("set.resetInherit")}
            onMouseDown={(e) => {
              e.preventDefault();
              selectValue(undefined);
            }}
            onClick={(e) => {
              if (e.detail === 0) selectValue(undefined);
            }}
          >
            <X size={13} aria-hidden />
          </button>
        )}
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          className="agent-combo-toggle"
          aria-label={t("set.selectModel")}
          title={t("set.selectModel")}
          onMouseDown={(e) => {
            e.preventDefault();
            if (disabled) return;
            setOpen((prev) => !prev);
            setFiltering(false);
            inputRef.current?.focus();
          }}
          onClick={(e) => {
            if (disabled || e.detail !== 0) return;
            setOpen((prev) => !prev);
            setFiltering(false);
          }}
        >
          <ChevronDown size={14} aria-hidden />
        </button>
      </div>
      {discovery === "available" && value && !selectedCatalogModel && (
        <small className="set-warn agent-combo-warn">{t("set.comboCustomWarn")}</small>
      )}
      {open &&
        menuRect &&
        createPortal(
          <div
            id={listId}
            ref={menuRef}
            role="listbox"
            aria-label={`${ariaLabel} ${t("set.suggestions")}`}
            className="agent-combo-menu"
            style={{
              top: menuRect.top,
              left: menuRect.left,
              width: menuRect.width,
            }}
          >
            {options.map((opt, idx) => (
              <div
                key={opt.key}
                id={`${listId}-${idx}`}
                role="option"
                aria-selected={opt.active}
                className={`agent-combo-option${opt.active ? " is-selected" : ""}${idx === activeIndex ? " is-focused" : ""}`}
                onMouseEnter={() => setActiveIndex(idx)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectValue(opt.val);
                }}
              >
                <span className="agent-combo-option-main">{opt.label}</span>
                {opt.sub && <span className="agent-combo-option-sub">{opt.sub}</span>}
              </div>
            ))}
            {value && !selectedCatalogModel && (
              <div
                role="option"
                aria-selected={true}
                className="agent-combo-option is-selected is-custom"
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectValue(value);
                }}
              >
                <span className="agent-combo-option-main">{t("set.customLabel", { value })}</span>
                <span className="agent-combo-option-sub">{t("set.savedCustomId")}</span>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Shared capability-driven controls for provider defaults and step overrides. */
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
  const { t } = useI18n();
  const set = (key: keyof AgentValues, next: unknown) => {
    const result = { ...value };
    if (next === undefined) delete result[key];
    else Object.assign(result, { [key]: next });
    onChange(result);
  };
  const efforts = resolveSupportedEfforts(controls, models, value.model);
  const name = (text: string) => `${label}${label ? " " : ""}${text}`;
  return (
    <div className="agent-value-fields">
      {controls?.model !== false && (
        <div className="field">
          <span>{name(t("set.field.model"))}</span>
          <ModelCombobox
            ariaLabel={name(t("set.field.model"))}
            value={value.model}
            models={models}
            discovery={discovery}
            placeholder={t("set.routingInherit")}
            onChange={(next) => set("model", next)}
          />
        </div>
      )}
      {controls?.model === false && value.model && (
        <p className="small set-warn">{t("set.modelUnsupported", { model: value.model })}</p>
      )}
      {!!efforts.length && (
        <Field label={name(t("set.field.reasoningEffort"))}>
          <select
            aria-label={name(t("set.field.reasoningEffort"))}
            value={value.reasoning_effort === null ? "__account__" : (value.reasoning_effort ?? "")}
            onChange={(event) =>
              set(
                "reasoning_effort",
                event.target.value === "__account__" ? null : event.target.value || undefined,
              )
            }
          >
            <option value="">{t("set.routingInherit")}</option>
            <option value="__account__">{t("set.modelAccount")}</option>
            {value.reasoning_effort && !efforts.includes(value.reasoning_effort) && (
              <option value={value.reasoning_effort}>
                {t("set.effortUnavailable", { effort: value.reasoning_effort })}
              </option>
            )}
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </Field>
      )}
      {controls?.max_turns && (
        <Field label={name(t("set.field.maxTurns"))}>
          <input
            aria-label={name(t("set.field.maxTurns"))}
            type="number"
            min={1}
            max={500}
            value={value.max_turns ?? ""}
            placeholder={t("set.routingInherit")}
            onChange={(event) =>
              set("max_turns", event.target.value ? Number(event.target.value) : undefined)
            }
          />
        </Field>
      )}
      <Field label={name(t("set.field.timeoutMs"))}>
        <input
          aria-label={name(t("set.field.timeoutMs"))}
          type="number"
          min={1000}
          max={86400000}
          step={1000}
          value={value.timeout_ms ?? ""}
          placeholder={t("set.routingInherit")}
          onChange={(event) =>
            set("timeout_ms", event.target.value ? Number(event.target.value) : undefined)
          }
        />
      </Field>
      {controls?.options.includes("sandbox") && (
        <Field label={name(t("set.field.sandbox"))}>
          <select
            aria-label={name(t("set.field.sandbox"))}
            value={value.options?.sandbox === undefined ? "" : String(value.options.sandbox)}
            onChange={(event) =>
              set("options", {
                ...value.options,
                sandbox: event.target.value === "" ? undefined : event.target.value === "true",
              })
            }
          >
            <option value="">{t("set.routingInherit")}</option>
            <option value="true">{t("set.sandboxEnabled")}</option>
            <option value="false">{t("set.sandboxDisabled")}</option>
          </select>
        </Field>
      )}
      {controls?.options.includes("max_concurrent") && (
        <Field label={name(t("set.field.maxConcurrent"))}>
          <input
            aria-label={name(t("set.field.maxConcurrent"))}
            type="number"
            min={1}
            max={8}
            value={value.options?.max_concurrent ?? ""}
            placeholder={t("set.routingInherit")}
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
