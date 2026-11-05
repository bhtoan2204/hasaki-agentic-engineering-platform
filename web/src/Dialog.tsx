import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useI18n } from "./i18n/index.tsx";
import "./Dialog.css";

/** Native modal provides top-layer rendering, focus containment and inert background. */
export function Dialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<dialog ref={ref} tabIndex={-1} onKeyDown={(e) => {
    if (e.key !== "Tab") return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter((el) => el.getClientRects().length > 0);
    const first = items[0], last = items[items.length - 1];
    if (!first) { e.preventDefault(); e.currentTarget.focus(); }
    else if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }} className="dialog ui-dialog" aria-labelledby={id} aria-busy={busy}
    onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
    onClick={(e) => { if (e.target === e.currentTarget && !busy) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <div className="card-head"><h2 id={id}>{title}</h2><button type="button" className="quiet icon" onClick={onClose} disabled={busy} aria-label={t("common.close")}><X size={18} /></button></div>
    {children}
  </dialog>, document.body);
}
