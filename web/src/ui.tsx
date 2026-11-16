import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { Search, X, LoaderCircle, type LucideIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import { LIVE_STATUSES, STATUS_COLORS } from "./api.ts";
import { BrandLogo } from "./brand/BrandLogo.tsx";
import { uiLocale, useI18n } from "./i18n/index.tsx";

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
// Agent output may contain raw HTML: render it as text, never as markup.
marked.use({
  renderer: { html: (t: any) => escapeHtml(t.text ?? t.raw ?? "") },
  gfm: true,
  breaks: true,
});

export const time = (t?: string | null) =>
  t
    ? new Date(t).toLocaleString(uiLocale() === "vi" ? "vi-VN" : "en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        day: "2-digit",
        month: "2-digit",
      })
    : "";
export const ago = (t?: string | null) => {
  if (!t) return "";
  const s = Math.max(
    0,
    Math.round((Date.now() - new Date(t).getTime()) / 1000),
  );
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m`
      : s < 86400
        ? `${Math.floor(s / 3600)}h`
        : `${Math.floor(s / 86400)}d`;
};
export const dur = (ms?: number | null) =>
  ms == null
    ? ""
    : ms < 1000
      ? `${ms}ms`
      : ms < 60000
        ? `${(ms / 1000).toFixed(1)}s`
        : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;

/** Status badge (dot + label). `children` overrides the label; `label` shows the translated name instead of the code. */
export function Badge({
  s,
  children,
  label,
}: {
  s: string;
  children?: ReactNode;
  label?: boolean;
}) {
  const { status } = useI18n();
  const name = status(s);
  const known = name !== `status.${s}`;
  return (
    <span
      className={`badge${LIVE_STATUSES.has(s) ? " is-live" : ""}`}
      style={{ color: STATUS_COLORS[s] ?? "var(--muted)" }}
      title={known ? `${name} (${s})` : s}
    >
      {children ?? (label ? (known ? name : s) : s)}
    </span>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div
      className="md"
      dangerouslySetInnerHTML={{
        __html: marked.parse(text ?? "", { async: false }) as string,
      }}
    />
  );
}

export function Copy({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <button
      className="ghost xs"
      title={t("common.copy")}
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? `✓ ${t("common.copied")}` : (label ?? t("common.copy"))}
    </button>
  );
}

/** Collapsible JSON tree; strings that look like Markdown can be toggled to rendered view. */
export function Json({
  value,
  depth = 0,
  name,
}: {
  value: unknown;
  depth?: number;
  name?: string;
}) {
  const [open, setOpen] = useState(depth < 2);
  const label =
    name !== undefined ? <span className="jk">{name}: </span> : null;
  if (value === null || value === undefined)
    return (
      <div className="jl">
        {label}
        <span className="jn">null</span>
      </div>
    );
  if (typeof value !== "object") {
    const s = String(value);
    if (typeof value === "string" && (s.length > 120 || s.includes("\n")))
      return (
        <div className="jl">
          {label}
          <div className="jstr">{s}</div>
        </div>
      );
    return (
      <div className="jl">
        {label}
        <span className={typeof value === "string" ? "js" : "jv"}>
          {typeof value === "string" ? `"${s}"` : s}
        </span>
      </div>
    );
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as object);
  return (
    <div className="jl">
      <span className="jt" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {label}
        <span className="muted">
          {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      </span>
      {open && (
        <div className="jc">
          {entries.map(([k, v]) => (
            <Json key={k} name={k} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/** JSON block with tree/raw toggle and copy. */
export function JsonBlock({
  value,
  title,
}: {
  value: unknown;
  title?: string;
}) {
  const { t } = useI18n();
  const [raw, setRaw] = useState(false);
  const text = JSON.stringify(value, null, 2) ?? "null";
  return (
    <div className="jsonblock">
      <div className="row tight">
        {title && <b className="small">{title}</b>}
        <span className="grow" />
        <button className="ghost xs" onClick={() => setRaw(!raw)}>
          {raw ? t("common.tree") : t("common.raw")}
        </button>
        <Copy text={text} />
      </div>
      {raw ? (
        <pre>{text}</pre>
      ) : (
        <div className="jtree">
          <Json value={value} />
        </div>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
/** Friendly empty state with a soft brand illustration. */
export function EmptyState({
  icon: I,
  title,
  children,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-art">
        {I ? (
          <I size={34} strokeWidth={1.6} color="var(--brand)" />
        ) : (
          <BrandLogo size={52} />
        )}
      </div>
      <div className="empty-title">{title}</div>
      {children && <div style={{ maxWidth: 460 }}>{children}</div>}
      {action}
    </div>
  );
}
export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="loading-screen" role="status">
      <BrandLogo size={44} />
      <span>
        <span className="spinner" /> {label ?? t("common.loading")}
      </span>
    </div>
  );
}
export function UpdatingBar({ active }: { active?: boolean }) {
  if (!active) return null;
  return (
    <div className="updating-bar" role="progressbar" aria-label="Updating" />
  );
}
export function Skeleton({
  h = 14,
  w = "100%",
  r,
}: {
  h?: number;
  w?: number | string;
  r?: number;
}) {
  return (
    <div
      className="skeleton"
      style={{ height: h, width: w, borderRadius: r }}
      aria-hidden
    />
  );
}
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} h={42} r={12} />
      ))}
    </div>
  );
}

/** Contextual page header: breadcrumbs, icon, title, subtitle, actions. */
export function PageHeader({
  icon: I,
  title,
  subtitle,
  crumbs,
  actions,
  children,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  subtitle?: ReactNode;
  crumbs?: Array<[string, string?]>;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="ph-main">
        {crumbs && crumbs.length > 0 && (
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map(([label, href], i) => (
              <span key={i} className="row tight" style={{ gap: 6 }}>
                {i > 0 && <span aria-hidden>/</span>}
                {href ? <a href={href}>{label}</a> : <span>{label}</span>}
              </span>
            ))}
          </nav>
        )}
        <h1 className="ph-title">
          {I && (
            <span className="ph-icon">
              <I size={21} strokeWidth={2} />
            </span>
          )}
          <span>{title}</span>
        </h1>
        {subtitle && <div className="ph-sub">{subtitle}</div>}
        {children}
      </div>
      {actions && <div className="ph-actions">{actions}</div>}
    </header>
  );
}

export type Tone = "brand" | "run" | "wait" | "ok" | "err";
export function StatCard({
  icon: I,
  label,
  value,
  hint,
  tone = "brand",
  onClick,
}: {
  icon?: LucideIcon;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  onClick?: () => void;
}) {
  return (
    <div
      className={`stat tone-${tone}`}
      onClick={onClick}
      style={onClick ? { cursor: "pointer" } : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value ?? "—"}</div>
      {hint && <div className="stat-hint">{hint}</div>}
      {I && (
        <div className="stat-icon">
          <I size={18} strokeWidth={2} />
        </div>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<[T, ReactNode]>;
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([k, l]) => (
        <button
          key={k}
          type="button"
          className={k === value ? "on" : ""}
          aria-pressed={k === value}
          onClick={() => onChange(k)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export type ControlSize = "xs" | "sm" | "md" | "lg";
export function Button({
  variant = "primary",
  size = "md",
  icon,
  loading = false,
  children,
  className = "",
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  size?: ControlSize;
  icon?: ReactNode;
  loading?: boolean;
}) {
  const appearance = {
    primary: "",
    secondary: "ghost",
    quiet: "quiet",
    danger: "danger",
  }[variant];
  return (
    <button
      type="button"
      {...props}
      className={`ui-button ${appearance} ${size} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <LoaderCircle className="button-spinner" size={16} aria-hidden="true" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}

