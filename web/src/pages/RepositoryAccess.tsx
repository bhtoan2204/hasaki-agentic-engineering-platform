import { useMemo, useState } from "react";
import { History, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { api, useApi } from "../api.ts";
import { act, ErrorBox, Loading, time } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";

/** Platform access levels, cumulative: read ⊂ write ⊂ pull request (src/repos/access.ts). */
export const LEVELS = ["none", "read", "write", "pull_request"] as const;
export type Level = (typeof LEVELS)[number];

type Matrix = {
  policy: "strict" | "personal" | "trusted";
  repositories: Array<{ id: number; name: string; provider: string; projects: string[]; enabled: boolean; shared_access: Level; bitbucket: boolean }>;
  users: Array<{ id: number; username: string; role: string; active: boolean }>;
  grants: Array<{ user_id: number; repository_id: number; level: Level; granted_by: string | null; updated_at: string }>;
  checks: Array<{ user_id: number; repository_id: number; state: string; reason: string; checked_at: string; expired: boolean }>;
};

/** One user's Bitbucket verification state as a short, colour-coded label. */
export function BitbucketState({ state, reason, stale }: { state: string; reason?: string; stale?: boolean }) {
  const { t } = useI18n();
  return (
    <span className={`repo-bb is-${state}${stale ? " is-stale" : ""}`} title={reason || undefined}>
      {t(`repo.bb.${state}`)}
      {stale ? ` · ${t("repo.bb.stale")}` : ""}
    </span>
  );
}

/**
 * Admin: who may use which repository. Each cell is the platform grant; the effective permission is further limited
 * by the user's own Bitbucket permission and the repository's allowed actions. Managing access does not give the admin
 * access: admins grant themselves like anyone else.
 */
export function RepositoryAccessAdmin({ only }: { only?: string }) {
  const { t } = useI18n();
  const matrix = useApi<Matrix>("/api/repository-access");
  const audit = useApi<any[]>(`/api/repository-access/audit${only ? `?repository=${encodeURIComponent(only)}` : ""}`);
  const [q, setQ] = useState("");
  const m = matrix.data;
  const grantOf = useMemo(() => {
    const map = new Map<string, Level>();
    for (const g of m?.grants ?? []) map.set(`${g.repository_id}:${g.user_id}`, g.level);
    return map;
  }, [m]);
  const checkOf = useMemo(() => {
    const map = new Map<string, Matrix["checks"][number]>();
    for (const c of m?.checks ?? []) map.set(`${c.repository_id}:${c.user_id}`, c);
    return map;
  }, [m]);
  if (matrix.error) return <ErrorBox error={matrix.error} onRetry={matrix.reload} />;
  if (!m) return <Loading />;
  const users = m.users.filter((u) => u.active);
  const repos = m.repositories.filter((r) => (only ? r.name === only : !q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase())));
  const reload = () => (matrix.reload(), audit.reload());
  const grant = async (repo: string, userId: number, level: Level) => {
    if (await act(() => api(`/api/repositories/${encodeURIComponent(repo)}/access`, { user_id: userId, level }), t("repo.access.saved"))) reload();
  };
  const share = async (repo: string, level: Level) => {
    if (await act(() => api(`/api/repositories/${encodeURIComponent(repo)}/shared`, { level }), t("repo.access.saved"))) reload();
  };
  const revalidate = async (repo?: string) => {
    if (await act(() => (repo ? api(`/api/repositories/${encodeURIComponent(repo)}/revalidate`, {}) : api("/api/repository-access/revalidate", { all: true })), t("repo.access.revalidated"))) reload();
  };
  return (
    <div className="repo-access">
      <section className="card">
        <div className="card-head">
          <ShieldCheck size={16} color="var(--brand)" />
          <h4>{t("repo.access.title")}</h4>
          <span className="grow" />
          <button className="ghost sm" onClick={() => revalidate(only)}>
            <RefreshCw size={13} />
            {t("repo.revalidate")}
          </button>
        </div>
        <p className="muted small">{t("repo.access.note")}</p>
        <p className="small">
          <b>{t("repo.access.policy")}:</b> {t(`repo.access.policy.${m.policy}`)}
        </p>
        {!only && (
          <input
            className="repo-access-search"
            placeholder={t("repo.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label={t("repo.search")}
          />
        )}
        <div className="table-wrap">
          <table className="repo-access-table">
            <thead>
              <tr>
                <th scope="col">{t("repo.access.repo")}</th>
                <th scope="col">{t("repo.access.shared")}</th>
                {users.map((u) => (
                  <th key={u.id} scope="col">
                    <Users size={12} /> {u.username}
                    {u.role === "admin" && <span className="muted small"> · admin</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {repos.map((r) => (
                <tr key={r.id} className={r.enabled ? undefined : "is-off"}>
                  <th scope="row">
                    <a className="mono" href={`#/repositories/${r.name}?view=manage`}>
                      {r.name}
                    </a>
                    <div className="muted small">{r.projects.join(", ") || "—"}</div>
                  </th>
                  <td>
                    <select aria-label={`${r.name} ${t("repo.access.shared")}`} value={r.shared_access} onChange={(e) => share(r.name, e.target.value as Level)}>
                      {LEVELS.map((l) => (
                        <option key={l} value={l}>
                          {t(`repo.level.${l}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                  {users.map((u) => {
                    const level = grantOf.get(`${r.id}:${u.id}`) ?? "none";
                    const check = checkOf.get(`${r.id}:${u.id}`);
                    return (
                      <td key={u.id}>
                        <select aria-label={`${r.name} · ${u.username}`} value={level} onChange={(e) => grant(r.name, u.id, e.target.value as Level)}>
                          {LEVELS.map((l) => (
                            <option key={l} value={l}>
                              {t(`repo.level.${l}`)}
                            </option>
                          ))}
                        </select>
                        {r.bitbucket && m.policy !== "trusted" && (level !== "none" || r.shared_access !== "none") && (
                          <div>
                            <BitbucketState state={check?.state ?? "unknown"} reason={check?.reason} stale={check?.expired} />
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <History size={16} color="var(--brand)" />
          <h4>{t("repo.access.audit")}</h4>
        </div>
        {audit.error ? (
          <ErrorBox error={audit.error} onRetry={audit.reload} />
        ) : !audit.data?.length ? (
          <span className="muted small">{t("repo.access.noAudit")}</span>
        ) : (
          <ul className="repo-audit">
            {audit.data.slice(0, 50).map((a) => {
              const user = a.detail?.user_id != null ? m.users.find((u) => u.id === Number(a.detail.user_id))?.username : null;
              return (
                <li key={a.id}>
                  <span className="muted small">{time(a.created_at)}</span> <b>{a.actor ?? "—"}</b> · {t(`repo.audit.${a.action}`)}{" "}
                  {a.repository && <span className="mono">{a.repository}</span>}
                  {user && <> → {user}</>}
                  {a.detail?.before != null && (
                    <span className="muted">
                      {" "}
                      ({t(`repo.level.${a.detail.before}`)} → {t(`repo.level.${a.detail.after}`)})
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
