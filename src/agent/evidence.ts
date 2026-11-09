import { createHash } from "node:crypto";
import { evaluateScope, scopeViolations } from "./scopeGuard.ts";
import { redactContextText } from "../context/redact.ts";
import { estimateTokens } from "../context/plan.ts";

/**
 * Evidence-gated investigation (generic, provider- and domain-neutral).
 *
 * Agents submit claims, a root-cause assessment and a fix assessment; the platform normalizes them deterministically.
 * Normalization only ever LOWERS certainty (a claim without usable provenance is downgraded, a root cause without
 * verified support is capped, confidence never rises between steps without new verified evidence) and records every
 * adjustment in `evidence_validation.notes` — nothing is silently promoted or silently dropped. Domain rules (what a
 * tracking number proves, which statuses exist) belong in Knowledge/Skills, not here.
 */

export const CLAIM_CLASSES = ["OBSERVED_FACT", "CODE_FACT", "HYPOTHESIS", "ASSUMPTION", "CONFIRMED_ROOT_CAUSE"] as const;
export type ClaimClass = (typeof CLAIM_CLASSES)[number];
export const ROOT_CAUSE_STATUSES = ["INSUFFICIENT_EVIDENCE", "UNCONFIRMED", "PROBABLE", "CONFIRMED"] as const; // ascending
export type RootCauseStatus = (typeof ROOT_CAUSE_STATUSES)[number];
export const RISKS = ["LOW", "MEDIUM", "HIGH"] as const; // ascending
export type FixRisk = (typeof RISKS)[number];
export type Level = "low" | "medium" | "high";
export type VerificationStatus = "verified" | "unverified" | "missing" | "contradicted";

/** Observable sources that can back an OBSERVED_FACT. Agent outputs are deliberately absent. */
const OBSERVABLE_SOURCES = new Set([
  "production_log", "log", "api_response", "database", "db_query", "metric", "trace", "test_output", "command_output",
  "screenshot", "user_report", "ticket", "external_doc", "monitoring",
]);
/** Sources that are opinions, not evidence: repeating them never makes a fact. */
const OPINION_SOURCES = new Set(["agent_output", "previous_step", "agent_opinion", "llm", "model", "inference", "reasoning"]);

export interface Claim {
  id: string;
  claim: string;
  classification: ClaimClass;
  source_type: string | null;
  source_ref: string | null;
  repository: string | null;
  commit: string | null;
  file_path: string | null;
  line_range: string | null;
  confidence: Level | null;
  verification_status: VerificationStatus;
  supports?: string[];
  contradicts?: string[];
  notes?: string[];
  /** Set by the platform (provenance.ts) — agent-supplied values are stripped before normalization. */
  provenance?: { by: "platform"; status: "VERIFIED_BY_PLATFORM" | "AGENT_REPORTED" | "UNVERIFIED" | "CONTRADICTED"; verifies: "location" | "source_record" | null; reason: string | null; stale?: boolean };
}

export interface RootCauseAssessment {
  status: RootCauseStatus;
  confidence: Level | null;
  explanation: string;
  supporting_claims: string[];
}

export const INVARIANT_FIELDS = [
  "current_state", "target_state", "source_of_truth", "preconditions", "external_contract", "idempotency",
  "retry_behavior", "side_effects", "concurrency", "failure_handling", "regression_tests",
] as const;

export interface FixAssessment {
  risk: FixRisk;
  declared_risk: FixRisk | null;
  detected_risk: FixRisk;
  risk_reasons: string[];
  confidence: Level | null;
  explanation: string;
  side_effects: string;
  rollback: string;
  business_invariants: Partial<Record<(typeof INVARIANT_FIELDS)[number], string>> | null;
}

export interface EvidenceGate {
  root_cause_status: RootCauseStatus;
  fix_risk: FixRisk;
  requirement: "independent_support" | "side_effect_evidence" | "invariant_verification";
  missing: string[];
  /** false = a human must explicitly acknowledge the gap at approval (never auto-approved). */
  satisfied: boolean;
}

