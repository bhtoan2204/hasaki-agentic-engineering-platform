import { ShieldCheck } from "lucide-react";
import { useApi } from "../api.ts";
import { useI18n } from "../i18n/index.tsx";
import { Empty, ErrorBox, SkeletonRows } from "../ui.tsx";

type Check = { required: string[]; provided: string[]; unmet: string[] };
type View = {
  mode: "off" | "enforce";
  enforced: boolean;
  unattended_allowed: boolean;
  runtime: { available: boolean; cgroup: string; problems: string[]; checked_at: string };
  providers: Array<{ provider: string; coding: Check; analysis: Check }>;
};

/** Admin diagnostics for agent OS isolation: runtime probe, mode and each provider's effective guarantees. */
export function AgentIsolation() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi<View>("/api/admin/isolation");
  const verdict = (c: Check) => (c.unmet.length ? `✗ ${c.unmet.join(", ")}` : "✓");
  return (
    <section id="set-isolation" className="card set-section">
      <header className="set-section-head">
        <ShieldCheck size={18} aria-hidden />
        <h3>{t("iso.title")}</h3>
      </header>
      {loading && !data && <SkeletonRows rows={4} />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && (
        <>
          <p className="small">
            <b>{t("iso.mode")}:</b> {data.mode} ·{" "}
            {data.enforced
              ? t("iso.enforced")
              : data.mode === "enforce"
                ? t("iso.unavailable")
                : t("iso.legacy")}
          </p>
          <p className="small muted">
            {data.unattended_allowed ? t("iso.unattendedOn") : t("iso.unattendedOff")}
          </p>
          {data.runtime.problems.length > 0 && (
            <ul className="small err">
              {data.runtime.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="table-wrap">
            <table className="small">
              <thead>
                <tr>
                  <th>{t("iso.provider")}</th>
                  <th>{t("iso.coding")}</th>
                  <th>{t("iso.analysis")}</th>
                </tr>
              </thead>
              <tbody>
                {data.providers.length === 0 ? (
                  <tr>
                    <td colSpan={3}>
                      <Empty>{t("common.none")}</Empty>
                    </td>
                  </tr>
                ) : (
                  data.providers.map((p) => (
                    <tr key={p.provider}>
                      <td className="mono">{p.provider}</td>
                      <td>{verdict(p.coding)}</td>
                      <td>{verdict(p.analysis)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            {t("iso.checked", { at: new Date(data.runtime.checked_at).toLocaleString() })}
          </p>
        </>
      )}
    </section>
  );
}
