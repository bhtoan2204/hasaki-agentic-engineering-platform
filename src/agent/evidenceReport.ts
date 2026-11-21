/**
 * Evidence-driven investigation report (M4, stages E–F): a deterministic step after an evidence-role agent step. It
 * re-verifies every claim against platform records at report time (code locations at their commit, this run's tool
 * calls and CodeAct records, `observed` assertions on recorded results), re-applies the evidence normalization (which
 * only lowers certainty), and reports what is a platform-verified fact, what is a hypothesis, what is missing, and
 * whether verification passed. No model is involved, nothing is changed anywhere: remediation that needs code changes
 * goes through the approved coding workflow.
 */
import {
  isVerifiedFact,
  normalizeInvestigationOutput,
  type Claim,
  type RootCauseAssessment,
} from "./evidence.ts";
import { withProvenance, type ProvenanceEnv } from "./provenance.ts";

const list = (v: unknown, n = 20) =>
  (Array.isArray(v) ? v : [])
    .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
    .filter(Boolean)
    .slice(0, n)
    .map((x) => x.slice(0, 400));

export interface EvidenceReport {
  incident_summary: string;
  verification: {
    status: "passed" | "incomplete" | "failed";
    claims_checked: number;
    platform_verified: number;
    failures: Array<{ claim_id?: string; reason: string }>;
  };
  confirmed_facts: Array<
    Pick<Claim, "id" | "claim" | "classification" | "source_ref"> & {
      verifies: string | null;
      location?: string;
    }
  >;
  root_cause: RootCauseAssessment | null;
  root_cause_candidates: string[];
  hypotheses: Array<Pick<Claim, "id" | "claim">>;
  unverified_claims: Array<{ id: string; claim: string; reason: string | null }>;
  contradicted_claims: Array<{ id: string; claim: string; reason: string | null }>;
  evidence_refs: string[];
  source_locations: string[];
  missing_evidence: string[];
  next_steps: string[];
  production_changes: "none";
}

export async function buildEvidenceReport(
  source: Record<string, unknown>,
  env: ProvenanceEnv,
): Promise<EvidenceReport> {
  const claims = (await withProvenance(source.claims ?? [], env)) as unknown[];
  const n = normalizeInvestigationOutput("root_cause", { ...source, claims });
  const failures: EvidenceReport["verification"]["failures"] = [];
  const platform = (c: Claim) => c.provenance?.status === "VERIFIED_BY_PLATFORM";
  for (const c of n.claims)
    if (c.verification_status === "contradicted")
      failures.push({
        claim_id: c.id,
        reason: c.provenance?.reason ?? c.notes?.join("; ") ?? "contradicted",
      });
  // Conclusions the platform had to lower (here or when the agent step's output was normalized) were unsupported.
  const lowered = [
    ...list(record(source.evidence_validation).notes, 40),
    ...n.evidence_validation.notes,
  ].filter((note) =>
    /^root cause \w+ → |CONFIRMED_ROOT_CAUSE → /.test(note.replace(/^C?\w+: /, "")),
  );
  for (const reason of new Set(lowered))
    failures.push({ reason: `unsupported conclusion lowered: ${reason}` });
  const confirmed = n.claims.filter((c) => isVerifiedFact(c) && platform(c));
  const location = (c: Claim) =>
    c.file_path && c.repository
      ? `${c.repository}:${c.file_path}${c.line_range ? `:${c.line_range}` : ""}@${String(c.commit ?? "").slice(0, 12)}`
      : undefined;
  const missing = n.missing_evidence;
  return {
    incident_summary: String(source.summary ?? source.root_cause ?? "").slice(0, 1200),
    verification: {
      status: failures.length ? "failed" : missing.length ? "incomplete" : "passed",
      claims_checked: n.claims.length,
      platform_verified: n.claims.filter(platform).length,
      failures: failures.slice(0, 30),
    },
    confirmed_facts: confirmed.map((c) => ({
      id: c.id,
      claim: c.claim,
      classification: c.classification,
      source_ref: c.source_ref,
      verifies: c.provenance?.verifies ?? null,
      ...(location(c) ? { location: location(c) } : {}),
    })),
    root_cause: n.root_cause_assessment ?? null,
    root_cause_candidates: list(source.hypotheses),
    hypotheses: n.claims
      .filter((c) => c.classification === "HYPOTHESIS" || c.classification === "ASSUMPTION")
      .map((c) => ({ id: c.id, claim: c.claim })),
    unverified_claims: n.claims
      .filter(
        (c) =>
          !platform(c) &&
          c.verification_status !== "contradicted" &&
          c.classification !== "HYPOTHESIS",
      )
      .map((c) => ({ id: c.id, claim: c.claim, reason: c.provenance?.reason ?? null })),
    contradicted_claims: n.claims
      .filter((c) => c.verification_status === "contradicted")
      .map((c) => ({ id: c.id, claim: c.claim, reason: c.provenance?.reason ?? null })),
    evidence_refs: [...new Set(confirmed.map((c) => c.source_ref).filter((r): r is string => !!r))],
    source_locations: [...new Set(confirmed.map(location).filter((l): l is string => !!l))],
    missing_evidence: missing,
    next_steps: list(source.next_steps),
    production_changes: "none",
  };
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
