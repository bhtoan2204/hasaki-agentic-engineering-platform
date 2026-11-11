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
  repositories: Array<{
    id: number;
    name: string;
    provider: string;
    projects: string[];
    enabled: boolean;
    shared_access: Level;
    bitbucket: boolean;
    host_policy?: "strict" | "personal" | "trusted";
  }>;
  users: Array<{ id: number; username: string; role: string; active: boolean }>;
  grants: Array<{
    user_id: number;
    repository_id: number;
    level: Level;
    granted_by: string | null;
    updated_at: string;
  }>;
  checks: Array<{
    user_id: number;
    repository_id: number;
    state: string;
    reason: string;
    checked_at: string;
    expired: boolean;
  }>;
};

const RANK: Record<Level, number> = { none: 0, read: 1, write: 2, pull_request: 3 };
const PERMS = ["read", "write", "pull_request"] as const;

/**
 * Independent Read / Write / PR checkboxes. They imply each other like Git hosting does (a pull request needs a pushed
 * branch, a push needs read): ticking one ticks the ones below it, unticking one unticks the ones above it.
 */
function AccessChecks({
  level,
  label,
  onChange,
}: {
  level: Level;
  label: string;
  onChange: (l: Level) => void;
}) {
  const { t } = useI18n();
  return (
    <span
      className="repo-perm-checks"
      role="group"
      aria-label={label}
      title={t("repo.access.impliesHint")}
    >
      {PERMS.map((p) => {
        const on = RANK[level] >= RANK[p];
        return (
          <label key={p} className={`repo-perm-check is-${p}${on ? " is-on" : ""}`}>
            <input
              type="checkbox"
              checked={on}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? RANK[p] > RANK[level]
                      ? p
                      : level
                    : (LEVELS[RANK[p] - 1] as Level),
                )
              }
            />
            {t(`repo.perm.${p}`)}
          </label>
        );
      })}
    </span>
  );
}

/** One user's Bitbucket verification state as a short, colour-coded label. */
export function BitbucketState({
  state,
  reason,
  stale,
  host,
}: {
  state: string;
  reason?: string;
  stale?: boolean;
  host?: string;
}) {
  const { t } = useI18n();
  const key =
    host === "github" && (state === "denied" || state === "not_applicable")
      ? `repo.gh.${state}`
      : `repo.bb.${state}`;
  return (
    <span className={`repo-bb is-${state}${stale ? " is-stale" : ""}`} title={reason || undefined}>
      {t(key)}
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
  const audit = useApi<any[]>(
    `/api/repository-access/audit${only ? `?repository=${encodeURIComponent(only)}` : ""}`,
  );
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
  const repos = m.repositories.filter((r) =>
    only ? r.name === only : !q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const reload = () => (matrix.reload(), audit.reload());
  const grant = async (repo: string, userId: number, level: Level) => {
    if (
      await act(
        () =>
          api(`/api/repositories/${encodeURIComponent(repo)}/access`, { user_id: userId, level }),
        t("repo.access.saved"),
      )
    )
      reload();
  };
  const bulk = async (user: { id: number; username: string }, level: Level) => {
    if (
      !confirm(
        t(level === "none" ? "repo.access.allNoneConfirm" : "repo.access.allFullConfirm", {
          user: user.username,
          n: m.repositories.length,
        }),
      )
    )
      return;
    if (
      await act(
        () => api("/api/repository-access/bulk", { user_id: user.id, level }),
        t("repo.access.saved"),
      )
    )
      reload();
  };
  const share = async (repo: string, level: Level) => {
    if (
      await act(
        () => api(`/api/repositories/${encodeURIComponent(repo)}/shared`, { level }),
        t("repo.access.saved"),
      )
    )
      reload();
  };
  const revalidate = async (repo?: string) => {
    if (
      await act(
        () =>
          repo
            ? api(`/api/repositories/${encodeURIComponent(repo)}/revalidate`, {})
            : api("/api/repository-access/revalidate", { all: true }),
        t("repo.access.revalidated"),
      )
    )
      reload();
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
        <p className="muted small">{t("repo.access.impliesHint")}</p>
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
                    {!only && (
                      <div className="repo-access-bulk">
                        <button className="ghost sm" onClick={() => bulk(u, "pull_request")}>
                          {t("repo.access.allFull")}
                        </button>
                        <button className="ghost sm" onClick={() => bulk(u, "none")}>
                          {t("repo.access.allNone")}
                        </button>
                      </div>
                    )}
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
                    <AccessChecks
                      level={r.shared_access}
                      label={`${r.name} · ${t("repo.access.shared")}`}
                      onChange={(l) => share(r.name, l)}
                    />
                  </td>
                  {users.map((u) => {
                    const level = grantOf.get(`${r.id}:${u.id}`) ?? "none";
                    const check = checkOf.get(`${r.id}:${u.id}`);
                    return (
                      <td key={u.id}>
                        <AccessChecks
                          level={level}
                          label={`${r.name} · ${u.username}`}
                          onChange={(l) => grant(r.name, u.id, l)}
                        />
                        {r.bitbucket &&
                          (r.host_policy ?? m.policy) !== "trusted" &&
                          (level !== "none" || r.shared_access !== "none") && (
                            <div>
                              <BitbucketState
                                host={r.provider}
                                state={check?.state ?? "unknown"}
                                reason={check?.reason}
                                stale={check?.expired}
                              />
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
              const user =
                a.detail?.user_id != null
                  ? m.users.find((u) => u.id === Number(a.detail.user_id))?.username
                  : null;
              return (
                <li key={a.id}>
                  <span className="muted small">{time(a.created_at)}</span> <b>{a.actor ?? "—"}</b>{" "}
                  · {t(`repo.audit.${a.action}`)}{" "}
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