const clip = (s: unknown, n: number) => {
  const t = redactContextText(String(s ?? "").replace(/\s+/g, " ").trim());
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const str = (v: unknown, n = 200) => (typeof v === "string" && v.trim() ? clip(v, n) : typeof v === "number" ? String(v) : null);
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const level = (v: unknown): Level | null => {
  const s = String(v ?? "").toLowerCase().trim();
  return s === "low" || s === "medium" || s === "high" ? s : null;
};
const rank = <T extends string>(list: readonly T[], v: T) => list.indexOf(v);
const maxOf = <T extends string>(list: readonly T[], a: T, b: T) => (rank(list, a) >= rank(list, b) ? a : b);
/** "unknown", "n/a", "TBD", "not checked", "chưa rõ" … do not count as an answer. */
const PLACEHOLDER = /^(?:-|—|\?|none|null|n\/?a|tbd|todo|unknown|unclear|not (?:checked|verified|known|available)|chưa(?: rõ| kiểm tra| xác minh| biết)?|không rõ)\.?$/i;
const answered = (v: unknown) => typeof v === "string" ? !!v.trim() && !PLACEHOLDER.test(v.trim()) : Array.isArray(v) ? v.some(answered) : false;

// ---------------------------------------------------------------- claims

export function normalizeClaims(raw: unknown, notes: string[]): Claim[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    notes.push("claims was not a list and was ignored");
    return [];
  }
  const out: Claim[] = [];
  const byText = new Map<string, Claim>();
  raw.slice(0, 60).forEach((r: any, i) => {
    const text = typeof r === "string" ? clip(r, 500) : str(r?.claim, 500);
    if (!text) return;
    const id = str(r?.id, 40) ?? `C${i + 1}`;
    const cls = String(r?.classification ?? "").toUpperCase().trim();
    const c: Claim = {
      id,
      claim: text,
      classification: (CLAIM_CLASSES as readonly string[]).includes(cls) ? (cls as ClaimClass) : "HYPOTHESIS",
      source_type: str(r?.source_type, 40)?.toLowerCase() ?? null,
      source_ref: str(r?.source_ref, 200),
      repository: str(r?.repository, 120),
      commit: str(r?.commit, 64),
      file_path: str(r?.file_path, 300),
      line_range: str(r?.line_range, 40),
      confidence: level(r?.confidence),
      verification_status: (["verified", "unverified", "missing", "contradicted"] as const).find((s) => s === String(r?.verification_status ?? "").toLowerCase()) ?? "unverified",
      supports: Array.isArray(r?.supports) ? r.supports.map((x: unknown) => String(x)).slice(0, 10) : undefined,
      contradicts: Array.isArray(r?.contradicts) ? r.contradicts.map((x: unknown) => String(x)).slice(0, 10) : undefined,
      ...(r?.provenance?.by === "platform" && ["VERIFIED_BY_PLATFORM", "AGENT_REPORTED", "UNVERIFIED", "CONTRADICTED"].includes(r.provenance.status)
        ? { provenance: { by: "platform" as const, status: r.provenance.status, verifies: r.provenance.verifies ?? null, reason: r.provenance.reason ?? null, ...(r.provenance.stale ? { stale: true } : {}) } }
        : {}),
    };
    const local: string[] = [];
    if (!(CLAIM_CLASSES as readonly string[]).includes(cls)) local.push(`unknown classification "${cls || "(none)"}" treated as HYPOTHESIS`);
    if (typeof r?.confidence === "number" || /\d\s*%|0\.\d/.test(String(r?.confidence ?? ""))) local.push("numeric confidence discarded (use low/medium/high)");
    const downgrade = (to: ClaimClass, why: string) => {
      local.push(`${c.classification} → ${to}: ${why}`);
      c.classification = to;
      if (c.verification_status === "verified") c.verification_status = "unverified";
    };
    if (c.source_type && OPINION_SOURCES.has(c.source_type) && ["OBSERVED_FACT", "CODE_FACT", "CONFIRMED_ROOT_CAUSE"].includes(c.classification))
      downgrade("HYPOTHESIS", `an agent opinion (${c.source_type}) is not independent evidence`);
    if (c.classification === "OBSERVED_FACT") {
      if (!c.source_ref || !c.source_type) downgrade("HYPOTHESIS", "no source_type/source_ref to verify the observation");
      else if (!OBSERVABLE_SOURCES.has(c.source_type)) downgrade("HYPOTHESIS", `source_type "${c.source_type}" is not observable evidence`);
    }
    if (c.classification === "CODE_FACT") {
      if (!c.repository || !c.file_path) downgrade("HYPOTHESIS", "no repository/file_path to verify the code fact");
      else if (!c.commit && c.verification_status === "verified") {
        c.verification_status = "unverified";
        local.push("CODE_FACT without a commit cannot be verified at a known revision");
      }
    }
    if ((c.classification === "HYPOTHESIS" || c.classification === "ASSUMPTION") && c.verification_status === "verified") {
      c.verification_status = "unverified";
      local.push(`a ${c.classification} cannot be verified; status reset to unverified`);
    }
    if (local.length) c.notes = local;
    // Repetition is not corroboration: the same claim stated twice is merged, never counted twice.
    const key = norm(text);
    const prev = byText.get(key);
    if (prev) {
      if (strength(c) > strength(prev)) Object.assign(prev, { ...c, id: prev.id });
      notes.push(`duplicate claim ${id} merged into ${prev.id}`);
      return;
    }
    byText.set(key, c);
    out.push(c);
  });
  // CONFIRMED_ROOT_CAUSE needs at least one verified OBSERVED_FACT / CODE_FACT it rests on.
  const byId = new Map(out.map((c) => [c.id, c]));
  for (const c of out) {
    if (c.classification !== "CONFIRMED_ROOT_CAUSE") continue;
    const support = (c.supports ?? []).map((id) => byId.get(id)).filter((s) => s && isVerifiedFact(s));
    if (!support.length) {
      (c.notes ??= []).push("CONFIRMED_ROOT_CAUSE → HYPOTHESIS: no verified OBSERVED_FACT/CODE_FACT in supports");
      c.classification = "HYPOTHESIS";
      c.verification_status = "unverified";
    }
  }
  // Contradiction between two verified facts: neither may be relied on until a human resolves it.
  for (const c of out)
    for (const other of (c.contradicts ?? []).map((id) => byId.get(id)).filter(Boolean) as Claim[])
      if (isVerifiedFact(c) || isVerifiedFact(other)) {
        for (const x of [c, other]) {
          if (x.verification_status !== "contradicted") (x.notes ??= []).push(`contradicted by ${x === c ? other.id : c.id}`);
          x.verification_status = "contradicted";
        }
      }
  for (const c of out) if (c.notes) notes.push(`${c.id}: ${c.notes.join("; ")}`);
  return out;
}

