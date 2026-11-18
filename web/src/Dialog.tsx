import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useI18n } from "./i18n/index.tsx";
import "./Dialog.css";

/** Native modal provides top-layer rendering, focus containment and inert background. */
export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  className,
  role = "dialog",
  labelledBy,
  describedBy,
  initialFocusSelector,
  hideHeader = false,
}: {
  title?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  className?: string;
  role?: "dialog" | "alertdialog";
  labelledBy?: string;
  describedBy?: string;
  /** CSS selector for the element that should receive initial focus. */
  initialFocusSelector?: string;
  /** When true, skip the built-in title bar (caller provides its own chrome). */
  hideHeader?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const generatedId = useId();
  const titleId = labelledBy ?? generatedId;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    const focusTarget = initialFocusSelector
      ? dialog.querySelector<HTMLElement>(initialFocusSelector)
      : null;
    (focusTarget ?? dialog).focus();
    return () => {
      dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [initialFocusSelector]);

  return createPortal(
    <dialog
      ref={ref}
      tabIndex={-1}
      role={role}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const items = [
          ...e.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ),
        ].filter((el) => el.getClientRects().length > 0);
        const first = items[0],
          last = items[items.length - 1];
        if (!first) {
          e.preventDefault();
          e.currentTarget.focus();
        } else if (
          e.shiftKey &&
          (document.activeElement === first || document.activeElement === e.currentTarget)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      className={`dialog ui-dialog${className ? ` ${className}` : ""}`}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      aria-busy={busy}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      {!hideHeader && title ? (
        <div className="card-head">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="quiet icon"
            onClick={onClose}
            disabled={busy}
            aria-label={t("common.close")}
          >
            <X size={18} />
          </button>
        </div>
      ) : null}
      {children}
    </dialog>,
    document.body,
  );
}
