import { AlertTriangle } from "lucide-react";
import { useI18n } from "./i18n/index.tsx";

/**
 * Evidence-gated investigation, at a glance: root-cause status, fix risk, evidence counts and (on approval) the exact
 * scope being approved. Qualitative states only — no artificial numeric confidence.
 */
const TONE: Record<string, string> = {
  CONFIRMED: "var(--st-ok)",
  PROBABLE: "var(--st-wait)",
  UNCONFIRMED: "var(--st-wait)",
  INSUFFICIENT_EVIDENCE: "var(--st-err)",
  LOW: "var(--st-ok)",
  MEDIUM: "var(--st-wait)",
  HIGH: "var(--st-err)",
};

interface Claim {
  classification?: string;
  verification_status?: string;
}

interface GateState {
  satisfied: boolean;
  missing?: string[];
}

interface Scope {
  proposal_hash?: string;
  summary?: string;
  changes?: Array<{ repo: string; files?: string[]; description: string }>;
  risk?: string | null;
  root_cause_status?: string | null;
  gate?: GateState | null;
  assumptions?: string[];
  approved_by?: string;
  risk_acknowledged?: boolean;
}

interface EvidenceOutput {
  root_cause_assessment?: { status?: string; explanation?: string };
  fix_assessment?: { risk?: string; risk_reasons?: string[] };
  claims?: Claim[];
  missing_evidence?: string[];
  evidence_gate?: GateState;
  approved_scope?: Scope;
}

export const hasEvidence = (o: unknown): o is EvidenceOutput =>
  !!o &&
  typeof o === "object" &&
  (("root_cause_assessment" in o && !!o.root_cause_assessment) ||
    ("fix_assessment" in o && !!o.fix_assessment) ||
    ("claims" in o && Array.isArray(o.claims)) ||
    ("approved_scope" in o && !!o.approved_scope));

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginTop: 4 }}
    >
      <span className="small muted" style={{ minWidth: 110 }}>
        {label}
      </span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

export function EvidenceSummary({ output, scope }: { output?: EvidenceOutput; scope?: Scope }) {
  const { t } = useI18n();
  const o: EvidenceOutput = output ?? {};
  const claims: Claim[] = Array.isArray(o.claims) ? o.claims : [];
  const verified = claims.filter(
    (c) =>
      ["OBSERVED_FACT", "CODE_FACT"].includes(c.classification ?? "") &&
      c.verification_status === "verified",
  ).length;
  const contradicted = claims.filter((c) => c.verification_status === "contradicted").length;
  const missing: string[] = Array.isArray(o.missing_evidence) ? o.missing_evidence : [];
  const root = o.root_cause_assessment?.status ?? scope?.root_cause_status;
  const risk = o.fix_assessment?.risk ?? scope?.risk;
  const gate = o.evidence_gate ?? scope?.gate;
  const s = scope ?? o.approved_scope;
  const badge = (v: string, label: string) => (
    <span className="badge" style={{ color: TONE[v] ?? "var(--ink-2)" }}>
      {label}
    </span>
  );
  return (
    <section className="card tight" style={{ marginTop: 8 }} aria-label={t("ev.title")}>
      <div className="card-head" style={{ marginBottom: 6 }}>
        <h4>{t("ev.title")}</h4>
      </div>
      {root && (
        <Row label={t("ev.rootCause")}>
          {badge(root, t(`ev.rc.${root}`))}
          {o.root_cause_assessment?.explanation && (
            <span className="small muted"> {o.root_cause_assessment.explanation}</span>
          )}
        </Row>
      )}
      {risk && (
        <Row label={t("ev.fixRisk")}>
          {badge(risk, t(`ev.risk.${risk}`))}
          {(o.fix_assessment?.risk_reasons?.length ?? 0) > 0 && (
            <span className="small muted"> {o.fix_assessment?.risk_reasons?.join(" · ")}</span>
          )}
        </Row>
      )}
      {(claims.length > 0 || missing.length > 0) && (
        <Row label={t("ev.evidence")}>
          <span className="small">
            {t("ev.counts", {
              verified,
              unverified: claims.length - verified - contradicted,
              missing: missing.length,
            })}
            {contradicted > 0 && ` · ${t("ev.contradicted", { n: contradicted })}`}
          </span>
        </Row>
      )}
      {missing.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary className="small">{t("ev.missingList", { n: missing.length })}</summary>
          <ul className="small" style={{ margin: "4px 0 0 18px" }}>
            {missing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </details>
      )}
      {gate && !gate.satisfied && (
        <div
          className="small"
          role="alert"
          style={{ color: "var(--st-err)", marginTop: 6, display: "flex", gap: 6 }}
        >
          <AlertTriangle size={14} style={{ flex: "none", marginTop: 2 }} />
          <span>
            {t("ev.gateUnmet")}: {(gate.missing ?? []).join("; ")}
          </span>
        </div>
      )}
      {s?.changes && s.changes.length > 0 && (
        <details open={!!scope} style={{ marginTop: 6 }}>
          <summary className="small">
            {scope ? t("ev.scopeToApprove") : t("ev.approvedScope")}{" "}
            <span className="mono muted">#{s.proposal_hash}</span>
          </summary>
          {s.summary && (
            <p className="small" style={{ margin: "4px 0" }}>
              {s.summary}
            </p>
          )}
          <ul className="small" style={{ margin: "4px 0 0 18px" }}>
            {s.changes.map((c, i) => (
              <li key={i}>
                <b className="mono">{c.repo}</b>{" "}
                {(c.files?.length ?? 0) > 0 && (
                  <span className="mono muted">{c.files?.join(", ")}</span>
                )}{" "}
                — {c.description}
              </li>
            ))}
          </ul>
          {(s.assumptions?.length ?? 0) > 0 && (
            <p className="small muted" style={{ margin: "4px 0 0" }}>
              {t("ev.assumptions")}: {s.assumptions?.join(" · ")}
            </p>
          )}
          {s.approved_by && (
            <p className="small muted" style={{ margin: "4px 0 0" }}>
              {t("ev.approvedBy", { by: s.approved_by })}
              {s.risk_acknowledged ? ` · ${t("ev.ackRecorded")}` : ""}
            </p>
          )}
        </details>
      )}
    </section>
  );
}