const strength = (c: Claim) => (isVerifiedFact(c) ? 3 : c.classification === "CONFIRMED_ROOT_CAUSE" ? 2 : ["OBSERVED_FACT", "CODE_FACT"].includes(c.classification) ? 1 : 0);
export const isVerifiedFact = (c: Claim) => (c.classification === "OBSERVED_FACT" || c.classification === "CODE_FACT") && c.verification_status === "verified";

// ---------------------------------------------------------------- root cause

export function assessRootCause(raw: unknown, claims: Claim[], prior: RootCauseAssessment | null, priorClaims: Claim[], notes: string[]): RootCauseAssessment {
  const r: any = raw && typeof raw === "object" ? raw : {};
  let status = (ROOT_CAUSE_STATUSES as readonly string[]).includes(String(r.status ?? "").toUpperCase()) ? (String(r.status).toUpperCase() as RootCauseStatus) : null;
  if (!status) {
    notes.push(`root cause status ${r.status ? `"${String(r.status).slice(0, 30)}" unknown` : "not given"}: INSUFFICIENT_EVIDENCE`);
    status = "INSUFFICIENT_EVIDENCE";
  }
  if (typeof r.confidence === "number" || /\d\s*%|0\.\d/.test(String(r.confidence ?? ""))) notes.push("numeric root-cause confidence discarded (use low/medium/high)");
  const explanation = str(r.explanation, 600) ?? "";
  const cap = (to: RootCauseStatus, why: string) => {
    if (rank(ROOT_CAUSE_STATUSES, status!) > rank(ROOT_CAUSE_STATUSES, to)) {
      notes.push(`root cause ${status} → ${to}: ${why}`);
      status = to;
    }
  };
  const verified = claims.filter(isVerifiedFact);
  const confirmedClaim = claims.some((c) => c.classification === "CONFIRMED_ROOT_CAUSE");
  if (claims.some((c) => c.verification_status === "contradicted")) cap("PROBABLE", "contradictory evidence is unresolved");
  if (!confirmedClaim) cap("PROBABLE", "no CONFIRMED_ROOT_CAUSE claim backed by verified evidence");
  if (!verified.length) cap("UNCONFIRMED", "no verified OBSERVED_FACT/CODE_FACT");
  if (!explanation) cap("UNCONFIRMED", "the confidence assessment has no explanation");
  // Confidence never rises between steps without NEW verified evidence.
  if (prior && rank(ROOT_CAUSE_STATUSES, status) > rank(ROOT_CAUSE_STATUSES, prior.status)) {
    const known = new Set(priorClaims.filter(isVerifiedFact).map((c) => norm(c.claim)));
    if (!verified.some((c) => !known.has(norm(c.claim)))) cap(prior.status, `raised above the earlier ${prior.status} without new verified evidence`);
  }
  const ids = new Set(claims.map((c) => c.id));
  return {
    status,
    confidence: level(r.confidence),
    explanation,
    supporting_claims: (Array.isArray(r.supporting_claims) ? r.supporting_claims.map(String) : []).filter((id: string) => ids.has(id)).slice(0, 10),
  };
}

