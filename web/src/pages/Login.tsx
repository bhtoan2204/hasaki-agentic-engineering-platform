import { useEffect, useId, useState } from "react";
import { Eye, EyeOff, KeyRound, LogIn, Moon, Sun } from "lucide-react";
import { api, setAuthed, setCsrf } from "../api.ts";
import { BrandLogo } from "../brand/BrandLogo.tsx";
import { ErrorBox, Field, Loading, PageHeader } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import "./Auth.css";
export { UsersPage } from "./Users.tsx";
export type SessionUser = {
  id: number;
  username: string;
  role: "admin" | "member";
};

export function PasswordField({
  label,
  value,
  onChange,
  confirm = false,
  current = false,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  confirm?: boolean;
  current?: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-password">
        <input
          id={id}
          name={
            current ? "password" : confirm ? "confirmPassword" : "newPassword"
          }
          type={visible ? "text" : "password"}
          autoComplete={current ? "current-password" : "new-password"}
          required
          minLength={current ? undefined : 10}
          maxLength={200}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-describedby={!current ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          className="quiet icon"
          aria-label={t(visible ? "auth.hidePassword" : "auth.showPassword")}
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
          disabled={disabled}
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </div>
      {!current && (
        <small className="muted" id={`${id}-hint`}>
          {t("auth.passwordHint")}
        </small>
      )}
    </div>
  );
}

export function Login({
  onIn,
  notice,
  theme,
  onTheme,
}: {
  onIn: (user: SessionUser) => void;
  notice?: string;
  theme: "light" | "dark";
  onTheme: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<boolean | null>(null);
  const load = () => {
    setError("");
    void api<{ bootstrapRequired: boolean }>("/api/auth/status")
      .then((s) => setSetup(s.bootstrapRequired))
      .catch(() => setError("auth.unavailable"));
  };
  useEffect(load, []);
  return (
    <main className="auth-login">
      <div className="auth-login-inner">
        <div className="auth-login-tools">
          <div
            className="lang-switch"
            role="group"
            aria-label={t("lang.switch")}
          >
            {(["vi", "en"] as const).map((l) => (
              <button
                type="button"
                key={l}
                className={locale === l ? "sm" : "ghost sm"}
                aria-pressed={locale === l}
                onClick={() => setLocale(l)}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <button
            className="ghost icon"
            aria-label={t(theme === "light" ? "theme.toDark" : "theme.toLight")}
            onClick={onTheme}
          >
            {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
          </button>
        </div>
        <BrandLogo size={44} withName subtitle={t("auth.workspace")} />
        <section className="card hero">
          <PageHeader
            icon={setup ? KeyRound : LogIn}
            title={t(setup ? "auth.setupTitle" : "auth.login")}
            subtitle={t("auth.loginIntro")}
          />
          {notice && (
            <p className="auth-notice" role="status">
              {t(notice)}
            </p>
          )}
          {error && (
            <div role="alert">
              <ErrorBox
                error={t(error)}
                onRetry={setup === null ? load : undefined}
              />
            </div>
          )}
          {setup === null && !error && <Loading label={t("auth.loading")} />}
          {setup === true && (
            <div className="stack">
              <p className="muted">{t("auth.bootstrap")}</p>
              <pre className="auth-command">
                npm run admin:bootstrap -- --username &lt;username&gt;
                --claim-legacy
              </pre>
              <p className="small muted">{t("auth.bootstrapReload")}</p>
              <button className="ghost" onClick={load}>
                {t("auth.checkSetup")}
              </button>
            </div>
          )}
          {setup === false && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (busy) return;
                if (!username.trim() || !password) {
                  setError("auth.required");
                  return;
                }
                setBusy(true);
                setError("");
                try {
                  const res = await api<{ user: SessionUser; csrf: string }>(
                    "/api/auth/login",
                    { username: username.trim(), password },
                  );
                  setCsrf(res.csrf);
                  setAuthed(true);
                  onIn(res.user);
                } catch (err) {
                  setError(
                    (err as Error).message === "Invalid username or password"
                      ? "auth.invalid"
                      : "auth.loginFailed",
                  );
                } finally {
                  setBusy(false);
                }
              }}
              aria-busy={busy}
            >
              <Field label={t("auth.username")}>
                <input
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={busy}
                  autoFocus
                />
              </Field>
              <PasswordField
                label={t("auth.password")}
                current
                value={password}
                onChange={setPassword}
                disabled={busy}
              />
              <button className="auth-submit" disabled={busy} type="submit">
                {busy ? <span className="spinner" /> : <LogIn size={16} />}
                {t(busy ? "auth.signingIn" : "auth.submit")}
              </button>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
