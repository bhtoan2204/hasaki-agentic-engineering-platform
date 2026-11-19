import { Brain } from "lucide-react";
import { useApi } from "../api.ts";
import { useI18n } from "../i18n/index.tsx";
import { ErrorBox, Loading } from "../ui.tsx";

type Overview = {
  lessons: Array<{ purpose: string; status: string; n: number; corroborated: number }>;
  observations: Array<{ kind: string; n: number; verified: number }>;
  top_negative: Array<{ key: string; claim: string; repo: string; corroborated: number }>;
  routing: {
    recommendations: Array<{
      definition_key: string;
      risk: string;
      provider: string | null;
      reason: string;
      status: string;
    }>;
  };
};

/** Outcome learning: what was observed, what was learned (non-authoritative), recurring failures, shadow routing advice. */
export function LearningInsights() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi<Overview>("/api/learning/overview");
  return (
    <div className="ins">
      <h2 style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Brain size={20} /> {t("ln.title")}
      </h2>
      <p className="small muted">{t("ln.hint")}</p>
      {loading && !data && <Loading />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && (
        <>
          <section className="card">
            <h3>{t("ln.observations")}</h3>
            {data.observations.length === 0 && <p className="small muted">{t("ln.none")}</p>}
            {data.observations.map((o) => (
              <div key={o.kind} className="small">
                <span className="mono">{o.kind}</span> · {o.n} (
                {t("ln.verified", { n: o.verified })})
              </div>
            ))}
          </section>
          <section className="card">
            <h3>{t("ln.lessons")}</h3>
            {data.lessons.length === 0 && <p className="small muted">{t("ln.none")}</p>}
            {data.lessons.map((l) => (
              <div key={`${l.purpose}:${l.status}`} className="small">
                {l.purpose} · {l.status} · {l.n} ({t("ln.corroborated", { n: l.corroborated })})
              </div>
            ))}
          </section>
          <section className="card">
            <h3>{t("ln.topNegative")}</h3>
            {data.top_negative.length === 0 && <p className="small muted">{t("ln.none")}</p>}
            {data.top_negative.map((l) => (
              <div key={l.key} className="small" style={{ margin: "4px 0" }}>
                <span className="mono">{l.repo}</span> ×{l.corroborated} — {l.claim}
              </div>
            ))}
          </section>
          <section className="card">
            <h3>{t("ln.routing")}</h3>
            {data.routing.recommendations.length === 0 && (
              <p className="small muted">{t("ln.none")}</p>
            )}
            {data.routing.recommendations.map((r) => (
              <div key={`${r.definition_key}:${r.risk}`} className="small">
                <span className="mono">{r.definition_key}</span> ({r.risk}) ·{" "}
                <b>{r.provider ?? t("ln.keepDefault")}</b> · {r.status} — {r.reason}
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