// ---------------------------------------------------------------- fix risk

const HIGH_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:mark|treat|consider|flag|assume)\w*\b[^.;\n]{0,50}\b(?:as\s+)?(?:shipped|delivered|paid|refunded|completed|succe(?:ss|eded|ssful)(?:ly)?|ready[\s_-]?to[\s_-]?ship|fulfill?ed|confirmed)\b/i, "marks an operation/entity as successful or complete"],
  [/\b(?:update|change|set|transition|move|advance|override|force)\w*\s+(?:the\s+)?(?:\w+\s+){0,2}(?:status|state)\b/i, "changes a business status/state"],
  [/\b(?:status|state)\s*(?:=|:=|->|→|\bto\b)\s*["'`]?[A-Z][A-Z_]{2,}/, "assigns a business status/state"],
  [/\b(?:change|adjust|recalculat|modify|update|compute|round)\w*\b[^.;\n]{0,40}\b(?:amount|total|price|fee|balance|refund|payout)s?\b/i, "changes a monetary amount"],
  [/\b(?:inventory|stock)\b[^.;\n]{0,40}\b(?:quantity|qty|level|count|deduct|increment|decrement|adjust|reserve)/i, "modifies inventory quantities"],
  [/\breconcil/i, "touches financial reconciliation"],
  [/\b(?:skip|bypass|disable|remove|turn off|ignore)\w*\b[^.;\n]{0,40}\b(?:fraud|authori[sz]ation|authentication|permission|signature|approval|transition|workflow step)\b/i, "skips a required check or transition"],
  [/(?:cập nhật|chuyển|đổi|đặt)\s+trạng thái|đánh dấu[^.;\n]{0,30}(?:đã giao|thành công|đã thanh toán|hoàn tất)|hoàn tiền|số tiền|tồn kho|đối soát|bỏ qua[^.;\n]{0,20}(?:kiểm tra|xác thực|phê duyệt)/i, "changes business state, money or inventory"],
];
const MEDIUM_PATTERNS: Array<[RegExp, string]> = [
  [/\bretr(?:y|ies|ying)\b|\bbackoff\b|thử lại/i, "changes retry behaviour"],
  [/\btime-?outs?\b|hết thời gian/i, "changes timeout behaviour"],
  [/\bfall\s?back\b|dự phòng/i, "introduces a fallback path"],
  [/\bidempoten|\bdedup|\bdeduplicat/i, "changes idempotency/deduplication"],
  [/\b(?:swallow|suppress|ignore|continue on)\w*\b[^.;\n]{0,30}\berrors?\b|\bre-?queue|\bdead.?letter|\bcircuit.?breaker/i, "changes error handling with business effect"],
];

/** Deterministic floor for a proposal's risk, from its change descriptions. Never lowers a declared risk. */
export function detectRisk(texts: string[]): { risk: FixRisk; reasons: string[] } {
  const reasons = new Set<string>();
  let risk: FixRisk = "LOW";
  for (const t of texts) {
    for (const [re, why] of HIGH_PATTERNS) if (re.test(t)) (reasons.add(`HIGH: ${why}`), (risk = "HIGH"));
    for (const [re, why] of MEDIUM_PATTERNS) if (re.test(t)) (reasons.add(`MEDIUM: ${why}`), (risk = maxOf(RISKS, risk, "MEDIUM")));
  }
  return { risk, reasons: [...reasons] };
}

export function proposalTexts(output: any): string[] {
  const changes = Array.isArray(output?.changes) ? output.changes : [];
  return [
    ...changes.map((c: any) => [c?.description, Array.isArray(c?.files) ? "" : c?.files].filter(Boolean).join(" ")),
    String(output?.summary ?? ""),
  ].filter((t) => t.trim());
}

export function assessFix(raw: unknown, output: any, notes: string[]): FixAssessment {
  const r: any = raw && typeof raw === "object" ? raw : {};
  const declared = (RISKS as readonly string[]).includes(String(r.risk ?? "").toUpperCase()) ? (String(r.risk).toUpperCase() as FixRisk) : null;
  const detected = detectRisk(proposalTexts(output));
  const risk = declared ? maxOf(RISKS, declared, detected.risk) : detected.risk;
  if (!declared) notes.push(`fix risk not declared: using the detected ${detected.risk}`);
  else if (risk !== declared) notes.push(`fix risk raised ${declared} → ${risk}: ${detected.reasons.join("; ")}`);
  const inv = r.business_invariants && typeof r.business_invariants === "object" ? r.business_invariants : null;
  return {
    risk,
    declared_risk: declared,
    detected_risk: detected.risk,
    risk_reasons: detected.reasons,
    confidence: level(r.confidence),
    explanation: str(r.explanation, 600) ?? "",
    side_effects: str(r.side_effects, 400) ?? "",
    rollback: str(r.rollback, 400) ?? "",
    business_invariants: inv ? Object.fromEntries(INVARIANT_FIELDS.filter((k) => inv[k] !== undefined).map((k) => [k, clip(Array.isArray(inv[k]) ? inv[k].join("; ") : inv[k], 300)])) : null,
  };
}

/** What each risk level must show before it may proceed. LOW may proceed with an unconfirmed root cause. */
export function evidenceGate(root: RootCauseStatus, fix: FixAssessment): EvidenceGate {
  const missing: string[] = [];
  if (!answered(fix.explanation)) missing.push("explanation of why the change is correct independently of the root cause");
  if (fix.risk !== "LOW") {
    if (!answered(fix.side_effects)) missing.push("side_effects");
    if (!answered(fix.rollback)) missing.push("rollback");
  }
  if (fix.risk === "HIGH") {
    for (const k of INVARIANT_FIELDS) if (!answered(fix.business_invariants?.[k])) missing.push(`business_invariants.${k}`);
    if (root !== "CONFIRMED" && root !== "PROBABLE") missing.push(`root cause is ${root}: a HIGH-risk state change cannot rest on an unproven hypothesis`);
  }
  return {
    root_cause_status: root,
    fix_risk: fix.risk,
    requirement: fix.risk === "HIGH" ? "invariant_verification" : fix.risk === "MEDIUM" ? "side_effect_evidence" : "independent_support",
    missing,
    satisfied: missing.length === 0,
  };
}

// ---------------------------------------------------------------- per-step normalization

export type EvidenceRole = "analysis" | "root_cause" | "fix_proposal";
export const evidenceRole = (cfg: Record<string, any> | undefined): EvidenceRole | null =>
  (["analysis", "root_cause", "fix_proposal"] as const).find((r) => r === cfg?.evidence) ?? null;

const list = (v: unknown, n = 20, len = 300) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => (typeof x === "string" ? clip(x, len) : clip(JSON.stringify(x), len))).filter(Boolean).slice(0, n);

