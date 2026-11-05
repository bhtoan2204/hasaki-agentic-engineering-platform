import { useEffect, useState } from "react";
import { api, setAuthed, setCsrf } from "../api.ts";
import { useI18n } from "../i18n/index.tsx";

export type SessionUser = { id: number; username: string; role: "admin" | "member" };

export function Login({ onIn }: { onIn: (user: SessionUser) => void }) {
  const { t, locale, setLocale } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<boolean | null>(null);
  useEffect(() => { api<{ bootstrapRequired: boolean }>("/api/auth/status").then((s) => setSetup(s.bootstrapRequired)).catch((e) => setError(e.message)); }, []);
  return (
    <main className="page" style={{ maxWidth: 420, margin: "10vh auto" }}>
      <button type="button" onClick={() => setLocale(locale === "vi" ? "en" : "vi")}>{locale === "vi" ? "EN" : "VI"}</button>
      <h1>{t("auth.login")}</h1>
      {setup && <div role="status"><p>{t("auth.bootstrap")}</p><code>npm run admin:bootstrap -- --username &lt;username&gt; --claim-legacy</code><p>{t("auth.bootstrapReload")}</p></div>}
      <form hidden={setup === true}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const res = await api<{ user: SessionUser; csrf: string }>("/api/auth/login", { username, password });
            setCsrf(res.csrf);
            setAuthed(true);
            onIn(res.user);
          } catch (err) {
            setError((err as Error).message || t("auth.invalid"));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {t("auth.username")}
          <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          {t("auth.password")}
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="err">{error}</p>}
        <button className="primary" disabled={busy || setup === null} type="submit">{t("auth.submit")}</button>
      </form>
    </main>
  );
}

export function UsersPage() {
  const { t } = useI18n();
  const [users, setUsers] = useState<Array<SessionUser & { active: boolean }>>([]);
  const [form, setForm] = useState({ username: "", password: "", role: "member" });
  const [error, setError] = useState("");
  const load = () => api<Array<SessionUser & { active: boolean }>>("/api/users").then(setUsers).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);
  return (
    <div>
      <h1>{t("auth.users")}</h1>
      {error && <p className="err">{error}</p>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await api("/api/users", form);
            setForm({ username: "", password: "", role: "member" });
            await load();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <input placeholder={t("auth.username")} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        <input type="password" placeholder={t("auth.password")} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="member">{t("auth.role.member")}</option>
          <option value="admin">{t("auth.role.admin")}</option>
        </select>
        <button className="primary" type="submit">{t("auth.create")}</button>
      </form>
      <ul>
        {users.map((u) => (
          <li key={u.id}>
            <b>{u.username}</b> {u.role === "admin" ? t("auth.role.admin") : t("auth.role.member")} {u.active ? "" : "·"}
            <button type="button" className="ghost sm" onClick={async () => { const password = prompt(t("auth.newPassword")); if (password) await api(`/api/users/${u.id}/password`, { password }); }}>{t("auth.reset")}</button>
            <button type="button" className="ghost sm" onClick={async () => { await api(`/api/users/${u.id}/active`, { active: !u.active }); await load(); }}>{u.active ? t("auth.deactivate") : t("auth.activate")}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
