import { Badge } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { AttemptPayload } from "./shared.tsx";

/** Independent verification verdict (fresh-session verifier; enforced before the PR). */
export function VerdictCard({ v }: { v: AttemptPayload }) {
  const { t } = useI18n();
  const tone =
    v.verdict === "PASS" ? "COMPLETED" : v.verdict === "FAIL" ? "FAILED" : "WAITING_INPUT";
  const findings = v.findings ?? [];
  return (
    <div
      className="card"
      style={{
        borderLeft: `4px solid var(${v.verdict === "PASS" ? "--st-ok" : v.verdict === "FAIL" ? "--st-err" : "--st-wait"})`,
      }}
    >
      <div className="card-head">
        <h4>{t("si.independent")}</h4>
        <Badge s={tone}>{v.verdict}</Badge>
      </div>
      <div className="small muted">
        {t("si.fresh", {
          heads:
            Object.entries(v.verified_heads ?? {})
              .map(([r, sha]) => `${r}@${String(sha).slice(0, 9)}`)
              .join(", ") || "—",
        })}
      </div>
      {v.summary && <p className="small">{v.summary}</p>}
      {v.blocked_reason && (
        <p className="small" style={{ color: "var(--st-wait)" }}>
          {t("si.blockedReason", { reason: v.blocked_reason })}
        </p>
      )}
      {findings.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th>{t("si.severity")}</th>
                <th>{t("si.location")}</th>
                <th>{t("si.finding")}</th>
                <th>{t("si.evidence")}</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f, i) => (
                <tr key={i}>
                  <td>
                    <Badge
                      s={
                        f.severity === "high"
                          ? "FAILED"
                          : f.severity === "medium"
                            ? "WAITING"
                            : "PENDING"
                      }
                    >
                      {f.severity}
                    </Badge>
                  </td>
                  <td className="mono small">
                    {f.file}
                    {f.line ? `:${f.line}` : ""}
                  </td>
                  <td className="small">{f.explanation}</td>
                  <td className="small muted">{f.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