/**
 * Normalize an investigation step's output in place (returns a new object). `upstream` = outputs of earlier steps, used
 * for the no-escalation rule. `unavailable` = evidence sources the platform itself could not reach for this attempt;
 * they are added to missing_evidence so a later step cannot forget them.
 */
export function normalizeInvestigationOutput(role: EvidenceRole, output: Record<string, any>, upstream: Record<string, any> = {}, unavailable: string[] = []) {
  const notes: string[] = [];
  const claims = normalizeClaims(output.claims, notes);
  const out: Record<string, any> = { ...output, claims };
  const missing = list(output.missing_evidence, 30);
  for (const u of unavailable) if (!missing.some((m) => m.toLowerCase().includes(u.toLowerCase()))) missing.push(`${u}: unavailable to this step (not inspected)`);
  out.missing_evidence = missing;
  const prior = latestAssessment(upstream);
  if (role === "analysis") {
    for (const k of ["verified_observations", "code_paths_inspected", "hypotheses", "evidence_suggestions", "safe_next_actions"]) out[k] = list(output[k]);
    const impact = output.impact_assessment && typeof output.impact_assessment === "object" ? { ...output.impact_assessment } : { summary: str(output.impact_assessment, 600) ?? "" };
    // A blast radius needs data; one log event is not one affected record.
    if (missing.length && (impact.exact === true || typeof impact.affected_count === "number")) {
      notes.push("exact impact claimed while evidence is missing: impact scope set to unknown");
      impact.exact = false;
      impact.scope = "unknown";
    }
    out.impact_assessment = impact;
  }
  if (role === "root_cause" || role === "fix_proposal") {
    const raw = output.root_cause_assessment ?? (role === "fix_proposal" && prior ? prior.assessment : undefined);
    out.root_cause_assessment = assessRootCause(raw, role === "fix_proposal" && !output.root_cause_assessment && prior ? prior.claims : claims, prior?.assessment ?? null, prior?.claims ?? [], notes);
  }
  if (role === "fix_proposal") {
    const fix = assessFix(output.fix_assessment, output, notes);
    out.fix_assessment = fix;
    out.evidence_gate = evidenceGate(out.root_cause_assessment.status, fix);
    out.prohibited_assumptions = list(output.prohibited_assumptions, 15);
    out.required_tests = list(output.required_tests ?? output.regression_tests, 15);
  }
  out.evidence_validation = { notes: notes.slice(0, 40), downgraded: claims.filter((c) => c.notes?.some((n) => n.includes("→"))).length, normalized_at: "platform" };
  return out;
}

