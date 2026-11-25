import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Info, ShieldAlert } from "lucide-react";
import { Dialog } from "../Dialog.tsx";
import { useI18n } from "../i18n/index.tsx";
import { dismissActiveDialog, resolveDialog, subscribeDialog } from "./service.ts";
import type { DialogRequest, DialogVariant } from "./types.ts";
import "./DialogHost.css";

function VariantIcon({ variant }: { variant: DialogVariant }) {
  if (variant === "destructive") return <ShieldAlert size={20} aria-hidden />;
  if (variant === "warning") return <AlertTriangle size={20} aria-hidden />;
  return <Info size={20} aria-hidden />;
}

export function DialogHost() {
  const { t } = useI18n();
  const [req, setReq] = useState<DialogRequest | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const descId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsub = subscribeDialog(setReq);
    return () => {
      unsub();
      // Settle pending promises on host unmount so callers never hang.
      dismissActiveDialog();
    };
  }, []);

  useEffect(() => {
    if (!req) return;
    setBusy(false);
    setError(null);
    if (req.kind === "prompt") setInput(req.options.defaultValue ?? "");
    else setInput("");
  }, [req]);

  if (!req) return null;
  const active = req;

  const variant: DialogVariant =
    active.kind === "confirm"
      ? (active.options.variant ?? "default")
      : active.kind === "alert"
        ? (active.options.variant ?? "info")
        : "default";

  const preferCancel =
    active.kind === "confirm" && (active.options.preferCancelFocus ?? variant === "destructive");

  const title = active.options.title;
  const description = active.options.description;

  const confirmLabel =
    active.kind === "confirm"
      ? (active.options.confirmLabel ?? t("common.confirm"))
      : active.kind === "alert"
        ? (active.options.confirmLabel ?? t("common.ok"))
        : (active.options.confirmLabel ?? t("common.confirm"));

  const cancelLabel =
    active.kind === "alert" ? null : (active.options.cancelLabel ?? t("common.cancel"));

  function closeCancel() {
    if (busy) return;
    if (active.kind === "confirm") resolveDialog(false);
    else if (active.kind === "prompt") resolveDialog(null);
    else resolveDialog(undefined);
  }

  function onConfirm() {
    if (busy) return;
    if (active.kind === "prompt") {
      const value = input;
      const required = active.options.required !== false;
      if (required && !value.trim()) {
        setError(t("dialog.required"));
        inputRef.current?.focus();
        return;
      }
      const custom = active.options.validate?.(value);
      if (custom) {
        setError(custom);
        inputRef.current?.focus();
        return;
      }
      setBusy(true);
      resolveDialog(value);
      return;
    }
    setBusy(true);
    if (active.kind === "confirm") resolveDialog(true);
    else resolveDialog(undefined);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    onConfirm();
  }

  return (
    <Dialog
      hideHeader
      busy={busy}
      onClose={closeCancel}
      labelledBy={titleId}
      describedBy={description ? descId : undefined}
      initialFocusSelector={
        active.kind === "prompt"
          ? ".app-dialog-input"
          : preferCancel
            ? ".app-dialog-cancel"
            : ".app-dialog-confirm"
      }
      className={`app-dialog app-dialog-${variant}`}
      role={active.kind === "alert" || variant === "destructive" ? "alertdialog" : "dialog"}
    >
      <form className="app-dialog-body" onSubmit={onSubmit}>
        <div className="app-dialog-head">
          <span className={`app-dialog-icon app-dialog-icon-${variant}`} aria-hidden>
            <VariantIcon variant={variant} />
          </span>
          <div className="app-dialog-copy">
            <h2 id={titleId} className="app-dialog-title">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="app-dialog-desc">
                {description}
              </p>
            ) : null}
          </div>
        </div>

        {active.kind === "prompt" ? (
          <label className="app-dialog-field">
            {active.options.label ? <span>{active.options.label}</span> : null}
            <input
              ref={inputRef}
              className="app-dialog-input"
              value={input}
              placeholder={active.options.placeholder}
              onChange={(e) => {
                setInput(e.target.value);
                if (error) setError(null);
              }}
              aria-invalid={!!error}
              aria-describedby={error ? `${titleId}-err` : undefined}
              disabled={busy}
              autoComplete="off"
            />
            {error ? (
              <span id={`${titleId}-err`} className="app-dialog-error" role="alert">
                {error}
              </span>
            ) : null}
          </label>
        ) : null}

        <div className="app-dialog-actions">
          {cancelLabel ? (
            <button
              type="button"
              className="quiet app-dialog-cancel"
              onClick={closeCancel}
              disabled={busy}
            >
              {cancelLabel}
            </button>
          ) : null}
          <button
            type="submit"
            className={`app-dialog-confirm${variant === "destructive" ? " danger" : ""}`}
            disabled={busy}
          >
            {busy ? t("common.working") : confirmLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
