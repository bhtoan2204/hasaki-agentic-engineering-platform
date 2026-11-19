import { useState } from "react";
import { Gauge } from "lucide-react";
import { api, useApi } from "../api.ts";
import { useI18n } from "../i18n/index.tsx";
import { act, EmptyState, ErrorBox, Loading } from "../ui.tsx";

type Rate = { numerator: number; denominator: number; value: number | null };
type View = {
  days: number;
  metrics: {
    sample: {
      episodes: number;
      started: number;
      eligible_autonomous: number;
      cohorts: Record<string, number>;
    };
    human_free_completion: Rate;
    policy_compliance: Rate;
    interventions: {
      total: number;
      avoidable: number;
      mandatory: number;
      operator_safety: number;
      per_started_episode: number | null;
    };
    first_pass_pr_acceptance: Rate & { pending_or_unknown: number };
    false_completion: Rate;
    regression_escape: Rate & { censored: number };
    efficiency: {
      wall_ms_p50: number | null;
      wall_ms_p95: number | null;
      tokens_total: number | null;
      cost_usd_known: number | null;
      cost_coverage: number | null;
      runs_per_episode: number | null;
    };
  };
};

const rate = (r: Rate) =>
  r.value == null ? "—" : `${(r.value * 100).toFixed(0)}% (${r.numerator}/${r.denominator})`;

/** Autonomy from production records: every rate with its denominator; unknowns are shown, never folded into success. */
export function AutonomyInsights() {
  const { t } = useI18n();
  const [days, setDays] = useState(30);
  const { data, error, loading, reload } = useApi<View>(`/api/eval/autonomy?days=${days}`, [days]);
  const m = data?.metrics;
  return (
    <div className="ins">
      <h2 style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Gauge size={20} /> {t("ae.title")}
      </h2>
      <p className="small muted">{t("ae.hint")}</p>
      <select
        value={days}
        onChange={(e) => setDays(Number(e.target.value))}
        aria-label={t("ae.window")}
      >
        {[7, 30, 90, 180].map((d) => (
          <option key={d} value={d}>
            {t("ae.days", { n: d })}
          </option>
        ))}
      </select>
      {loading && !data && <Loading />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {m && m.sample.episodes === 0 && <EmptyState icon={Gauge} title={t("ae.empty")} />}
      {!data && !loading && !error && <EmptyState icon={Gauge} title={t("ae.empty")} />}
      {m && m.sample.episodes > 0 && (
        <section className="card small">
          <div>
            {t("ae.sample", { n: m.sample.episodes, eligible: m.sample.eligible_autonomous })}
          </div>
          <div>
            {t("ae.cohorts")}:{" "}
            {Object.entries(m.sample.cohorts)
              .filter(([, n]) => n)
              .map(([k, n]) => `${k} ${n}`)
              .join(", ")}
          </div>
          <div>
            {t("ae.humanFree")}: <b>{rate(m.human_free_completion)}</b>
          </div>
          <div>
            {t("ae.interventions")}: {m.interventions.total} (
            {t("ae.avoidable", { n: m.interventions.avoidable })},{" "}
            {t("ae.mandatory", { n: m.interventions.mandatory })}) ·{" "}
            {m.interventions.per_started_episode?.toFixed(2) ?? "—"}/{t("ae.episode")}
          </div>
          <div>
            {t("ae.firstPass")}: {rate(m.first_pass_pr_acceptance)} ·{" "}
            {t("ae.pending", { n: m.first_pass_pr_acceptance.pending_or_unknown })}
          </div>
          <div>
            {t("ae.falseCompletion")}: {rate(m.false_completion)}
          </div>
          <div>
            {t("ae.regression")}: {rate(m.regression_escape)} ·{" "}
            {t("ae.censored", { n: m.regression_escape.censored })}
          </div>
          <div>
            {t("ae.efficiency")}: p50{" "}
            {m.efficiency.wall_ms_p50 != null ? Math.round(m.efficiency.wall_ms_p50 / 60000) : "—"}{" "}
            min · p95{" "}
            {m.efficiency.wall_ms_p95 != null ? Math.round(m.efficiency.wall_ms_p95 / 60000) : "—"}{" "}
            min · tokens {m.efficiency.tokens_total ?? "—"} · {t("ae.cost")}{" "}
            {m.efficiency.cost_usd_known != null
              ? `$${m.efficiency.cost_usd_known.toFixed(2)}`
              : t("ae.unknown")}{" "}
            ({t("ae.coverage", { n: Math.round((m.efficiency.cost_coverage ?? 0) * 100) })})
          </div>
          <p className="muted">{t("ae.small")}</p>
        </section>
      )}
      <StoredReports />
    </div>
  );
}

type StoredReport = {
  id: number;
  suite: string;
  commit_sha: string | null;
  manifest_hash: string | null;
  visibility: "private" | "team";
  owner: string;
  mine: boolean;
  source: string;
  results: number;
  gate: { passed?: boolean } | null;
  created_at: string;
};

/** Autonomy reports stored centrally (CLI or import): own and team-shared, from any device. */
function StoredReports() {
  const { t } = useI18n();
  const reports = useApi<StoredReport[]>("/api/evaluation-reports?kind=autonomy");
  const share = async (r: StoredReport) => {
    if (
      await act(() =>
        api(`/api/evaluation-reports/${r.id}/visibility`, {
          visibility: r.visibility === "team" ? "private" : "team",
        }),
      )
    )
      void reports.reloadFresh();
  };
  return (
    <section className="card">
      <h3>{t("ae.stored")}</h3>
      <p className="muted">{t("ae.storedHint")}</p>
      {reports.error && <ErrorBox error={reports.error} />}
      {!reports.data && !reports.error && <Loading />}
      {reports.data?.length === 0 && <p className="muted">{t("ae.storedEmpty")}</p>}
      {!!reports.data?.length && (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>{t("ae.suite")}</th>
              <th>commit</th>
              <th>{t("ae.gate")}</th>
              <th>{t("ae.owner")}</th>
              <th>{t("ae.visibility")}</th>
            </tr>
          </thead>
          <tbody>
            {reports.data.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td title={r.manifest_hash ?? ""}>{r.suite}</td>
                <td>{r.commit_sha ?? "—"}</td>
                <td>{r.gate?.passed == null ? "—" : r.gate.passed ? "PASS" : "FAIL"}</td>
                <td>
                  {r.owner} · {r.source}
                </td>
                <td>
                  {t(r.visibility === "team" ? "ae.team" : "ae.private")}
                  {r.mine && (
                    <button className="ghost xs" onClick={() => void share(r)}>
                      {t(r.visibility === "team" ? "ae.unshare" : "ae.share")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
