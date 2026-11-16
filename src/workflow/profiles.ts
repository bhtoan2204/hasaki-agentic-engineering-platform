import { ancestors, downstream, topoOrder } from "./graph.ts";
import type { StepSpec, WorkflowSpec } from "./types.ts";

/**
 * Adaptive execution profiles (pure, deterministic).
 *   FAST     small, well-scoped, low-risk change in one known repository: analysis + planning are folded into the coding
 *            session, plan approvals and post-implementation AI review are dropped; discovery is deterministic; tests,
 *            the PR approval gate and the Task Result Report stay.
 *   STANDARD the published workflow as is (default and fallback).
 *   DEEP     high-risk / multi-repository work: the full workflow, no auto-approvals, AI-assisted discovery.
 * Never mutates the published definition: the resolved graph is computed at run creation and stored on the run.
 */
export type Profile = "FAST" | "STANDARD" | "DEEP";
export type ProfileChoice = Profile | "AUTO";

export interface ProfileSignals {
  title: string;
  description: string;
  project: string;
  /** Repositories chosen explicitly or reused from an earlier run of the same work item. */
  repositories: string[];
  /** Deterministic discovery result: the single unambiguous top repository, if any. */
  knownRepository: string | null;
  /** Number of repositories that match the request with a positive score. */
  matchingRepositories: number;
  /** Explicit risk declared on the work item / run inputs ("low" | "medium" | "high"). */
  declaredRisk?: string | null;
}

export interface ProfileDecision {
  profile: Profile;
  requested: ProfileChoice;
  confidence: "high" | "medium" | "low";
  reasons: string[];
  warnings: string[];
  signals: Record<string, unknown>;
}

// Business areas that must never be fast-tracked automatically.
const HIGH_RISK = /\b(payment|refund|money|cod|settlement|reconcil\w*|wallet|invoice|financ\w*|ledger|charge|payout|migration|migrate|schema|alter table|drop table|transaction|outbox|saga|distributed|idempoten\w*|security|auth\w*|permission|token|password|secret|pii|encrypt\w*|gdpr)\b|thanh toán|hoàn tiền|đối soát|tiền|ví điện tử|hoá đơn|hóa đơn|giao dịch|bảo mật|phân quyền|mã hoá|mã hóa|cơ sở dữ liệu|di trú dữ liệu/i;
const MULTI = /\b(multi[- ]?repo|across services|cross[- ]service|nhiều repo|nhiều service|all services)\b/i;
const BIG = /\[(epic|story)\]|\b(epic|refactor\w*|redesign|rewrite|tái cấu trúc|kiến trúc|architecture|new (service|module|feature))\b/i;
// Narrow, local change shapes (mapping/field/format/display/validation issues).
const SMALL = /\b(mapping|map|field|typo|label|format|postal|zip|null|empty|rename|validation|validate|display|missing|wrong value|parse|normali[sz]\w*|whitespace|trim)\b|trường|hiển thị|thiếu|sai (định dạng|format|giá trị)|ánh xạ|chính tả|chuẩn ho[áa]|khoảng trắng/i;
const BUG = /\[bug\]|\b(bug|fix|hotfix|error|incorrect)\b|lỗi|sửa/i;

