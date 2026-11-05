import { useState } from "react";
import { KeyRound, Plus, Power, Users } from "lucide-react";
import { api, useApi } from "../api.ts";
import { Badge, EmptyState, ErrorBox, Field, PageHeader, SearchInput, SkeletonRows, toast } from "../ui.tsx";
import { Dialog } from "../Dialog.tsx";
import { PasswordField, type SessionUser } from "./Login.tsx";
import { useI18n } from "../i18n/index.tsx";
import "./Auth.css";

type User = SessionUser & { active: boolean };
type Action = { kind: "create" } | { kind: "reset" | "status"; user: User };
export function UsersPage({ me, onSignedOut }: { me: SessionUser; onSignedOut: (notice?: string) => void }) {
  const { t } = useI18n();
  const { data, loading, error, reload } = useApi<User[]>("/api/users");
  const [query, setQuery] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const shown = (data ?? []).filter((u) => u.username.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="auth-users">
    <PageHeader icon={Users} title={t("auth.users")} subtitle={t("auth.usersIntro")} actions={<button disabled={loading || !!error} onClick={() => setAction({ kind: "create" })}><Plus size={16} />{t("auth.create")}</button>} />
    {error ? <ErrorBox error={t("auth.loadFailed")} onRetry={reload} /> : loading ? <SkeletonRows /> : <>
      <div className="toolbar"><SearchInput value={query} onChange={setQuery} placeholder={t("auth.searchUsers")} /><span className="muted small">{t("auth.userCount", { n: data?.length ?? 0 })}</span></div>
      {!shown.length ? <EmptyState icon={Users} title={t(query ? "auth.noMatches" : "auth.noUsers")} action={query ? <button className="ghost" onClick={() => setQuery("")}>{t("auth.clearSearch")}</button> : undefined} /> :
        <div className="table-wrap"><table><thead><tr><th scope="col">{t("auth.username")}</th><th scope="col">{t("auth.role")}</th><th scope="col">{t("auth.status")}</th><th scope="col">{t("auth.actions")}</th></tr></thead><tbody>
          {shown.map((u) => <tr key={u.id}><td><div className="auth-user"><span className="sb-avatar" aria-hidden>{u.username[0].toUpperCase()}</span><b>{u.username}</b>{u.id === me.id && <span className="muted small">{t("auth.you")}</span>}</div></td>
            <td><span className="pill">{t(`auth.role.${u.role}`)}</span></td><td><Badge s={u.active ? "COMPLETED" : "CANCELED"}>{t(u.active ? "auth.active" : "auth.inactive")}</Badge></td>
            <td><div className="row tight"><button className="ghost sm" onClick={() => setAction({ kind: "reset", user: u })} aria-label={`${t("auth.reset")} · ${u.username}`}><KeyRound size={14} />{t("auth.reset")}</button>
              <button className="ghost sm" disabled={u.id === me.id} data-tip={u.id === me.id ? t("auth.noSelfDeactivate") : undefined} onClick={() => setAction({ kind: "status", user: u })} aria-label={`${t(u.active ? "auth.deactivate" : "auth.activate")} · ${u.username}`}><Power size={14} />{t(u.active ? "auth.deactivate" : "auth.activate")}</button></div></td></tr>)}
        </tbody></table></div>}
    </>}
    {action && <UserDialog action={action} onClose={() => setAction(null)} onDone={async () => {
      if (action.kind === "reset" && action.user.id === me.id) { onSignedOut("auth.passwordChanged"); return; }
      setAction(null); toast(t("auth.saved"), "ok"); await reload();
    }} />}
  </div>;
}

function UserDialog({ action, onClose, onDone }: { action: Action; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [role, setRole] = useState("member");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const title = t(action.kind === "create" ? "auth.create" : action.kind === "reset" ? "auth.reset" : action.user.active ? "auth.deactivate" : "auth.activate");
  return <Dialog title={title} onClose={onClose} busy={busy}>
    <form onSubmit={async (e) => {
      e.preventDefault(); if (busy) return;
      setError("");
      if (action.kind !== "status" && password !== confirm) { setError("auth.passwordMismatch"); return; }
      setBusy(true);
      try {
        if (action.kind === "create") await api("/api/users", { username: username.trim().toLowerCase(), password, role });
        else if (action.kind === "reset") await api(`/api/users/${action.user.id}/password`, { password });
        else await api(`/api/users/${action.user.id}/active`, { active: !action.user.active });
        await onDone();
      } catch (err) { setError((err as Error).message.includes("users_username_key") ? "auth.usernameTaken" : "auth.saveFailed"); }
      finally { setBusy(false); }
    }}>
      {action.kind === "create" ? <>
        <Field label={t("auth.username")} hint={t("auth.usernameHint")}><input name="username" autoComplete="off" autoCapitalize="none" spellCheck={false} required pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{2,31}" maxLength={32} value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} autoFocus /></Field>
        <Field label={t("auth.role")}><select value={role} onChange={(e) => setRole(e.target.value)} disabled={busy}><option value="member">{t("auth.role.member")}</option><option value="admin">{t("auth.role.admin")}</option></select></Field>
        <p className="muted small">{t(role === "admin" ? "auth.adminHint" : "auth.memberHint")}</p>
      </> : <><p><b>{action.user.username}</b> · {t(`auth.role.${action.user.role}`)}</p>
        <p className="muted">{t(action.kind === "reset" ? "auth.resetWarning" : action.user.active ? "auth.deactivateWarning" : "auth.activateWarning")}</p></>}
      {action.kind !== "status" && <><PasswordField label={t("auth.newPassword")} value={password} onChange={setPassword} disabled={busy} /><PasswordField label={t("auth.confirmPassword")} confirm value={confirm} onChange={setConfirm} disabled={busy} /></>}
      {error && <div role="alert"><ErrorBox error={t(error)} /></div>}
      <div className="auth-actions"><button type="button" className="ghost" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
        <button type="submit" className={action.kind === "status" && action.user.active ? "danger" : ""} disabled={busy}>{busy && <span className="spinner" />}{busy ? t("auth.saving") : title}</button></div>
    </form>
  </Dialog>;
}
