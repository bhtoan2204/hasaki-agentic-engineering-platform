import { useState } from "react";
import { api, useApi } from "../../api.ts";
import { act, Empty, ErrorBox, Field, SkeletonRows } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { Panel, fmt } from "../analytics/shared.tsx";

type ProviderPlan = Array<{ provider: string }>;
type Recommendation = {
  id: number;
  version: string;
  evidence_hash: string;
  category: string;
  decision: {
    status: string;
    plan: ProviderPlan;
    confidence: string;
    samples?: number;
    distinct_tasks?: number;
    success_rate: number | null;
    median_ms: number | null;
    cost_availability?: string;
    reason: string;
    evidence?: Array<{
      plan?: ProviderPlan;
      samples: number;
      tasks: number;
      evaluation_ids?: number[];
    }>;
  };
};
type OptimizationPolicy = {
  id: number;
  recommendation_id: number;
  category: string;
  step_type: string;
  enabled: boolean;
};
export function EvaluationRecommendations() {
  const { t } = useI18n();
  const rows = useApi<Recommendation[]>("/api/agent-recommendations"),
    policies = useApi<OptimizationPolicy[]>("/api/agent-optimization");
  const [category, setCategory] = useState(""),
    [cohort, setCohort] = useState(""),
    [active, setActive] = useState<Recommendation | null>(null),
    [consent, setConsent] = useState(false),
    [cost, setCost] = useState(false);
  const generate = () =>
    act(async () => {
      const range = new URLSearchParams(location.hash.split("?")[1] ?? "");
      const r = await api<Recommendation>("/api/agent-recommendations", {
        ...Object.fromEntries(
          ["from", "to", "timezone"].filter((k) => range.has(k)).map((k) => [k, range.get(k)]),
        ),
        category,
        ...(cohort ? { cohort } : {}),
      });
      setActive(r);
      await rows.reload();
    });
  const show = active ?? rows.data?.[0],
    d = show?.decision;
  return (
    <Panel title={t("an.eval.recommendations")} hint={t("an.eval.recommendationsHint")}>
      <div className="grid2">
        <Field label={t("an.eval.taskCategory")}>
          <input
            aria-label={t("an.eval.recCategoryAria")}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder={t("an.eval.exactCategory")}
          />
        </Field>
        <Field label={t("an.eval.controlCohortOpt")}>
          <input value={cohort} onChange={(e) => setCohort(e.target.value)} />
        </Field>
      </div>
      <button type="button" className="sm" disabled={!category.trim()} onClick={generate}>
        {t("an.eval.generate")}
      </button>
      {rows.error && <ErrorBox error={rows.error} onRetry={rows.reload} />}
      {policies.error && <ErrorBox error={policies.error} onRetry={policies.reload} />}
      {rows.loading && !rows.data && <SkeletonRows rows={2} />}
      {!rows.loading && !show && <Empty>{t("an.eval.insufficientEvidence")}</Empty>}
      {show && d && (
        <>
          <h4>
            {d.status === "RECOMMENDED"
              ? `${t("an.eval.recommended")}: ${d.plan.map((p) => p.provider).join(" → ")}`
              : t("an.eval.insufficientOrUnavailable")}
          </h4>
          <p className="small">
            {t("an.eval.confidence")}: {d.confidence} · {t("an.eval.samples")}: {d.samples ?? 0} ·{" "}
            {t("an.eval.distinctTasks")}: {d.distinct_tasks ?? 0} · {t("an.eval.verifiedSuccess")}:{" "}
            {fmt(d.success_rate, "pct")} · {t("an.eval.median")}: {fmt(d.median_ms, "ms")} ·{" "}
            {t("an.eval.costAvailability")}: {d.cost_availability ?? "Unknown"}
          </p>
          <p className="muted small">{d.reason}</p>
          <details>
            <summary>{t("an.eval.supportingEvidenceVer")}</summary>
            <p className="mono small">
              {show.version} · {show.evidence_hash}
            </p>
            {d.evidence?.map((e, i) => (
              <p key={i} className="small">
                {e.plan?.map((p) => p.provider).join(" → ")} · {e.samples} / {e.tasks} ·{" "}
                {e.evaluation_ids?.map((id: number) => (
                  <a
                    style={{ marginRight: 8 }}
                    key={id}
                    href={`/api/evaluation-runs/${id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    evaluation #{id}
                  </a>
                ))}
              </p>
            ))}
            <a href={`/api/agent-recommendations/${show.id}`} target="_blank" rel="noreferrer">
              {t("an.eval.immutableSnapshot")}
            </a>
          </details>
          {d.status === "RECOMMENDED" && d.plan?.length === 1 && (
            <div style={{ marginTop: 12 }}>
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                {t("an.eval.optInFutureCoding")}
              </label>
              <label>
                <input type="checkbox" checked={cost} onChange={(e) => setCost(e.target.checked)} />
                {t("an.eval.allowDefaultUnknownCost")}
              </label>
              <button
                type="button"
                className="sm"
                onClick={() =>
                  act(async () => {
                    await api("/api/agent-optimization", {
                      recommendation_id: show.id,
                      category: show.category,
                      step_type: "coding_agent",
                      enabled: consent,
                      allow_unknown_cost: cost,
                    });
                    await policies.reload();
                  })
                }
              >
                {t("an.eval.saveFuturePolicy")}
              </button>
            </div>
          )}
        </>
      )}
      {policies.data?.map((p) => (
        <p key={p.id} className="small">
          {p.category} · {p.enabled ? t("an.eval.enabled") : t("an.eval.disabled")}{" "}
          <button
            type="button"
            className="quiet xs"
            onClick={() =>
              act(async () => {
                await api("/api/agent-optimization", {
                  recommendation_id: p.recommendation_id,
                  category: p.category,
                  step_type: p.step_type,
                  enabled: false,
                });
                await policies.reload();
              })
            }
          >
            {t("an.eval.disable")}
          </button>
        </p>
      ))}
    </Panel>
  );
}
