import { codingEvidence, proofProblem, type SymptomSignal } from "./rootCause.ts";
import type { Claim, RootCauseAssessment } from "./evidence.ts";

/**
 * Proof-of-Fix: one deterministic, persisted verdict per bug-fix or investigation run, assembled from evidence the
 * platform already produced — the root-cause assessment and its provenance-checked claims, the before/after regression
 * proof run by the platform, symptom-fix and test-weakening signals, the regression test step and the independent
 * review. No model output is trusted on its own: an explanation without platform-verified evidence can never be
 * VERIFIED, and every missing element is listed instead of being assumed.
 *
 *   VERIFIED      the confirmed root cause is backed by platform-verified evidence, the change is a ROOT_CAUSE_FIX, a
 *                 platform-run regression test fails before and passes after on the tested commit, tests pass, an
 *                 independent reviewer passed it and every symptom-fix signal is justified.
 *   PARTIAL       a fix (or a diagnosis) exists and nothing failed, but at least one proof element is missing.
 *   INCONCLUSIVE  the root cause was not established and nothing demonstrates the fix.
 *   FAILED        tests fail or were weakened, the regression proof is invalid, or the independent review failed.
 */

export const FIX_VERDICTS = ["VERIFIED", "PARTIAL", "INCONCLUSIVE", "FAILED"] as const;
export type FixVerdict = (typeof FIX_VERDICTS)[number];
export const PROOF_VERSION = "2026-11-23.1";

type Json = Record<string, unknown>;
const rec = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const text = (v: unknown, n = 600) => (typeof v === "string" ? v.slice(0, n) : "");

export interface EvidenceRef {
  claim: string;
  classification: string;
  source_type: string | null;
  source_ref: string | null;
  location: string | null;
  repository: string | null;
  commit: string | null;
  /** Who vouches for it: the platform's provenance check, or only the agent. */
  provenance: string;
}

export interface FixProofInput {
  /** Outputs of the run's steps, by step key (ctx.input.upstream). */
  upstream: Record<string, { output: unknown; status?: string }>;
  /** Step holding the root-cause assessment (bug: root_cause, incident: investigate). */
  rootCauseFrom: string;
  /** Optional deterministic evidence report (evidence_report action). */
  reportFrom?: string;
  /** The coding step and the regression test step (absent for read-only investigations). */
  implementFrom?: string;
  testFrom?: string;
  /** The review step, and whether the workflow runs it as an independent verifier (never the implementer). */
  reviewFrom?: string;
  reviewIndependent?: boolean;
  /** Incident summary: run title and request. */
  incident: { title: string; request?: string };
}

export interface FixProofReport {
  version: string;
  mode: "fix" | "diagnosis";
  verdict: FixVerdict;
  reasons: string[];
  missing: string[];
  incident: { title: string; request: string };
  root_cause: {
    status: string;
    confidence: string | null;
    hypothesis: string;
    supporting: EvidenceRef[];
    contradicting: EvidenceRef[];
    platform_verified: number;
  };
  reproduction: {
    method: "platform_before_after" | "author_reported" | "none";
    status: string;
    test: string | null;
    detail: string;
    limitation: string;
  };
  change: {
    remediation_kind: string | null;
    causal_link: string;
    repositories: string[];
    symptom_signals: Array<SymptomSignal & { repo?: string; justified: boolean }>;
  };
  verification: {
    implementation_tests: boolean | null;
    regression_tests: boolean | null;
    regression_decision: string | null;
    test_weakening: string[];
    review: { verdict: string | null; independent: boolean; root_cause_check: unknown };
  };
  residual_risks: string[];
}

function evidenceRef(c: Claim): EvidenceRef {
  return {
    claim: text(c.claim, 300),
    classification: c.classification,
    source_type: c.source_type ?? null,
    source_ref: c.source_ref ?? null,
    location: c.file_path ? `${c.file_path}${c.line_range ? `:${c.line_range}` : ""}` : null,
    repository: c.repository ?? null,
    commit: c.commit ?? null,
    provenance:
      c.provenance?.status ??
      (c.verification_status === "verified" ? "VERIFIED" : "AGENT_REPORTED"),
  };
}
/** Evidence the platform itself checked (provenance) or verified; agent-reported text alone does not count. */
const platformVerified = (c: Claim) =>
  c.verification_status === "verified" &&
  c.provenance?.status !== "AGENT_REPORTED" &&
  c.provenance?.status !== "UNVERIFIED" &&
  c.provenance?.status !== "CONTRADICTED" &&
  ["OBSERVED_FACT", "CODE_FACT", "CONFIRMED_ROOT_CAUSE"].includes(c.classification);

