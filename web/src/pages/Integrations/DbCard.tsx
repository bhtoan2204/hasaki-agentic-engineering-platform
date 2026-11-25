import { RefreshCw } from "lucide-react";
import { ago } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { type DbInfo, type DbState } from "./shared.tsx";

export function DbCard({
  d,
  state,
  isAdmin,
  onTest,
  onEdit,
  onDelete,
}: {
  d: DbInfo;
  state: DbState;
  isAdmin: boolean;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const when = (v?: string | null) => (v ? t("common.ago", { when: ago(v) }) : "");
  const scope = [d.project, ...(d.repositories ?? [])].filter(Boolean);
  return (
    <article className={`ig-db-card is-${state}`}>
      <header className="ig-db-card-head">
        <span className="ig-db-light" aria-hidden />
        <b className="mono">{d.key}</b>
        <span className="ig-env">{String(d.environment ?? "qc").toUpperCase()}</span>
        <span className="grow" />
        <span className={`ig-db-state is-${state}`}>{t(`ig.db.state.${state}`)}</span>
      </header>
      <div className="ig-db-target mono small">
        {d.database_name}
        {isAdmin && d.host && (
          <span className="muted">
            {" "}
            · {d.username}@{d.host}:{d.port}
          </span>
        )}
      </div>
      {scope.length > 0 && (
        <div className="ig-db-chips">
          {scope.map((x) => (
            <span key={x} className="ig-db-chip">
              {x}
            </span>
          ))}
        </div>
      )}
      {d.description && <div className="small">{d.description}</div>}
      <div className="ig-db-meta small muted">
        {d.last_status === "ok" && d.last_version && (
          <span>{d.last_version.replace(/-MariaDB.*$/, " MariaDB")}</span>
        )}
        {d.last_status === "ok" && d.last_latency_ms != null && (
          <span>{t("ig.db.latency", { ms: d.last_latency_ms })}</span>
        )}
        {d.last_checked_at ? (
          <span>{t("ig.db.checkedAgo", { when: when(d.last_checked_at) })}</span>
        ) : (
          <span>{t("ig.db.neverChecked")}</span>
        )}
        <span>
          {d.last_used_at
            ? t("ig.db.usedAgo", { when: when(d.last_used_at) })
            : t("ig.db.neverUsed")}
        </span>
      </div>
      {state === "failed" && (
        <div className="ig-db-error small">
          <b>{t(`ig.db.kind.${d.last_error_kind ?? "unknown"}`)}</b>
          <div>{t(`ig.db.hint.${d.last_error_kind ?? "unknown"}`)}</div>
          {isAdmin && d.last_error && <code>{d.last_error}</code>}
        </div>
      )}
      {isAdmin && d.has_password === false && state !== "failed" && (
        <div className="ig-db-warn small">{t("ig.db.noPassword")}</div>
      )}
      {isAdmin && d.last_can_write && <div className="ig-db-warn small">{t("ig.db.canWrite")}</div>}
      {isAdmin && (
        <footer className="ig-db-actions">
          <button
            type="button"
            className="sm ghost"
            onClick={onTest}
            disabled={state === "checking"}
          >
            <RefreshCw size={13} className={state === "checking" ? "ig-spin" : undefined} />{" "}
            {t("ig.db.test")}
          </button>
          <button type="button" className="sm ghost" onClick={onEdit}>
            {t("common.edit")}
          </button>
          <button type="button" className="sm ghost" onClick={onDelete}>
            {t("common.delete")}
          </button>
        </footer>
      )}
    </article>
  );
}
