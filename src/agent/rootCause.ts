import type { RunRow, StepRow } from "../workflow/types.ts";
import { detectRisk, evidenceRole, evidenceSummary } from "./evidence.ts";
import type { Finding, VerdictOutput } from "./independentReview.ts";

/**
 * Root Cause First policy (provider-agnostic, versioned). One definition feeds every provider through the system
 * prompt (stepPrompt.buildSystemAppend), and the platform enforces it deterministically where it can:
 *   - symptomFixSignals: diff patterns that usually hide a defect instead of fixing it (computed by the verify stage);
 *   - normalizeRemediation: the implementer's classification of what the change is (root-cause fix, mitigation, …);
 *   - enforceRootCauseReview: an independent PASS is downgraded when signals are unjustified, the remediation is
 *     misclassified, or the root cause is not established. Downgrades only — the platform never upgrades a verdict.
 * The semantic judgement (is a signal justified, does the diff remove the cause) stays with the independent reviewer.
 */

export const ROOT_CAUSE_POLICY_VERSION = "2026-11-18.1";

export type RcaDepth = "light" | "standard" | "strict";
const DEPTHS: readonly RcaDepth[] = ["light", "standard", "strict"];

export const REMEDIATION_KINDS = [
  "ROOT_CAUSE_FIX",
  "PARTIAL_FIX",
  "MITIGATION",
  "OBSERVABILITY_CORRECTION",
  "UNRESOLVED",
] as const;
export type RemediationKind = (typeof REMEDIATION_KINDS)[number];

// Payment, concurrency, security and data-integrity work gets the strict depth.
export const STRICT_DOMAIN =
  /\b(payment|refund|payout|settle|reconcil|balance|wallet|invoice|amount|price|inventory|stock|concurren|race|deadlock|lock|idempoten|duplicate|double|security|auth[nz]?|permission|token|secret|encrypt|data[\s-]?integrity|migration|consistency)\w*|thanh toán|hoàn tiền|tồn kho|hóa đơn|trùng/i;

/**
 * How deep the Root Cause First policy applies to a run. `light` (features, refactors, micro changes): guardrails
 * only, no RCA artifact. `standard` (defect/incident workflows: an evidence-gated step in the graph, or an
 * investigation handed over): causal analysis, remediation classification, regression evidence. `strict`: standard on a
 * payment / concurrency / security / data-integrity subject. A step or workflow may pin it with `root_cause_depth`.
 */
export function rootCauseDepth(
  run: Pick<RunRow, "graph" | "inputs" | "title" | "profile">,
  step?: Pick<StepRow, "config"> | null,
): RcaDepth {
  const pinned =
    step?.config?.root_cause_depth ??
    (run.graph as { root_cause_depth?: unknown } | undefined)?.root_cause_depth;
  if (DEPTHS.includes(pinned)) return pinned;
  if (run.profile === "MICRO") return "light";
  const defect =
    (run.graph?.steps ?? []).some((s) => evidenceRole(s.config)) || !!run.inputs?.investigation;
  if (!defect) return "light";
  const texts = [
    run.title,
    String(run.inputs?.description ?? ""),
    String(run.inputs?.summary ?? ""),
  ];
  return texts.some((t) => STRICT_DOMAIN.test(t)) || detectRisk(texts).risk === "HIGH"
    ? "strict"
    : "standard";
}

export type PolicyRole = "investigate" | "implement" | "review";

const GUARDRAILS =
  "Never use these as a stand-in for fixing a defect: lowering a log level (ERROR → WARN/INFO/DEBUG) to reduce reported errors; removing logs, metrics, traces or alerts of an unresolved failure; " +
  "swallowing an error or returning success for a failed operation; a silent fallback that hides wrong behaviour; raising a timeout, retry count or resource limit without evidence; " +
  "deleting or weakening a test or assertion; disabling validation, authorization, security checks or business invariants; unsafe casts, suppression directives or defensive code that hides a defect; " +
  "bypassing verification or changing completion criteria. Any of these is acceptable only when the expected system behaviour independently requires it and you cite the evidence.";