function justified(s: SymptomSignal, entries: Array<{ signal?: unknown }>) {
  return entries.some((j) => {
    const t = String(j?.signal ?? "");
    return t.includes(s.file) && (t.includes(s.kind) || t.includes(String(s.line)));
  });
}

export function buildFixProof(input: FixProofInput): FixProofReport {
  const up = input.upstream;
  const rc = rec(up[input.rootCauseFrom]?.output);
  const assessment = rec(rc.root_cause_assessment) as Partial<RootCauseAssessment>;
  const claims = arr<Claim>(rc.claims);
  const report = input.reportFrom ? rec(up[input.reportFrom]?.output) : {};
  const reportRoot = rec(report.root_cause);
  const reportVerification = rec(report.verification);
  const status = String(assessment.status ?? reportRoot.status ?? "INSUFFICIENT_EVIDENCE");
  const supporting = claims.filter(
    (c) => c.verification_status !== "contradicted" && c.provenance?.status !== "CONTRADICTED",
  );
  const contradicting = claims.filter(
    (c) => c.verification_status === "contradicted" || c.provenance?.status === "CONTRADICTED",
  );
  const verifiedEvidence = supporting.filter(platformVerified);
  const mode: FixProofReport["mode"] =
    input.implementFrom && up[input.implementFrom] ? "fix" : "diagnosis";

  const coding = codingEvidence(
    input.implementFrom && up[input.implementFrom]
      ? { [input.implementFrom]: up[input.implementFrom] as { output: unknown } }
      : {},
  );
  const impl = input.implementFrom ? rec(up[input.implementFrom]?.output) : {};
  const implVerification = rec(impl.verification);
  const test = input.testFrom ? rec(up[input.testFrom]?.output) : {};
  const review = input.reviewFrom ? rec(up[input.reviewFrom]?.output) : {};
  const reviewVerdict = typeof review.verdict === "string" ? review.verdict : null;
  const remediation = coding.remediation;
  // Only the independent reviewer can accept a symptom-fix signal (the author's own justification is a claim).
  const justifications = arr<{ signal?: unknown }>(rec(review.root_cause_check).justified_signals);
  // The kind the reviewer recorded (never above the author's: enforceRootCauseReview) wins over the author's claim.
  const remediationKind =
    typeof review.remediation_kind === "string"
      ? review.remediation_kind
      : (remediation?.kind ?? null);
  const signals = coding.signals.map((s) => ({ ...s, justified: justified(s, justifications) }));
  // Hard weakening (removed/skipped/disabled tests) is the verifier's structured list; soft signals and runner notes
  // in review_reasons go to human review — they keep a fix below VERIFIED but are not a failure.
  const weakening = arr<{ weakened?: string[] }>(rec(implVerification).last).flatMap((r) =>
    arr<string>(r.weakened),
  );
  const softReview = arr<string>(implVerification.review_reasons);
  // A proof counts only with the platform's provenance (repository and measured commit), whatever its status says.
  const proofIssue =
    proofProblem(coding.proof, coding.tested) ??
    (coding.proof && (!coding.proof.repo || !coding.proof.head_sha)
      ? "regression proof has no platform provenance (repository and measured commit)"
      : null);
  const proof = coding.proof;

  const reasons: string[] = [];
  const missing: string[] = [];
  const failed: string[] = [];

  // ---- FAILED: something demonstrably went wrong (never hidden behind a softer verdict)
  if (mode === "fix") {
    if (implVerification.passed === false) failed.push("implementation tests fail");
    if (weakening.length) failed.push(`tests weakened: ${weakening.slice(0, 3).join("; ")}`);
    if (test.passed === false && !test.decision) failed.push("regression test step failed");
    if (proof?.status === "invalid") failed.push(`regression proof invalid: ${proof.reason}`);
    if (reviewVerdict === "FAIL") failed.push("independent review FAIL");
  } else if (reportVerification.status === "failed")
    failed.push("evidence verification failed (claims contradicted by platform records)");

  // ---- what VERIFIED needs, each missing element named
  if (status !== "CONFIRMED") missing.push(`root cause is ${status}, not CONFIRMED`);
  if (!verifiedEvidence.length)
    missing.push("no platform-verified evidence supports the root cause");
  if (contradicting.length)
    missing.push(`${contradicting.length} contradicting evidence item(s) unresolved`);
  if (mode === "fix") {
    if (remediationKind !== "ROOT_CAUSE_FIX")
      missing.push(`remediation is ${remediationKind ?? "unclassified"}, not ROOT_CAUSE_FIX`);
    if (softReview.length)
      missing.push(`verification needs human review: ${softReview.slice(0, 3).join("; ")}`);
    if (proofIssue) missing.push(proofIssue);
    if (implVerification.passed !== true)
      missing.push("implementation tests did not run or did not pass");
    if (input.testFrom && test.passed !== true)
      missing.push(
        test.decision
          ? "regression test failures were accepted by a human"
          : "regression tests not passed",
      );
    if (!input.reviewFrom || reviewVerdict !== "PASS") missing.push("no independent review PASS");
    else if (!input.reviewIndependent)
      missing.push(
        "the review is not an independent verifier (the implementer cannot approve its own work)",
      );
    const open = signals.filter((s) => !s.justified);
    if (open.length)
      missing.push(
        `${open.length} unjustified symptom-fix signal(s): ${open
          .slice(0, 4)
          .map((s) => `${s.kind} ${s.file}:${s.line}`)
          .join(", ")}`,
      );
  } else if (reportVerification.status && reportVerification.status !== "passed")
    missing.push(`evidence verification ${String(reportVerification.status)}`);

  let verdict: FixVerdict;
  if (failed.length) {
    verdict = "FAILED";
    reasons.push(...failed);
  } else if (!missing.length) {
    verdict = "VERIFIED";
    reasons.push(
      mode === "fix"
        ? "confirmed root cause with platform-verified evidence, platform-run regression proof, passing tests and an independent PASS"
        : "confirmed root cause with platform-verified evidence and a passing evidence verification",
    );
  } else {
    const established = status === "CONFIRMED" || status === "PROBABLE";
    const demonstrated =
      mode === "fix" && (proof?.status === "verified" || implVerification.passed === true);
    verdict = established || demonstrated ? "PARTIAL" : "INCONCLUSIVE";
    reasons.push(
      verdict === "PARTIAL"
        ? "a fix or diagnosis exists but the proof is incomplete"
        : "the root cause was not established and nothing demonstrates a fix",
    );
  }

  const authorTest = remediation?.regression_test;
  const residual = [
    ...(remediation?.risks ?? []),
    ...(remediation?.unresolved_cause ? [`unresolved cause: ${remediation.unresolved_cause}`] : []),
    ...(implVerification.needs_review
      ? arr<string>(implVerification.review_reasons).slice(0, 5)
      : []),
    ...(test.decision
      ? [`regression test decision: ${text(JSON.stringify(test.decision), 200)}`]
      : []),
    ...arr<string>(rc.missing_evidence)
      .slice(0, 5)
      .map((m) => `missing evidence: ${text(m, 200)}`),
  ].slice(0, 20);

  return {
    version: PROOF_VERSION,
    mode,
    verdict,
    reasons,
    missing,
    incident: {
      title: text(input.incident.title, 300),
      request: text(input.incident.request ?? "", 1000),
    },
    root_cause: {
      status,
      confidence: (assessment.confidence as string | null) ?? null,
      hypothesis: text(assessment.explanation ?? rc.root_cause ?? reportRoot.explanation, 1000),
      supporting: supporting.slice(0, 20).map(evidenceRef),
      contradicting: contradicting.slice(0, 10).map(evidenceRef),
      platform_verified: verifiedEvidence.length,
    },
    reproduction: proof
      ? {
          method: "platform_before_after",
          status: proof.status,
          test: proof.test_id ?? null,
          detail: text(
            `${proof.reason}${proof.before ? ` — before: ${proof.before}` : ""}${proof.after ? `, after: ${proof.after}` : ""}`,
            600,
          ),
          limitation: remediation?.verification_limitations ?? "",
        }
      : {
          method: authorTest?.name ? "author_reported" : "none",
          status: authorTest?.name ? "unmeasured" : "none",
          test: authorTest?.name || null,
          detail: authorTest?.name
            ? "the implementer named a test; the platform did not measure it fail before the fix"
            : "",
          limitation: remediation?.verification_limitations ?? "",
        },
    change: {
      remediation_kind: remediationKind,
      causal_link: remediation?.causal_link ?? "",
      repositories: Object.keys(coding.tested),
      symptom_signals: signals,
    },
    verification: {
      implementation_tests:
        typeof implVerification.passed === "boolean" ? implVerification.passed : null,
      regression_tests: typeof test.passed === "boolean" ? test.passed : null,
      regression_decision: test.decision ? text(JSON.stringify(test.decision), 300) : null,
      test_weakening: weakening,
      review: {
        verdict: reviewVerdict,
        independent: !!input.reviewIndependent,
        root_cause_check: review.root_cause_check ?? null,
      },
    },
    residual_risks: residual,
  };
}
