import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronUp, KeyRound, LogOut, UserRound } from "lucide-react";
import { api } from "../api.ts";
import { Badge, ErrorBox, PageHeader } from "../ui.tsx";
import { Dialog } from "../Dialog.tsx";
import { useI18n } from "../i18n/index.tsx";
import { PasswordField, type SessionUser } from "./Login.tsx";
import "./Auth.css";

export function AccountPage({
  me,
  passwordMode,
  onSignedOut,
}: {
  me: SessionUser;
  passwordMode: boolean;
  onSignedOut: (notice?: string) => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="auth-detail">
      <PageHeader
        icon={passwordMode ? KeyRound : UserRound}
        title={t(passwordMode ? "auth.passwordChange" : "auth.account")}
        subtitle={t(passwordMode ? "auth.passwordIntro" : "auth.accountIntro")}
        crumbs={
          passwordMode ? [[t("auth.account"), "#/account"], [t("auth.passwordChange")]] : undefined
        }
      />
      {passwordMode ? (
        <section className="card">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              setError("");
              if (password !== confirm) {
                setError("auth.passwordMismatch");
                return;
              }
              setBusy(true);
              try {
                await api("/api/auth/password", { password });
                onSignedOut("auth.passwordChanged");
              } catch {
                setError("auth.saveFailed");
              } finally {
                setBusy(false);
              }
            }}
            aria-busy={busy}
          >
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={me.username}
              readOnly
              hidden
            />
            <PasswordField
              label={t("auth.newPassword")}
              value={password}
              onChange={setPassword}
              disabled={busy}
            />
            <PasswordField
              label={t("auth.confirmPassword")}
              confirm
              value={confirm}
              onChange={setConfirm}
              disabled={busy}
            />
            <p className="auth-notice">{t("auth.passwordSessionHint")}</p>
            {error && (
              <div role="alert">
                <ErrorBox error={t(error)} />
              </div>
            )}
            <div className="auth-actions">
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => {
                  location.hash = "/account";
                }}
              >
                {t("common.cancel")}
              </button>
              <button disabled={busy} type="submit">
                {busy ? <span className="spinner" /> : <KeyRound size={16} />}
                {t(busy ? "auth.saving" : "auth.passwordChange")}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <>
          <section className="card">
            <div className="card-head">
              <span className="sb-avatar" aria-hidden>
                {me.username[0].toUpperCase()}
              </span>
              <h2>{me.username}</h2>
            </div>
            <div className="divider" />
            <dl>
              <dt>{t("auth.username")}</dt>
              <dd>{me.username}</dd>
              <dt>{t("auth.role")}</dt>
              <dd>
                <span className="pill">{t(`auth.role.${me.role}`)}</span>
              </dd>
              <dt>{t("auth.status")}</dt>
              <dd>
                <Badge s="COMPLETED">{t("auth.active")}</Badge>
              </dd>
            </dl>
          </section>
          <section className="card">
            <div className="card-head">
              <KeyRound size={18} />
              <h4>{t("auth.security")}</h4>
            </div>
            <p className="muted">{t("auth.passwordSessionHint")}</p>
            <a className="btn ghost" href="#/account/password">
              <KeyRound size={16} />
              {t("auth.passwordChange")}
            </a>
          </section>
        </>
      )}
    </div>
  );
}

export function AccountMenu({
  me,
  active,
  onSignedOut,
  onNavigate,
}: {
  me: SessionUser;
  active: boolean;
  onSignedOut: (notice?: string) => void;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 8 });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = trigger.current!.getBoundingClientRect();
      const r = menu.current!.getBoundingClientRect();
      setPosition({
        left: Math.max(8, Math.min(a.left, window.innerWidth - r.width - 8)),
        top: Math.max(8, Math.min(a.top - r.height - 8, window.innerHeight - r.height - 8)),
      });
    };
    place();
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  useEffect(() => {
    const on = () => setOpen(false);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return (
    <>
      <button
        ref={trigger}
        className={`sb-account${active ? " on" : ""}`}
        aria-current={active ? "page" : undefined}
        aria-label={`${t("auth.account")}: ${me.username}, ${t(`auth.role.${me.role}`)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "account-menu" : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="sb-avatar" aria-hidden>
          {me.username[0].toUpperCase()}
        </span>
        <span className="sb-ws">
          <b>{me.username}</b>
          <span>{t(`auth.role.${me.role}`)}</span>
        </span>
        <ChevronUp size={16} className="sb-account-chevron" />
      </button>
      {open &&
        createPortal(
          <div
            id="account-menu"
            ref={menu}
            className="account-menu card tight"
            role="menu"
            aria-label={t("auth.account")}
            style={position}
            onKeyDown={(e) => {
              const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
              const i = items.indexOf(document.activeElement as HTMLElement);
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                items[
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? items.length - 1
                      : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
                ]?.focus();
              }
              if (e.key === "Escape" || e.key === "Tab") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          >
            <a
              className="btn quiet"
              role="menuitem"
              href="#/account"
              onClick={() => {
                setOpen(false);
                onNavigate();
              }}
            >
              <UserRound size={16} />
              {t("auth.account")}
            </a>
            <a
              className="btn quiet"
              role="menuitem"
              href="#/account/password"
              onClick={() => {
                setOpen(false);
                onNavigate();
              }}
            >
              <KeyRound size={16} />
              {t("auth.passwordChange")}
            </a>
            <div className="divider" role="separator" />
            <button
              className="quiet account-logout"
              role="menuitem"
              onClick={() => {
                close();
                setConfirm(true);
              }}
            >
              <LogOut size={16} />
              {t("auth.logout")}
            </button>
          </div>,
          document.body,
        )}
      {confirm && (
        <Dialog
          title={t("auth.logout")}
          onClose={() => {
            setConfirm(false);
            setError(false);
          }}
          busy={busy}
        >
          <p>{t("auth.logoutConfirm", { name: me.username })}</p>
          {error && (
            <div role="alert">
              <ErrorBox error={t("auth.logoutFailed")} />
            </div>
          )}
          <div className="auth-actions">
            <button className="ghost" disabled={busy} onClick={() => setConfirm(false)} autoFocus>
              {t("common.cancel")}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(false);
                try {
                  await api("/api/auth/logout", {});
                  onSignedOut("auth.loggedOut");
                } catch {
                  setError(true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy && <span className="spinner" />}
              {t("auth.logout")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