function latestAssessment(upstream: Record<string, any>) {
  let found: { assessment: RootCauseAssessment; claims: Claim[] } | null = null;
  for (const o of Object.values(upstream)) {
    const a = o?.root_cause_assessment;
    if (a && (ROOT_CAUSE_STATUSES as readonly string[]).includes(a.status) && (!found || rank(ROOT_CAUSE_STATUSES, a.status) < rank(ROOT_CAUSE_STATUSES, found.assessment.status)))
      found = { assessment: a, claims: Array.isArray(o.claims) ? o.claims : [] }; // the most cautious earlier verdict binds
  }
  return found;
}

// ---------------------------------------------------------------- approval scope

export interface ApprovedScope {
  source_step: string;
  proposal_hash: string;
  summary: string;
  changes: Array<{ repo: string; files: string[]; description: string }>;
  risk: FixRisk | null;
  root_cause_status: RootCauseStatus | null;
  gate: EvidenceGate | null;
  assumptions: string[];
  prohibited_assumptions: string[];
  required_tests: string[];
}

export function approvedScopeFrom(stepKey: string, proposal: any): ApprovedScope | null {
  if (!proposal || typeof proposal !== "object") return null;
  const changes = (Array.isArray(proposal.changes) ? proposal.changes : []).slice(0, 20).map((c: any) => ({
    repo: String(c?.repo ?? ""),
    files: (Array.isArray(c?.files) ? c.files : c?.files ? [c.files] : []).map(String).slice(0, 30),
    description: clip(c?.description, 500),
  }));
  const claims: Claim[] = Array.isArray(proposal.claims) ? proposal.claims : [];
  return {
    source_step: stepKey,
    proposal_hash: createHash("sha256").update(JSON.stringify({ summary: proposal.summary ?? "", changes })).digest("hex").slice(0, 16),
    summary: clip(proposal.summary, 600),
    changes,
    risk: proposal.fix_assessment?.risk ?? null,
    root_cause_status: proposal.root_cause_assessment?.status ?? null,
    gate: proposal.evidence_gate ?? null,
    assumptions: claims.filter((c) => c.classification === "ASSUMPTION" || c.classification === "HYPOTHESIS").map((c) => c.claim).slice(0, 12),
    prohibited_assumptions: list(proposal.prohibited_assumptions, 15),
    required_tests: list(proposal.required_tests ?? proposal.regression_tests, 15),
  };
}

/**
 * Compare what the coding step changed with the approved scope. `files` = changed paths per repo, collected by the
 * platform from git (committed, staged, unstaged, untracked — see scopeGuard.ts); `declared` = deviations the coding
 * agent reported itself (recorded, but never needed to detect a violation). Every out-of-scope, unauthorized-repository
 * or invalid path — and every declared deviation riskier than the approved risk — requires renewed approval, bound to
 * `revision` (the exact changed-file set and code state; see scopeRevision).
 */