export function classifyProfile(s: ProfileSignals, requested: ProfileChoice = "AUTO"): ProfileDecision {
  const text = `${s.title}\n${s.description}`;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const highRisk = text.match(HIGH_RISK)?.[0] ?? null;
  const repos = s.repositories.length ? s.repositories : s.knownRepository ? [s.knownRepository] : [];
  const signals = {
    high_risk_term: highRisk,
    multi_repo_terms: MULTI.test(text),
    big_change_terms: text.match(BIG)?.[0] ?? null,
    small_change_terms: text.match(SMALL)?.[0] ?? null,
    bug_terms: text.match(BUG)?.[0] ?? null,
    repositories: repos,
    matching_repositories: s.matchingRepositories,
    declared_risk: s.declaredRisk ?? null,
  };
  if (requested !== "AUTO") {
    if (requested === "FAST" && (highRisk || s.declaredRisk === "high")) warnings.push(`FAST forced on a high-risk task (${highRisk ?? "declared high risk"}); PR approval and tests still apply`);
    if (requested === "FAST" && repos.length > 1) warnings.push("FAST forced with several repositories");
    return { profile: requested, requested, confidence: "high", reasons: [`selected manually: ${requested}`], warnings, signals };
  }
  if (s.declaredRisk === "high") return { profile: "DEEP", requested, confidence: "high", reasons: ["risk declared high"], warnings, signals };
  if (repos.length > 1 || signals.multi_repo_terms) return { profile: "DEEP", requested, confidence: "high", reasons: [repos.length > 1 ? `${repos.length} repositories involved` : "request mentions several repositories/services"], warnings, signals };
  if (signals.big_change_terms) return { profile: "DEEP", requested, confidence: "medium", reasons: [`large-change signal: "${signals.big_change_terms}"`], warnings, signals };
  if (highRisk) {
    reasons.push(`high-risk area "${highRisk}" — never fast-tracked automatically`);
    return { profile: "STANDARD", requested, confidence: "high", reasons, warnings, signals };
  }
  const known = repos.length === 1;
  if (known && signals.small_change_terms && (signals.bug_terms || s.declaredRisk === "low")) {
    reasons.push(`one known repository (${repos[0]})`, `narrow change signal: "${signals.small_change_terms}"`, signals.bug_terms ? `bug fix ("${signals.bug_terms}")` : "risk declared low", "no high-risk business area");
    return { profile: "FAST", requested, confidence: s.repositories.length === 1 ? "high" : "medium", reasons, warnings, signals };
  }
  reasons.push(
    !known ? "affected repository not known with confidence" : !signals.small_change_terms ? "no narrow-change signal" : "not identified as a bug fix",
    "safe default: STANDARD",
  );
  return { profile: "STANDARD", requested, confidence: "low", reasons, warnings, signals };
}

export const COMPLEXITY_CLASSES = ["TRIVIAL", "STANDARD", "COMPLEX", "HIGH_RISK"] as const;
export type ComplexityClass = (typeof COMPLEXITY_CLASSES)[number];
export interface ComplexityDecision {
  class: ComplexityClass;
  source: "derived" | "user_override";
  reasons: string[];
  /** Always shown: a class is an execution hint from request signals, not a guarantee of the real task complexity. */
  disclaimer: string;
}

/**
 * Deterministic execution class for a run (no model call): request signals from the profile decision plus the work
 * item's verified history (repeated failure categories in earlier outcomes). A user override wins and is recorded.
 * HIGH_RISK keeps strict verification and human approval whatever the cost; TRIVIAL only marks work that the
 * deterministic platform steps can carry with minimal agent context.
 */
export function classifyComplexity(d: Pick<ProfileDecision, "profile" | "confidence" | "signals">, history: { priorFailureRuns: number } = { priorFailureRuns: 0 }, override?: unknown): ComplexityDecision {
  const disclaimer = "classification from request signals and history; not a guarantee of actual task complexity";
  const o = String(override ?? "").toUpperCase();
  if ((COMPLEXITY_CLASSES as readonly string[]).includes(o)) return { class: o as ComplexityClass, source: "user_override", reasons: [`set by the user: ${o}`], disclaimer };
  const sig = d.signals as any;
  if (sig.high_risk_term || sig.declared_risk === "high") return { class: "HIGH_RISK", source: "derived", reasons: [sig.high_risk_term ? `high-risk business area "${sig.high_risk_term}"` : "risk declared high"], disclaimer };
  if (d.profile === "DEEP") return { class: "COMPLEX", source: "derived", reasons: ["deep profile: several repositories or a large change"], disclaimer };
  if (history.priorFailureRuns >= 2) return { class: "COMPLEX", source: "derived", reasons: [`${history.priorFailureRuns} earlier runs of this work item had verified failure categories`], disclaimer };
  if (d.profile === "FAST" && d.confidence === "high") return { class: "TRIVIAL", source: "derived", reasons: ["one known repository, narrow low-risk change"], disclaimer };
  return { class: "STANDARD", source: "derived", reasons: ["no high-risk, multi-repository or narrow-change signal"], disclaimer };
}

