import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import { STATUS_COLORS } from "./api.ts";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// Agent output may contain raw HTML: render it as text, never as markup.
marked.use({ renderer: { html: (t: any) => escapeHtml(t.text ?? t.raw ?? "") }, gfm: true, breaks: true });

export const time = (t?: string | null) =>
  t ? new Date(t).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "2-digit" }) : "";
export const ago = (t?: string | null) => {
  if (!t) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
export const dur = (ms?: number | null) => (ms == null ? "" : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`);

export function Badge({ s, children }: { s: string; children?: ReactNode }) {
  return (
    <span className="badge" style={{ color: STATUS_COLORS[s] ?? "var(--muted)" }}>
      {children ?? s}
    </span>
  );
}

export function Markdown({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: marked.parse(text ?? "", { async: false }) as string }} />;
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="ghost xs"
      title="Copy to clipboard"
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? "✓ Copied" : label}
    </button>
  );
}

/** Collapsible JSON tree; strings that look like Markdown can be toggled to rendered view. */
export function Json({ value, depth = 0, name }: { value: unknown; depth?: number; name?: string }) {
  const [open, setOpen] = useState(depth < 2);
  const label = name !== undefined ? <span className="jk">{name}: </span> : null;
  if (value === null || value === undefined) return <div className="jl">{label}<span className="jn">null</span></div>;
  if (typeof value !== "object") {
    const s = String(value);
    if (typeof value === "string" && (s.length > 120 || s.includes("\n")))
      return (
        <div className="jl">
          {label}
          <div className="jstr">{s}</div>
        </div>
      );
    return <div className="jl">{label}<span className={typeof value === "string" ? "js" : "jv"}>{typeof value === "string" ? `"${s}"` : s}</span></div>;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as object);
  return (
    <div className="jl">
      <span className="jt" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {label}
        <span className="muted">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </span>
      {open && <div className="jc">{entries.map(([k, v]) => <Json key={k} name={k} value={v} depth={depth + 1} />)}</div>}
    </div>
  );
}

/** JSON block with tree/raw toggle and copy. */
export function JsonBlock({ value, title }: { value: unknown; title?: string }) {
  const [raw, setRaw] = useState(false);
  const text = JSON.stringify(value, null, 2) ?? "null";
  return (
    <div className="jsonblock">
      <div className="row tight">
        {title && <b className="small">{title}</b>}
        <span className="grow" />
        <button className="ghost xs" onClick={() => setRaw(!raw)}>{raw ? "Tree" : "Raw"}</button>
        <Copy text={text} />
      </div>
      {raw ? <pre>{text}</pre> : <div className="jtree"><Json value={value} /></div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Loading() {
  return <div className="empty"><span className="spinner" /> Đang tải…</div>;
}
export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="errorbox">
      <b>Lỗi:</b> <span style={{ whiteSpace: "pre-wrap" }}>{error}</span>
      {onRetry && <button className="ghost xs" onClick={onRetry} style={{ marginLeft: 8 }}>Thử lại</button>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<[T, ReactNode]>; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs">
      {tabs.map(([k, label]) => (
        <button key={k} className={k === value ? "tab on" : "tab"} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
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

/** Wrap an async UI action: disables nothing by itself, reports errors as toasts, returns success. */
export async function act<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (ok) toast(ok, "ok");
    return r;
  } catch (e) {
    toast((e as Error).message);
    return undefined;
  }
}

export const navigate = (hash: string) => (location.hash = hash);