export function scopeCheck(scope: ApprovedScope, files: Record<string, string[]>, declared: unknown, revision: string | null = null) {
  const ev = evaluateScope(scope, files);
  const deviations = (Array.isArray(declared) ? declared : []).slice(0, 10).map((d: any) => {
    const description = clip(typeof d === "string" ? d : d?.description, 400);
    const declaredRisk = (RISKS as readonly string[]).includes(String(d?.risk ?? "").toUpperCase()) ? (String(d.risk).toUpperCase() as FixRisk) : "LOW";
    const detected = detectRisk([description]);
    return { description, reason: clip(d?.reason, 300), risk: maxOf(RISKS, declaredRisk, detected.risk) };
  });
  const approvedRisk = scope.risk ?? "LOW";
  const escalations = deviations.filter((d) => rank(RISKS, d.risk) > rank(RISKS, approvedRisk));
  const violations = scopeViolations(ev);
  return {
    approved_proposal_hash: scope.proposal_hash,
    approved_risk: approvedRisk,
    revision,
    out_of_scope_files: [...new Set(ev.out_of_scope_files)].slice(0, 30),
    out_of_scope_tests: ev.out_of_scope_tests.slice(0, 30),
    invalid_paths: ev.invalid_paths.slice(0, 30),
    unauthorized_repos: ev.unauthorized_repos,
    deviations,
    requires_reapproval: escalations.length > 0 || violations.length > 0,
    reasons: [
      ...violations.slice(0, 12),
      ...(violations.length > 12 ? [`… ${violations.length - 12} more scope violation(s)`] : []),
      ...escalations.map((d) => `deviation "${d.description.slice(0, 120)}" is ${d.risk} risk, above the approved ${approvedRisk}`),
    ],
  };
}

// ---------------------------------------------------------------- compact summary for the context pack

export const GENERIC_PROHIBITED = [
  "The presence of an identifier or reference (tracking number, transaction id, package id) does not prove that an external state transition happened; confirm it with the authoritative source.",
  "One log occurrence does not bound how many records are affected.",
  "A retry is not safe until side effects and idempotency are verified.",
  "Repeating an earlier step's hypothesis does not make it a fact; only new verified evidence changes its status.",
];

/**
 * Deterministic, bounded digest of the evidence across upstream steps: verified facts, open hypotheses, missing evidence,
 * the most cautious root-cause verdict, fix risk, approved scope, prohibited assumptions, invariants and required tests.
 * Full outputs stay retrievable on demand (platform.get_step_output); `refs` says where.
 */