const REMEDIATION_CONTRACT =
  "remediation: { kind: 'ROOT_CAUSE_FIX'|'PARTIAL_FIX'|'MITIGATION'|'OBSERVABILITY_CORRECTION'|'UNRESOLVED', root_cause, causal_link (how the change removes the cause), " +
  "regression_test?: { name (an executable test id: Go <module>/<package>/TestName or <repo>::test/file.test.ts — the platform runs it on the pre-fix source and on your commit; your booleans are not evidence), fails_before: boolean|null, passes_after: boolean|null }, verification_limitations?, unresolved_cause?, risks?: string[], follow_ups?: string[], " +
  "justifications?: [{ signal, reason, evidence }] }";

const RCA_CONTRACT =
  "rca: { symptom, expected, actual, triggering_conditions, execution_path: string[], contributing_factors: string[], reproduction: { attempted: boolean, result }, uncertainties: string[] }";

const REVIEW_CHECK =
  "root_cause_check: { remediation_kind (the kind the diff actually is — never upgrade the author's), addresses_root_cause: boolean, symptom_only_changes: [{ file, line, explanation }], " +
  "justified_signals: [{ signal, justification }] (one per platform symptom-fix signal you accept), observability_reduced: boolean, regression_test_demonstrates_fix: boolean|null, limitations? }";

/** System-prompt lines for this depth and role; empty when the policy does not apply. One source for every provider. */
export function rootCausePolicy(depth: RcaDepth, role: PolicyRole | null): string[] {
  if (!role || (depth === "light" && role === "investigate")) return [];
  const head = `## Root Cause First (policy ${ROOT_CAUSE_POLICY_VERSION}, depth ${depth})`;
  if (depth === "light")
    return [
      "",
      head,
      `- ${GUARDRAILS}`,
      ...(role === "review"
        ? [
            `- When the platform lists symptom-fix signals for this diff, add root_cause_check: { justified_signals: [{ signal, justification }], symptom_only_changes: [] } to submit_result; an unjustified signal turns a PASS into FAIL.`,
          ]
        : []),
    ];
  const strict =
    depth === "strict"
      ? " This is a payment / concurrency / security / data-integrity subject: state the business invariants the change preserves and cover the failure scenarios (retry, partial failure, duplicate delivery, concurrent access) in tests."
      : "";
  const common = [
    "",
    head,
    "- Separate the symptom, the triggering conditions, contributing factors and the root cause. Trace the failure through the execution path, callers, dependencies, state transitions and data flow, and know the expected business behaviour before changing code.",
    "- Form hypotheses from evidence and confirm or rule each out before fixing; prefer the smallest correct fix at the source of the defect, and check the same defect elsewhere in scope. Reuse the evidence of earlier steps (evidence_summary, get_step_output) instead of re-investigating the same path.",
    "- When the root cause cannot be established, say so: never invent one, and do not present a mitigation as a permanent fix.",
    `- ${GUARDRAILS}`,
  ];
  if (role === "investigate")
    return [
      ...common,
      `- Include ${RCA_CONTRACT} in submit_result. Separate confirmed facts from hypotheses; when evidence is insufficient, investigate further or ask instead of guessing.${strict}`,
    ];
  if (role === "implement")
    return [
      ...common,
      `- Include ${REMEDIATION_CONTRACT} in submit_result. Classify honestly: MITIGATION needs unresolved_cause, risks and follow_ups; ROOT_CAUSE_FIX needs an established root cause. ` +
        "When feasible, add a regression test that fails on the old code and passes on the fix, asserting behaviour (not log output); otherwise state verification_limitations. " +
        `Explain every symptom-fix pattern you keep in justifications.${strict}`,
    ];
  return [
    ...common,
    `- Judge whether the diff removes the cause or only its symptom; a build, passing tests or fewer errors are not evidence of a correct fix. Include ${REVIEW_CHECK} in submit_result. ` +
      "List symptom-only changes as findings and FAIL; BLOCKED when the root cause is not established and the change is presented as a fix." +
      strict,
  ];
}