/** Labels and controls share a baseline without toolbar-specific offsets. */
export function FilterField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="filter-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function FilterToolbar({
  children,
  secondary,
  className = "",
}: {
  children: ReactNode;
  secondary?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`filter-toolbar ${className}`}>
      <div className="filter-toolbar-primary">{children}</div>
      {secondary && <div className="filter-toolbar-secondary">{secondary}</div>}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  width = 260,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: number | string;
}) {
  const { t } = useI18n();
  const text = placeholder ?? t("common.search");
  return (
    <label className="search" style={{ maxWidth: width }}>
      <Search size={15} />
      <input
        type="search"
        name="workspace-search"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        value={value}
        placeholder={text}
        onChange={(e) => onChange(e.target.value)}
        aria-label={text}
      />
    </label>
  );
}

/** Side drawer with scrim; Escape closes. */
export function Drawer({
  title,
  onClose,
  children,
  width,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key !== "Tab") return;
      const items = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ) ?? []),
      ].filter((el) => el.getClientRects().length > 0);
      const first = items[0],
        last = items.at(-1);
      if (!first) {
        e.preventDefault();
        ref.current?.focus();
      } else if (
        e.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === ref.current)
      ) {
        e.preventDefault();
        last?.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last ||
          !ref.current?.contains(document.activeElement))
      ) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <aside
        ref={ref}
        tabIndex={-1}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={width ? { width: `min(${width}px, 100vw)` } : undefined}
      >
        <div className="drawer-head">
          <h4 id={titleId}>{title}</h4>
          <button
            type="button"
            className="quiet icon"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>,
    document.body,
  );
}