export function evidenceSummary(upstream: Record<string, { output: any; status?: string }>) {
  const facts: string[] = [], hyps: string[] = [], unverified: string[] = [], missing: string[] = [], prohibited: string[] = [...GENERIC_PROHIBITED], tests: string[] = [];
  const seen = new Set<string>();
  const refs: string[] = [];
  let root: (RootCauseAssessment & { from: string }) | null = null;
  let fix: { risk: FixRisk; gate: EvidenceGate | null; from: string; invariants: FixAssessment["business_invariants"] } | null = null;
  let scope: (ApprovedScope & { approved_by?: string; approved_at?: string; comment?: string }) | null = null;
  let dropped = 0;
  const push = (arr: string[], s: string, max = 12) => {
    const k = norm(s);
    if (!k || seen.has(k)) return;
    seen.add(k);
    if (arr.length >= max) return void dropped++;
    arr.push(clip(s, 240));
  };
  for (const [key, u] of Object.entries(upstream)) {
    const o = u?.output;
    if (!o || typeof o !== "object" || (u.status && u.status !== "COMPLETED")) continue;
    if (o.approved_scope) scope = o.approved_scope;
    const isInvestigation = Array.isArray(o.claims) || o.root_cause_assessment || o.fix_assessment || Array.isArray(o.missing_evidence);
    if (!isInvestigation) continue;
    refs.push(key);
    // Re-normalize: stored outputs may be legacy or hand-edited; this can only lower certainty.
    const claims = normalizeClaims(o.claims, []);
    for (const c of claims) {
      const ref = [c.source_type, c.source_ref, c.file_path && `${c.repository ?? ""}/${c.file_path}${c.line_range ? `:${c.line_range}` : ""}${c.commit ? `@${c.commit.slice(0, 10)}` : ""}`].filter(Boolean).join(" ");
      if (isVerifiedFact(c)) push(facts, `[${c.classification}] ${c.claim} (${ref || "no ref"}; ${key})`);
      else if (c.verification_status === "contradicted") push(unverified, `[CONTRADICTED] ${c.claim} (${key})`);
      else if (c.classification === "HYPOTHESIS" || c.classification === "CONFIRMED_ROOT_CAUSE" || c.classification === "ASSUMPTION") push(hyps, `[${c.classification}] ${c.claim} (${key})`);
      else push(unverified, `[${c.classification}, unverified] ${c.claim} (${key})`);
    }
    for (const m of list(o.missing_evidence, 30)) push(missing, m);
    for (const p of list(o.prohibited_assumptions, 15)) push(prohibited, p);
    for (const t of list(o.required_tests ?? o.regression_tests, 15)) push(tests, t);
    const a = o.root_cause_assessment;
    if (a && (ROOT_CAUSE_STATUSES as readonly string[]).includes(a.status) && (!root || rank(ROOT_CAUSE_STATUSES, a.status) <= rank(ROOT_CAUSE_STATUSES, root.status)))
      root = { status: a.status, confidence: a.confidence ?? null, explanation: clip(a.explanation, 300), supporting_claims: a.supporting_claims ?? [], from: key };
    if (o.fix_assessment?.risk) fix = { risk: o.fix_assessment.risk, gate: o.evidence_gate ?? null, from: key, invariants: o.fix_assessment.business_invariants ?? null };
  }
  if (!refs.length && !scope) return null;
  for (const h of hyps) prohibited.length < 20 && prohibited.push(`Do not implement as fact: ${h.replace(/^\[[A-Z_]+\]\s*/, "").slice(0, 200)}`);
  return {
    verified_facts: facts,
    open_hypotheses: hyps,
    unverified_or_contradicted: unverified,
    missing_evidence: missing,
    root_cause: root,
    fix,
    approved_scope: scope
      ? { proposal_hash: scope.proposal_hash, risk: scope.risk, summary: scope.summary, changes: scope.changes, approved_by: scope.approved_by, approved_at: scope.approved_at, comment: scope.comment, risk_acknowledged: (scope as any).risk_acknowledged ?? false }
      : null,
    prohibited_assumptions: [...new Set(prohibited)].slice(0, 20),
    business_invariants: fix?.invariants ?? null,
    required_tests: tests,
    rules: [
      "Implement ONLY the approved change scope. Optional or speculative ideas are not requirements.",
      "Report any change outside the approved scope in scope_deviations; a higher-risk deviation needs renewed approval.",
      "Root-cause status may only rise with NEW verified evidence (cite it).",
    ],
    refs: refs.map((k) => `platform.get_step_output("${k}")`),
    ...(dropped ? { truncated_items: dropped } : {}),
  };
}

export const summaryTokens = (s: unknown) => estimateTokens(JSON.stringify(s ?? null));

export const SCOPE_REAPPROVAL_QUESTION = "Scope deviation needs renewed approval";

/** The approved scope recorded by the latest approval step among the upstream outputs (null for legacy runs). */
export function approvedScopeIn(upstream: Record<string, { output: any; status?: string }>): ApprovedScope | null {
  let found: ApprovedScope | null = null;
  for (const u of Object.values(upstream)) if ((!u.status || u.status === "COMPLETED") && u.output?.approved_scope?.proposal_hash) found = u.output.approved_scope;
  return found;
}

const SOURCE_LABELS: Record<string, string> = {
  get_production_errors: "production logs/errors (platform.get_production_errors)",
  search_code: "code search (platform.search_code)",
  find_dependencies: "dependency graph (platform.find_dependencies)",
  get_repository_metadata: "repository metadata (platform.get_repository_metadata)",
};
/** Evidence sources the platform could not reach while preparing this attempt's context. */
export function unavailableSources(pack: { entries: Array<{ id: string }> } | undefined | null): string[] {
  return (pack?.entries ?? []).filter((e) => e.id.startsWith("unavailable:")).map((e) => SOURCE_LABELS[e.id.slice(12)] ?? e.id.slice(12));
}