/** The role a step plays for the policy, from its mode and config. */
export function policyRole(
  mode: "coding" | string,
  cfg: Record<string, unknown> | undefined,
): PolicyRole | null {
  if (cfg?.independent === true) return "review";
  if (mode === "coding") return "implement";
  return evidenceRole(cfg) ? "investigate" : null;
}

// ---------------------------------------------------------------- deterministic signals

export type SignalKind =
  | "log_downgrade"
  | "observability_removed"
  | "limit_raised"
  | "suppression_added"
  | "check_removed"
  | "retry_added"
  | "error_swallowed";

export interface SymptomSignal {
  kind: SignalKind;
  file: string;
  line: number;
  detail: string;
}

const ERROR_LOG =
  /\b(?:log|logger|logging|zap|slog|console|l|lg|sugar|klog|glog)\w*\s*\.\s*(?:Error|Errorf|Errorw|Errorln|DPanic\w*|Fatal\w*|Panic\w*|error|fatal|critical|exception)\s*\(|\blevel\s*[:=]\s*["']?(?:error|fatal|critical)\b/i;
const LOWER_LOG =
  /\b(?:log|logger|logging|zap|slog|console|l|lg|sugar|klog|glog)\w*\s*\.\s*(?:Warn\w*|Info\w*|Debug\w*|Trace\w*|Print\w*|warn|warning|info|debug|trace|log)\s*\(|\blevel\s*[:=]\s*["']?(?:warn|warning|info|debug|trace)\b/i;
const TELEMETRY =
  /\b(?:metrics?|counter|histogram|gauge|prometheus|statsd|otel|tracer|span|sentry|alert|newrelic|datadog)\w*(?:\s*\.\s*\w+)*?\s*\.\s*(?:Inc|Add|Observe|Record\w*|Set\w*|Capture\w*|Notify|Emit|Send|Error|Status)\w*\s*\(/i;
const LIMIT_LINE = /(?:timeout|deadline|retr(?:y|ies)|attempts?|backoff|max\w*|limit|pool|ttl)\w*/i;
const SUPPRESSION =
  /@ts-ignore|@ts-expect-error|eslint-disable|\/\/\s*nolint|\/\/\s*lint:ignore|#\s*type:\s*ignore|#\s*noqa|pylint:\s*disable|@SuppressWarnings|#nosec|\bas\s+any\b|\bas\s+unknown\s+as\b|\/\/\s*@ts-nocheck/;
const CHECK =
  /\b(?:if|return|throw|assert|require|guard|unless)\b.*\b(?:(?:is|has)?valid\w*|validate\w*|authori[sz]\w*|permission\w*|allowed|forbidden|isAdmin|verify\w*|check\w*Permission|invariant\w*|ErrInvalid\w*|ErrForbidden\w*|ErrUnauthori[sz]ed\w*)/i;
/** A retry/backoff construct (library, decorator, loop or option); a numeric change of an existing one is limit_raised. */
const RETRY =
  /\b(?:with_?[Rr]etry|retry(?:When|On|Async)?|backoff\w*)\s*\(|@Retryable\b|@retry\b|\btenacity\b|['"](?:p-retry|async-retry)['"]|\bnew\s+Retry(?:Template|Policy)\b|\bfor\s+(?:attempt|retry|try)\w*\b|\bfor\s+\w+\s*:?=\s*0\s*;\s*\w+\s*<\s*\w*(?:retr|attempt)\w*/;
/** One-line catch-and-continue: an empty catch/except body or a handler that returns a success value. */
const SWALLOW_LINE =
  /catch\s*(?:\([^)]*\))?\s*\{\s*(?:return\s*(?:null|undefined|true|false|nil|\{\}|\[\]|0|""|'')?\s*;?\s*)?\}|\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*\}|null|undefined|\[\]|\{\s*\}|true|false)\s*\)|\bexcept\b(?:\s*\(?\s*(?:Base)?Exception\b[^:]*)?:\s*(?:pass|return(?:\s+None)?|continue)\s*$|if\s+err\s*!=\s*nil\s*\{\s*return(?:\s+nil)?\s*\}|^\s*_\s*=\s*err\s*$/;
/** A handler opening whose next added line silently continues (multi-line form of SWALLOW_LINE). */
const HANDLER_OPEN =
  /(?:\bcatch\s*(?:\([^)]*\))?\s*\{|\bexcept\b(?:\s*\(?\s*(?:Base)?Exception\b[^:]*)?:|if\s+err\s*!=\s*nil\s*\{)\s*$/;
const SILENT_BODY =
  /^\s*(?:pass|continue;?|return(?:\s+(?:nil|null|None|undefined|true|\{\}|\[\]))?;?|\})\s*$/;
const TEST_PATH =
  /(^|\/)(test|tests|__tests__|testdata)\/|_test\.go$|\.(test|spec)\.[cm]?[jt]sx?$|_test\.py$|Test\.java$/;
const COMMENT = /^\s*(?:\/\/|#|\*|\/\*|--)/;

const firstLiteral = (s: string) => s.match(/(["'`])((?:\\.|(?!\1).){3,})\1/)?.[2]?.trim() ?? "";
const normalized = (s: string) => s.replace(/\s+/g, " ").trim();
const withoutNumbers = (s: string) => normalized(s).replace(/\d+(?:\.\d+)?/g, "#");
const numbers = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);

interface Hunk {
  file: string;
  removed: Array<{ text: string; line: number }>;
  added: Array<{ text: string; line: number }>;
}

function hunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let file = "";
  let cur: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      cur = null;
      file = raw.replace(/^diff --git a\/.* b\//, "");
      continue;
    }
    if (raw.startsWith("+++ ")) {
      if (raw !== "+++ /dev/null") file = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    const at = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (at) {
      oldLine = Number(at[1]);
      newLine = Number(at[2]);
      cur = { file, removed: [], added: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("-")) cur.removed.push({ text: raw.slice(1), line: oldLine++ });
    else if (raw.startsWith("+")) cur.added.push({ text: raw.slice(1), line: newLine++ });
    else {
      oldLine++;
      newLine++;
    }
  }
  return out;
}

/**
 * Symptom-fix patterns in a unified diff (source files; test weakening has its own check in verify.ts). Language-neutral
 * text heuristics: they flag a change for justification, they do not decide it is wrong — the reviewer does.
 */
export function symptomFixSignals(diff: string, max = 30): SymptomSignal[] {
  const out: SymptomSignal[] = [];
  const add = (s: SymptomSignal) => {
    if (
      out.length < max &&
      !out.some((o) => o.kind === s.kind && o.file === s.file && o.line === s.line)
    )
      out.push(s);
  };
  const byFile = new Map<string, Hunk[]>();
  for (const h of hunks(diff)) {
    if (!h.file || TEST_PATH.test(h.file)) continue;
    byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
  }
  for (const [file, hs] of byFile) {
    const removedAll = hs.flatMap((h) => h.removed).filter((r) => !COMMENT.test(r.text));
    const addedAll = hs.flatMap((h) => h.added).filter((a) => !COMMENT.test(a.text));
    const addedSet = new Set(addedAll.map((a) => normalized(a.text)));
    const addedErrorLogs = addedAll.filter((a) => ERROR_LOG.test(a.text));
    const lowered = new Set<number>();
    for (const h of hs) {
      const added = h.added.filter((a) => !COMMENT.test(a.text));
      for (const r of h.removed.filter((x) => !COMMENT.test(x.text) && ERROR_LOG.test(x.text))) {
        const lit = firstLiteral(r.text);
        const twin =
          added.find((a) => LOWER_LOG.test(a.text) && (!lit || firstLiteral(a.text) === lit)) ??
          (lit
            ? addedAll.find((a) => LOWER_LOG.test(a.text) && firstLiteral(a.text) === lit)
            : undefined);
        if (!twin) continue;
        lowered.add(r.line);
        add({
          kind: "log_downgrade",
          file,
          line: twin.line,
          detail: `error-level log lowered: "${normalized(r.text).slice(0, 100)}" → "${normalized(twin.text).slice(0, 100)}"`,
        });
      }
      for (const r of h.removed.filter((x) => !COMMENT.test(x.text) && LIMIT_LINE.test(x.text))) {
        const twin = added.find(
          (a) =>
            withoutNumbers(a.text) === withoutNumbers(r.text) &&
            normalized(a.text) !== normalized(r.text),
        );
        if (!twin) continue;
        const before = numbers(r.text);
        const after = numbers(twin.text);
        if (before.length === after.length && after.some((n, i) => n > before[i]))
          add({
            kind: "limit_raised",
            file,
            line: twin.line,
            detail: `limit raised: "${normalized(r.text).slice(0, 100)}" → "${normalized(twin.text).slice(0, 100)}"`,
          });
      }
    }
    // A reworded error log (one removed, one added) is not a removal.
    let reworded = addedErrorLogs.filter(
      (a) => !removedAll.some((r) => normalized(r.text) === normalized(a.text)),
    ).length;
    for (const r of removedAll) {
      const isErrorLog = ERROR_LOG.test(r.text);
      if (!isErrorLog && !TELEMETRY.test(r.text)) continue;
      if (addedSet.has(normalized(r.text)) || lowered.has(r.line)) continue;
      if (isErrorLog && reworded > 0) {
        reworded--;
        continue;
      }
      add({
        kind: "observability_removed",
        file,
        line: r.line,
        detail: `${isErrorLog ? "error log" : "telemetry"} removed: "${normalized(r.text).slice(0, 120)}"`,
      });
    }
    for (const a of addedAll)
      if (SUPPRESSION.test(a.text))
        add({
          kind: "suppression_added",
          file,
          line: a.line,
          detail: `suppression added: "${normalized(a.text).slice(0, 120)}"`,
        });
    // A retry/backoff construct with no counterpart among the removed lines (a changed count is limit_raised).
    const removedShapes = new Set(removedAll.map((r) => withoutNumbers(r.text)));
    const retry = addedAll.find(
      (a) => RETRY.test(a.text) && !removedShapes.has(withoutNumbers(a.text)),
    );
    if (retry && !removedAll.some((r) => RETRY.test(r.text)))
      add({
        kind: "retry_added",
        file,
        line: retry.line,
        detail: `retry/backoff added: "${normalized(retry.text).slice(0, 120)}" — show the failure is transient and retryable`,
      });
    // Errors handled by continuing silently (empty handler, or one returning a success value).
    for (const h of hs) {
      const added = h.added.filter((a) => !COMMENT.test(a.text));
      for (const [i, a] of added.entries()) {
        const next = added[i + 1];
        // Unchanged handler lines are not new; a handler whose body changed to a silent one is.
        const oneLine = SWALLOW_LINE.test(a.text) && !removedShapes.has(withoutNumbers(a.text));
        const twoLines =
          !oneLine &&
          HANDLER_OPEN.test(a.text) &&
          !!next &&
          next.line === a.line + 1 &&
          SILENT_BODY.test(next.text) &&
          !removedShapes.has(withoutNumbers(next.text));
        if (oneLine || twoLines)
          add({
            kind: "error_swallowed",
            file,
            line: a.line,
            detail: `error handled by continuing silently: "${normalized(a.text).slice(0, 80)}${twoLines ? ` ${normalized(next!.text).slice(0, 40)}` : ""}"`,
          });
      }
    }
    for (const r of removedAll)
      if (CHECK.test(r.text) && !addedSet.has(normalized(r.text)))
        add({
          kind: "check_removed",
          file,
          line: r.line,
          detail: `validation/authorization check removed: "${normalized(r.text).slice(0, 120)}"`,
        });
  }
  return out;
}

// ---------------------------------------------------------------- remediation

export interface Remediation {
  kind: RemediationKind | null;
  root_cause: string;
  causal_link: string;
  regression_test: {
    name: string;
    fails_before: boolean | null;
    passes_after: boolean | null;
  } | null;
  verification_limitations: string;
  unresolved_cause: string;
  risks: string[];
  follow_ups: string[];
  justifications: Array<{ signal: string; reason: string; evidence: string }>;
  /** Platform notes: what is missing or inconsistent. Never edited by agents. */
  problems: string[];
}

const str = (v: unknown, n = 600) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const strs = (v: unknown, n = 10) =>
  (Array.isArray(v) ? v : [])
    .map((x) => str(typeof x === "string" ? x : JSON.stringify(x), 300))
    .filter(Boolean)
    .slice(0, n);
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
type Loose = Record<string, unknown>;
const loose = (v: unknown): Loose | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : null;

/** Normalize the implementer's remediation. Missing parts become `problems`; nothing is inferred or upgraded. */
export function normalizeRemediation(raw: unknown, depth: RcaDepth): Remediation | null {
  const o = loose(raw);
  if (!o)
    return depth === "light"
      ? null
      : { ...EMPTY, problems: ["remediation classification missing"] };
  const kind = (REMEDIATION_KINDS as readonly string[]).includes(o.kind as string)
    ? (o.kind as RemediationKind)
    : null;
  const t = loose(o.regression_test);
  const r: Remediation = {
    kind,
    root_cause: str(o.root_cause),
    causal_link: str(o.causal_link),
    regression_test: t
      ? {
          name: str(t.name, 200),
          fails_before: bool(t.fails_before),
          passes_after: bool(t.passes_after),
        }
      : null,
    verification_limitations: str(o.verification_limitations),
    unresolved_cause: str(o.unresolved_cause),
    risks: strs(o.risks),
    follow_ups: strs(o.follow_ups),
    justifications: (Array.isArray(o.justifications) ? o.justifications : [])
      .map((j: unknown) => ({
        signal: str(loose(j)?.signal, 200),
        reason: str(loose(j)?.reason),
        evidence: str(loose(j)?.evidence),
      }))
      .filter((j: { signal: string; reason: string }) => j.signal && j.reason)
      .slice(0, 30),
    problems: [],
  };
  if (!kind)
    r.problems.push(`unknown remediation kind ${JSON.stringify(o.kind ?? null).slice(0, 40)}`);
  if (kind === "MITIGATION" && (!r.unresolved_cause || !r.risks.length || !r.follow_ups.length))
    r.problems.push(
      "a MITIGATION must state the unresolved cause, its risks and the follow-up actions",
    );
  if (kind === "ROOT_CAUSE_FIX" && (!r.root_cause || !r.causal_link))
    r.problems.push("a ROOT_CAUSE_FIX must name the root cause and how the change removes it");
  if (
    depth !== "light" &&
    (kind === "ROOT_CAUSE_FIX" || kind === "PARTIAL_FIX") &&
    !(r.regression_test?.passes_after === true) &&
    !r.verification_limitations
  )
    r.problems.push(
      "no regression test demonstrating the fix and no stated verification limitation",
    );
  return r;
}
const EMPTY: Remediation = {
  kind: null,
  root_cause: "",
  causal_link: "",
  regression_test: null,
  verification_limitations: "",
  unresolved_cause: "",
  risks: [],
  follow_ups: [],
  justifications: [],
  problems: [],
};

// ---------------------------------------------------------------- review gate

type Upstream = Record<string, { output: unknown; status?: string }>;

/** Platform-computed signals and the implementer's remediation recorded by the coding steps upstream. */
export function codingEvidence(upstream: Upstream) {
  const signals: Array<SymptomSignal & { repo: string }> = [];
  let remediation: Remediation | null = null;
  let coded = false;
  let proof: RegressionProof | null = null;
  const tested: Record<string, string> = {};
  for (const u of Object.values(upstream)) {
    const o = loose(u?.output);
    if (!o) continue;
    if (o.verification) coded = true;
    if (loose(o.regression_proof)) proof = o.regression_proof as RegressionProof;
    Object.assign(tested, loose(o.tested_heads) ?? {});
    for (const [repo, list] of Object.entries(loose(o.symptom_signals) ?? {}))
      for (const s of Array.isArray(list) ? list : [])
        signals.push({ ...(s as SymptomSignal), repo });
    if (loose(o.remediation)) remediation = o.remediation as Remediation;
  }
  return { signals, remediation, coded, proof, tested };
}

/**
 * Platform-run before/after regression evidence (verify.ts beforeAfterProof): the same test executed on the pre-fix
 * source (the fix's non-test files reverted in a throw-away worktree) and on the fixed commit. Author booleans are not it.
 */
export interface RegressionProof {
  status: "verified" | "invalid" | "unmeasured";
  reason: string;
  repo?: string;
  test_id?: string;
  base_sha?: string;
  head_sha?: string;
  reverted_files?: string[];
  command?: string;
  before?: string;
  after?: string;
}

/** Why a proof does not count, or null when it does: wrong result, or measured on another commit than the one tested. */
export function proofProblem(proof: RegressionProof | null, tested: Record<string, string>) {
  if (!proof) return "no platform-run regression proof";
  if (proof.status !== "verified") return `regression proof ${proof.status}: ${proof.reason}`;
  const head = proof.repo ? tested[proof.repo] : undefined;
  if (head && proof.head_sha !== head)
    return `regression proof is stale: measured on ${String(proof.head_sha).slice(0, 12)}, tested commit is ${head.slice(0, 12)}`;
  return null;
}

/** A signal is justified when the reviewer accepted it (or the author justified it and the reviewer did not reject). */
function justified(s: SymptomSignal & { repo?: string }, entries: Array<{ signal?: unknown }>) {
  return entries.some((j) => {
    const t = String(j?.signal ?? "");
    return t.includes(s.file) && (t.includes(s.kind) || t.includes(String(s.line)));
  });
}

const finding = (
  file: string,
  line: number | null,
  explanation: string,
  evidence: string,
): Finding => ({
  severity: "high",
  file,
  line,
  explanation,
  evidence,
});

/**
 * Root Cause First gate on an independent verdict. Only a PASS is examined, and it can only go down:
 *   FAIL (repairable, findings go back to the implementer): an unjustified symptom-fix signal, symptom-only changes or
 *     a root cause the reviewer says is not addressed, a missing or incomplete remediation classification;
 *   BLOCKED (needs evidence or a human): a change presented as a ROOT_CAUSE_FIX while the investigation never
 *     established the root cause, or a defect-depth PASS without the reviewer's root_cause_check.
 * The final remediation kind is recorded on the verdict and is never upgraded beyond what the author declared.
 */
export function enforceRootCauseReview(
  v: VerdictOutput,
  raw: unknown,
  upstream: Upstream,
  depth: RcaDepth,
): VerdictOutput & { root_cause_check?: unknown; remediation_kind?: RemediationKind | null } {
  const c = loose(raw);
  const { signals, remediation, coded, proof, tested } = codingEvidence(upstream);
  const declared = remediation?.kind ?? null;
  const reviewed = (REMEDIATION_KINDS as readonly string[]).includes(c?.remediation_kind as string)
    ? (c!.remediation_kind as RemediationKind)
    : null;
  // Never upgrade: the weaker of what the author declared and what the reviewer saw.
  const order = [
    "UNRESOLVED",
    "MITIGATION",
    "OBSERVABILITY_CORRECTION",
    "PARTIAL_FIX",
    "ROOT_CAUSE_FIX",
  ];
  const kind =
    declared && reviewed
      ? order.indexOf(reviewed) < order.indexOf(declared)
        ? reviewed
        : declared
      : (declared ?? reviewed);
  const out = { ...v, ...(c ? { root_cause_check: c } : {}), remediation_kind: kind };
  if (v.verdict !== "PASS") return out;
  const fail = (findings: Finding[], why: string) => ({
    ...out,
    verdict: "FAIL" as const,
    findings: [...v.findings, ...findings],
    summary: [v.summary, `Root Cause First: ${why}`].filter(Boolean).join(" — "),
  });
  const blocked = (reason: string) => ({
    ...out,
    verdict: "BLOCKED" as const,
    blocked_reason: reason,
  });

  const accepted = Array.isArray(c?.justified_signals)
    ? (c.justified_signals as Array<{ signal?: unknown }>)
    : [];
  const unjustified = signals.filter((s) => !justified(s, accepted));
  if (unjustified.length)
    return fail(
      unjustified
        .slice(0, 10)
        .map((s) =>
          finding(
            `${s.repo}:${s.file}`,
            s.line,
            `symptom-fix pattern (${s.kind}) without an accepted justification: fix the cause, or keep it only if expected behaviour requires it and explain that in remediation.justifications with evidence`,
            s.detail,
          ),
        ),
      `${unjustified.length} symptom-fix signal(s) not justified`,
    );
  const symptomOnly = (
    Array.isArray(c?.symptom_only_changes) ? c!.symptom_only_changes : []
  ).filter((x: unknown) => String(loose(x)?.explanation ?? x ?? "").trim());
  if (symptomOnly.length)
    return fail(
      symptomOnly
        .slice(0, 10)
        .map((x: unknown) =>
          finding(
            String(loose(x)?.file || "(diff)"),
            Number.isFinite(Number(loose(x)?.line)) ? Number(loose(x)!.line) : null,
            `symptom-only change: ${String(loose(x)?.explanation ?? x).slice(0, 300)}`,
            "reported by the independent reviewer in root_cause_check.symptom_only_changes",
          ),
        ),
      "the reviewer found symptom-only changes",
    );
  if (depth === "light" || !coded) return out;

  if (!c) return blocked("Root Cause First: a PASS on a defect fix must include root_cause_check");
  if (c.observability_reduced === true && !accepted.length)
    return fail(
      [
        finding(
          "(diff)",
          null,
          "observability reduced for an unresolved failure",
          "root_cause_check.observability_reduced = true without a justified signal",
        ),
      ],
      "observability reduced",
    );
  const remediationProblems = remediation
    ? [...(remediation.problems ?? [])]
    : ["remediation classification missing"];
  if (remediationProblems.length)
    return fail(
      remediationProblems.map((p) =>
        finding(
          "(implementation output: remediation)",
          null,
          p,
          "Root Cause First policy requires an honest remediation classification",
        ),
      ),
      "remediation classification incomplete",
    );
  if (kind === "ROOT_CAUSE_FIX" && c.addresses_root_cause !== true)
    return fail(
      [
        finding(
          "(implementation output: remediation)",
          null,
          "presented as ROOT_CAUSE_FIX but the reviewer did not confirm that the diff addresses the root cause",
          String(c.limitations ?? "root_cause_check.addresses_root_cause is not true").slice(
            0,
            300,
          ),
        ),
      ],
      "root cause not addressed",
    );
  const root = evidenceSummary(upstream)?.root_cause?.status ?? null;
  if (kind === "ROOT_CAUSE_FIX" && root && root !== "CONFIRMED" && root !== "PROBABLE")
    return blocked(
      `Root Cause First: presented as a root-cause fix but the investigation assessed the root cause as ${root}; provide the missing evidence or reclassify the change as PARTIAL_FIX / MITIGATION`,
    );
  const fix = kind === "ROOT_CAUSE_FIX" || kind === "PARTIAL_FIX";
  const problem = proofProblem(proof, tested);
  if (fix && proof?.status === "invalid")
    return fail(
      [
        finding(
          "(regression proof)",
          null,
          `the platform-run regression test does not demonstrate the fix: ${proof.reason}`,
          `${proof.test_id ?? "?"}: before=${proof.before ?? "?"}, after=${proof.after ?? "?"} (base ${String(proof.base_sha ?? "").slice(0, 12)})`,
        ),
      ],
      "regression proof contradicts the fix",
    );
  if (depth === "strict" && kind === "ROOT_CAUSE_FIX" && problem)
    return blocked(
      `Root Cause First (strict): a root-cause fix needs the same regression test to fail on the pre-fix source and pass on the fixed commit, run by the platform — ${problem}. A documented exception needs a human decision; it is not approved automatically`,
    );
  if (
    fix &&
    c.regression_test_demonstrates_fix !== true &&
    !String(c.limitations ?? remediation?.verification_limitations ?? "").trim()
  )
    return blocked(
      "Root Cause First: no regression evidence that the fix resolves the defect and no documented verification limitation",
    );
  return out;
}