export function ErrorBox({
  error,
  onRetry,
}: {
  error: string;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="errorbox">
      <b>{t("common.error")}:</b>{" "}
      <span style={{ whiteSpace: "pre-wrap" }}>{error}</span>
      {onRetry && (
        <button
          className="ghost xs"
          onClick={onRetry}
          style={{ marginLeft: 8 }}
        >
          {t("common.retry")}
        </button>
      )}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<[T, ReactNode]>;
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="tabs" role="group">
      {tabs.map(([k, label]) => (
        <button
          key={k}
          type="button"
          aria-pressed={k === value}
          className={k === value ? "tab on" : "tab"}
          onClick={() => onChange(k)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

// ---------------------------------------------------------------- toasts

let toastHost: HTMLDivElement | null = null;
export function toast(msg: string, kind: "ok" | "err" = "err") {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toasts";
    document.body.appendChild(toastHost);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  toastHost.appendChild(el);
  createRoot(el).render(<span style={{ whiteSpace: "pre-wrap" }}>{msg}</span>);
  setTimeout(() => el.remove(), kind === "ok" ? 2500 : 7000);
}

/**
 * The button the user just activated (mouse, touch or keyboard all dispatch `click`). Remembered for the rest of the
 * current task only, so `act()` called from that click handler — also after a synchronous confirm() — knows its trigger.
 */
let trigger: HTMLElement | null = null;
if (typeof document !== "undefined")
  document.addEventListener(
    "click",
    (e) => {
      const el = (e.target as Element | null)?.closest?.(
        "button, [role='button']",
      ) as HTMLElement | null;
      if (!el) return;
      trigger = el;
      setTimeout(() => {
        if (trigger === el) trigger = null;
      }, 0);
    },
    true,
  );

/**
 * Wrap an async UI action: reports errors as toasts and returns success. The button that started it is disabled and
 * shows a spinner until the request settles, so a slow call (remote database) reads as "working", never as a missed
 * click, and a second click cannot send the action twice. A click on a button that is still busy is ignored.
 */
export async function act<T>(
  fn: () => Promise<T>,
  ok?: string,
): Promise<T | undefined> {
  const el = trigger;
  trigger = null;
  if (el?.getAttribute("aria-busy") === "true") return undefined;
  const wasDisabled = el instanceof HTMLButtonElement ? el.disabled : false;
  if (el) {
    el.setAttribute("aria-busy", "true");
    el.classList.add("is-busy");
    if (el instanceof HTMLButtonElement) el.disabled = true;
  }
  try {
    const r = await fn();
    if (ok) toast(ok, "ok");
    return r;
  } catch (e) {
    toast((e as Error).message);
    return undefined;
  } finally {
    if (el) {
      el.removeAttribute("aria-busy");
      el.classList.remove("is-busy");
      if (el instanceof HTMLButtonElement && el.isConnected)
        el.disabled = wasDisabled;
    }
  }
}

export const navigate = (hash: string) => (location.hash = hash);
