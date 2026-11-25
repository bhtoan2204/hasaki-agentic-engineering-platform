import { useState } from "react";
import { HardDrive, RefreshCw } from "lucide-react";
import { api, useApi } from "../api.ts";
import { act, ago } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";

interface WorkspaceRepo {
  name: string;
  provider: string;
  remote: boolean;
  workspace: string;
  index: {
    status: string;
    error: string | null;
    updated_at: string;
    delegated: boolean;
    requested_by: string | null;
  } | null;
}

/**
 * The platform workspace of this instance: checkouts the platform keeps for itself (never your own working copies), with
 * their index state. Sync clones or fetches with your own Git account, then indexes as you.
 */
export function RepositoryWorkspace() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { data, reload } = useApi<{
    background: { enabled: boolean };
    repositories: WorkspaceRepo[];
  }>(open ? "/api/workspace/repositories" : null);
  const [busy, setBusy] = useState<string | null>(null);
  const sync = async (r: WorkspaceRepo) => {
    setBusy(r.name);
    try {
      const path = r.workspace === "ready" ? "refresh" : "prepare";
      if (
        await act(
          () => api(`/api/repositories/${r.name}/${path}`, {}),
          t("repo.ws.synced", { name: r.name }),
        )
      )
        void reload();
    } finally {
      setBusy(null);
    }
  };
  return (
    <details
      className="repo-ws"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>
        <HardDrive size={15} /> {t("repo.ws.title")}
      </summary>
      <p className="small muted">
        {t("repo.ws.explain")}{" "}
        {data && !data.background.enabled && (
          <a href="#/integrations">{t("repo.ws.enableBackground")}</a>
        )}
      </p>
      {data && (
        <div className="table-wrap">
          <table className="repo-ws-table">
            <thead>
              <tr>
                <th>{t("repo.ws.repo")}</th>
                <th>{t("repo.ws.checkout")}</th>
                <th>{t("repo.ws.index")}</th>
                <th>
                  <span className="sr-only">{t("auth.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.repositories.map((r) => (
                <tr key={r.name}>
                  <td className="mono">{r.name}</td>
                  <td>{t(`repo.ws.state.${r.workspace}`)}</td>
                  <td className="small">
                    {r.index ? (
                      <>
                        {r.index.status} · {ago(r.index.updated_at)}
                        {r.index.requested_by
                          ? ` · ${r.index.delegated ? t("repo.ws.via", { user: r.index.requested_by }) : r.index.requested_by}`
                          : ""}
                        {r.index.error && <div className="err">{r.index.error}</div>}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {r.remote && (
                      <button
                        type="button"
                        className="ghost sm"
                        disabled={busy === r.name}
                        onClick={() => void sync(r)}
                      >
                        <RefreshCw size={13} /> {t("repo.ws.sync")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