export interface ProfileChange {
  step: string;
  action: "merged_into" | "removed" | "modified";
  into?: string;
  detail: string;
}

/** Remove a step, rewiring its dependants to its own dependencies (transitively, deduplicated). */
function removeStep(steps: StepSpec[], key: string): StepSpec[] {
  const gone = steps.find((s) => s.key === key)!;
  return steps
    .filter((s) => s.key !== key)
    .map((s) => (s.depends_on.includes(key) ? { ...s, depends_on: [...new Set([...s.depends_on.filter((d) => d !== key), ...gone.depends_on])].filter((d) => d !== s.key) } : s));
}

/**
 * Resolve the execution graph for a profile. Returns the original spec (same object) when nothing changes; throws
 * `ProfileNotApplicable` when FAST would break the workflow (the caller then falls back to STANDARD).
 */
export class ProfileNotApplicable extends Error { }

export function applyProfile(spec: WorkflowSpec, profile: Profile): { spec: WorkflowSpec; changes: ProfileChange[] } {
  const changes: ProfileChange[] = [];
  const clone = (): StepSpec[] => spec.steps.map((s) => ({ ...s, depends_on: [...s.depends_on], config: { ...s.config } }));
  // Reviews after a coding step become independent verifiers (fresh session, no author claims, enforced verdict).
  // STANDARD: unless the workflow opts out (independent: false). DEEP: always, and strict (needs real test evidence).
  // Only steps that ARE reviews (by key/name or a verdict-style output contract) — other downstream agents still need the author's output.
  const looksLikeReview = (s: StepSpec) => /review|verif|audit|\bqa\b/i.test(`${s.key} ${s.name ?? ""}`) || /\b(approved|verdict)\b/.test(String(s.config.output_contract ?? ""));
  const verifierKeys = new Set(spec.steps.filter((s) => s.type === "agent" && looksLikeReview(s) && spec.steps.some((c) => c.type === "coding_agent" && downstream(spec.steps, c.key).has(s.key))).map((s) => s.key));
  const markIndependent = (steps: StepSpec[], strict: boolean) => {
    for (const s of steps) {
      if (!verifierKeys.has(s.key)) continue;
      if (!strict && s.config.independent === false) continue;
      if (s.config.independent === true && !strict) continue;
      s.config.independent = true;
      if (strict) s.config.strict = true;
      changes.push({ step: s.key, action: "modified", detail: strict ? "independent verification required (fresh session, strict: needs test evidence)" : "independent verification (fresh session, verdict enforced before the PR)" });
    }
  };
  if (profile === "STANDARD") {
    if (!verifierKeys.size) return { spec, changes };
    const steps = clone();
    markIndependent(steps, false);
    return { spec: changes.length ? { ...spec, steps } : spec, changes };
  }
  if (profile === "DEEP") {
    const steps = clone();
    markIndependent(steps, true);
    for (const s of steps) {
      if (s.type === "human_approval" && s.config.auto_approve_unambiguous) {
        delete s.config.auto_approve_unambiguous;
        changes.push({ step: s.key, action: "modified", detail: "no auto-approval: repositories are always confirmed by a human" });
      }
      if (s.type === "integration" && s.config.action === "repository_discovery" && !s.config.use_ai) {
        s.config.use_ai = true;
        changes.push({ step: s.key, action: "modified", detail: "AI-assisted repository ranking" });
      }
    }
    return { spec: changes.length ? { ...spec, steps } : spec, changes };
  }

  // FAST
  const order = topoOrder(spec.steps);
  const coding = order.map((k) => spec.steps.find((s) => s.key === k)!).find((s) => s.type === "coding_agent");
  if (!coding) throw new ProfileNotApplicable("workflow has no coding step to fold analysis into");
  // An approval-gated coding step is an optional follow-up (e.g. "fix the review findings"): the analysis before it is
  // the workflow's purpose, not a preamble FAST may fold away.
  if (coding.requires_approval) throw new ProfileNotApplicable(`coding step "${coding.key}" is an optional, approval-gated follow-up; its upstream analysis is the workflow's purpose`);
  const anc = ancestors(spec.steps, coding.key);
  const merged = spec.steps.filter((s) => anc.has(s.key) && s.type === "agent");
  const planApprovals = spec.steps.filter((s) => anc.has(s.key) && s.type === "human_approval" && !s.config.select_repositories);
  const reviews = spec.steps.filter((s) => downstream(spec.steps, coding.key).has(s.key) && s.type === "agent");
  // A configured agent boundary carries provider, permissions and verification semantics that cannot be folded away.
  const configured = [...merged, ...reviews].find(s => s.config.agent != null && Object.keys(s.config.agent as object).length > 0);
  if (configured) throw new ProfileNotApplicable(`step "${configured.key}" has explicit agent configuration; preserve its execution boundary`);
  const removed = new Set([...merged, ...planApprovals, ...reviews].map((s) => s.key));
  // A remaining step that branches on (run_if / condition path) a removed step's output would change behaviour: refuse.
  for (const s of spec.steps) {
    if (removed.has(s.key)) continue;
    if (s.run_if && removed.has(s.run_if.step)) throw new ProfileNotApplicable(`step "${s.key}" branches on "${s.run_if.step}", which FAST would remove`);
    if (s.type === "condition" && [...removed].some((r) => String(s.config.path ?? "").includes(`upstream.${r}.`))) throw new ProfileNotApplicable(`condition "${s.key}" reads the output of a step FAST would remove`);
  }
  let steps = clone();
  for (const k of removed) steps = removeStep(steps, k);
  steps = steps.map((s) => {
    if (s.key === coding.key) {
      const phases = merged.map((m, i) => `${i + 1}. ${m.name ?? m.key}: ${String(m.config.instructions ?? "").trim()}`);
      const instructions = [
        `FAST profile — this single session replaces: ${[...merged, ...planApprovals].map((m) => m.name ?? m.key).join(", ") || "nothing"}. Keep each phase short and targeted.`,
        ...phases,
        `${phases.length + 1}. ${coding.name ?? coding.key}: ${String(coding.config.instructions ?? "").trim()}`,
        "Before editing, post a 3–6 line plan with mcp__platform__post_update (the developer reviews the diff before the PR).",
        'In submit_result also include "analysis": { "summary", "root_cause" (if a bug), "files": ["path:line", ...] }.',
      ].join("\n");
      return { ...s, name: `${coding.name ?? coding.key} (analysis + implementation)`, config: { ...s.config, instructions, merged_from: merged.map((m) => m.key), knowledge_index_size: s.config.knowledge_index_size ?? 6 } };
    }
    if (s.type === "integration" && s.config.action === "repository_discovery" && s.config.use_ai) return { ...s, config: { ...s.config, use_ai: false } };
    if (s.type === "human_approval" && s.config.select_repositories && !s.config.auto_approve_unambiguous) return { ...s, config: { ...s.config, auto_approve_unambiguous: true } };
    if (s.type === "human_approval" && Array.isArray(s.config.show_outputs)) return { ...s, config: { ...s.config, show_outputs: s.config.show_outputs.filter((k: string) => !removed.has(k)) } };
    return s;
  });
  for (const m of merged) changes.push({ step: m.key, action: "merged_into", into: coding.key, detail: "analysis folded into the coding session" });
  for (const a of planApprovals) changes.push({ step: a.key, action: "removed", detail: "plan approval skipped (diff is still reviewed before the PR)" });
  for (const r of reviews) changes.push({ step: r.key, action: "removed", detail: "separate AI review skipped (tests + PR approval remain)" });
  for (const s of steps) {
    const before = spec.steps.find((x) => x.key === s.key)!;
    if (s.type === "integration" && before.config.use_ai && !s.config.use_ai) changes.push({ step: s.key, action: "modified", detail: "deterministic repository discovery (no Claude call)" });
    if (s.type === "human_approval" && s.config.auto_approve_unambiguous && !before.config.auto_approve_unambiguous) changes.push({ step: s.key, action: "modified", detail: "auto-approved when the repository is unambiguous" });
  }
  return { spec: { ...spec, steps, feedback_step: spec.feedback_step && removed.has(spec.feedback_step) ? coding.key : spec.feedback_step }, changes };
}
