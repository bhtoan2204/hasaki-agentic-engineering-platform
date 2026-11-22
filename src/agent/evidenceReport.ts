/**
 * Evidence-driven investigation report (M4, stages E–F): a deterministic step after an evidence-role agent step. It
 * re-verifies every claim against platform records at report time (code locations at their commit, this run's tool
 * calls and CodeAct records, `observed` assertions on recorded results), re-applies the evidence normalization (which
 * only lowers certainty), and reports what is a platform-verified fact, what is a hypothesis, what is missing, and
 * whether verification passed. No model is involved, nothing is changed anywhere: remediation that needs code changes
 * goes through the approved coding workflow.
 *
 * Verdict. `failed`: a claim is contradicted or cites a record this run does not have, a conclusion had to be lowered,
 * or a CONFIRMED root cause rests on no platform-verified fact. `incomplete`: the investigation's objectives (declared
 * by the workflow definition — never by the agent) are not met by platform-verified evidence: no verified fact, a
 * required source family without one (an outage, a truncated or stale record counts as missing), a root cause that is
 * not CONFIRMED, or a confirmation without an independently checked observation from every required source. The
 * agent saying nothing is missing proves nothing. `passed` only when every objective is met.
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

/** What the investigation must establish; set by the workflow step config (trusted), defaults below. */
export interface EvidenceObjectives {
  /** Source families that need at least one platform-verified fact: trace, log, metric, code. */
  required_sources?: string[];
  /** A CONFIRMED root cause, supported by platform-verified facts covering every required source (default true). */
  require_root_cause?: boolean;
  /** Minimum number of platform-verified facts (default 1). */
  min_verified_facts?: number;
}
const DEFAULT_OBJECTIVES = {
  required_sources: [] as string[],
  require_root_cause: true,
  min_verified_facts: 1,
};

/**
 * The source family of a platform-verified fact, from what the platform itself knows: a verified code location, or the
 * tool that produced the cited record. The agent's `source_type` is not used (it could name any source).
 */
export function sourceFamily(c: Claim): string | null {
  const p = c.provenance;
  if (p?.status !== "VERIFIED_BY_PLATFORM") return null;
  if (p.verifies === "location") return "code";
  const t = (p.source_tool ?? "").toLowerCase();
  if (/trace|span|signoz|jaeger|tempo/.test(t)) return "trace";
  if (/log|splunk|loki|elastic/.test(t)) return "log";
  if (/metric|prometheus|grafana/.test(t)) return "metric";
  return null;
}

export interface EvidenceReport {
  incident_summary: string;
  verification: {
    status: "passed" | "incomplete" | "failed";
    claims_checked: number;
    platform_verified: number;
    failures: Array<{ claim_id?: string; reason: string }>;
    sufficiency: {
      objectives: Required<EvidenceObjectives>;
      platform_verified_facts: number;
      covered_sources: string[];
      missing_sources: string[];
      root_cause_supported: boolean;
      /** Why the objectives are not met (empty when they are). */
      reasons: string[];
    };
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
  objectives: EvidenceObjectives = {},
): Promise<EvidenceReport> {
  const goal: Required<EvidenceObjectives> = {
    required_sources: [
      ...new Set((objectives.required_sources ?? DEFAULT_OBJECTIVES.required_sources).map(String)),
    ].sort(),
    require_root_cause: objectives.require_root_cause ?? DEFAULT_OBJECTIVES.require_root_cause,
    min_verified_facts: Math.max(
      1,
      Number(objectives.min_verified_facts ?? DEFAULT_OBJECTIVES.min_verified_facts),
    ),
  };
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
  // A contradicted citation (fabricated, another run's, or a wrong observation) is a failure even when normalization
  // merged its claim into a same-text claim with a valid citation: checked on every claim before any merge.
  for (const raw of Array.isArray(claims) ? claims : []) {
    const c = raw as { id?: unknown; provenance?: { status?: string; reason?: string | null } };
    if (c?.provenance?.status !== "CONTRADICTED") continue;
    const reason = c.provenance.reason ?? "contradicted citation";
    if (!failures.some((f) => f.reason === reason))
      failures.push({ ...(c.id != null ? { claim_id: String(c.id) } : {}), reason });
  }
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
  // Sufficiency: only platform-verified facts count, grouped by what the platform knows about their source.
  const families = (cs: Claim[]) =>
    [...new Set(cs.map(sourceFamily).filter((f): f is string => !!f))].sort();
  const covered = families(confirmed);
  const missingSources = goal.required_sources.filter((f) => !covered.includes(f));
  const rc = n.root_cause_assessment ?? null;
  const byId = new Map(n.claims.map((c) => [c.id, c]));
  const supportIds = new Set(rc?.supporting_claims ?? []);
  for (const id of [...supportIds]) for (const s of byId.get(id)?.supports ?? []) supportIds.add(s); // a root-cause claim's own supports
  const support = confirmed.filter((c) => supportIds.has(c.id));
  const supportFamilies = families(support);
  const checked = support.some(
    (c) => c.provenance?.verifies === "observation" || c.provenance?.verifies === "location",
  );
  const rootCauseSupported =
    rc?.status === "CONFIRMED" &&
    support.length > 0 &&
    checked &&
    goal.required_sources.every((f) => supportFamilies.includes(f));
  if (rc?.status === "CONFIRMED" && !support.length)
    failures.push({
      reason:
        "root cause CONFIRMED without platform-verified supporting evidence (only agent-vouched or unverified facts)",
    });
  const reasons: string[] = [];
  if (confirmed.length < goal.min_verified_facts)
    reasons.push(
      confirmed.length
        ? `${confirmed.length} platform-verified facts, ${goal.min_verified_facts} required`
        : "no platform-verified fact",
    );
  for (const f of missingSources) reasons.push(`no platform-verified ${f} evidence`);
  if (goal.require_root_cause) {
    if (!rc) reasons.push("no root cause assessment");
    else if (rc.status !== "CONFIRMED") reasons.push(`root cause is ${rc.status}, not CONFIRMED`);
    else if (!rootCauseSupported)
      reasons.push(
        !checked
          ? "the confirmed root cause has no independently checked observation or code location among its supports"
          : `the confirmed root cause is not supported by verified evidence from every required source (${goal.required_sources.filter((f) => !supportFamilies.includes(f)).join(", ")})`,
      );
  }
  const location = (c: Claim) =>
    c.file_path && c.repository
      ? `${c.repository}:${c.file_path}${c.line_range ? `:${c.line_range}` : ""}@${String(c.commit ?? "").slice(0, 12)}`
      : undefined;
  const missing = n.missing_evidence;
  return {
    incident_summary: String(source.summary ?? source.root_cause ?? "").slice(0, 1200),
    verification: {
      status: failures.length
        ? "failed"
        : missing.length || reasons.length
          ? "incomplete"
          : "passed",
      claims_checked: n.claims.length,
      platform_verified: n.claims.filter(platform).length,
      failures: failures.slice(0, 30),
      sufficiency: {
        objectives: goal,
        platform_verified_facts: confirmed.length,
        covered_sources: covered,
        missing_sources: missingSources,
        root_cause_supported: rootCauseSupported,
        reasons,
      },
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
