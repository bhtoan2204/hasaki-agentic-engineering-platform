import { OPERATION_SCOPE, type TimelineEvent } from "./correlate.ts";
import type { IdField } from "./events.ts";

/**
 * Deterministic causal reasoning over a correlated timeline. Pure: no model, no I/O.
 *
 * Hard rules (distributed-system safety, domain-agnostic):
 *  - events join one logical operation ONLY through a shared strong business identifier, never through time;
 *  - a timeout / deadline is NOT a failure: the outcome of that attempt is UNKNOWN until authoritative evidence exists;
 *  - a business rejection of a later attempt is NOT evidence that an earlier attempt succeeded;
 *  - an error returned by a dependency does not make that dependency the root cause;
 *  - the recommendation is always to verify authoritative status first; never to blindly retry a non-idempotent call.
 */

export type Outcome = "success" | "failed" | "partial" | "UNKNOWN";
export type AttemptRole = "initial" | "retry" | "redelivery";

export interface AttemptAnalysis {
  attempt_key: string;
  role: AttemptRole;
  evidence_refs: string[];
  outcome: Outcome;
  /** Why this outcome was chosen (or why it is unknown). */
  reason: string;
}

export interface IdentifierProvenance {
  field: IdField;
  value: string;
  evidence_refs: string[];
}

export interface LogicalOperation {
  operation_id: string;
  /** Strong identifiers that joined the attempts, with the events they were read from. */
  joined_by: IdentifierProvenance[];
  attempts: AttemptAnalysis[];
  outcome: Outcome;
  missing_evidence: string[];
}

export interface CausalChain {
  observed_error: string | null;
  symptom: string | null;
  trigger: string | null;
  root_cause: string | null;
  contributing_factors: string[];
  downstream_effects: string[];
}

export interface CausalAnalysis {
  operations: LogicalOperation[];
  chain: CausalChain;
  patterns: string[];
  recommendations: string[];
  /** Statements the report must never make for this incident. */
  forbidden_conclusions: string[];
  has_unknown_outcome: boolean;
}

const TIMEOUT = /context deadline exceeded|timed? ?out|deadline exceeded|ETIMEDOUT|ECONNRESET|i\/o timeout/i;
const REJECTION =
  /too many (?:refund|retry|request)|duplicate|already (?:processed|refunded|exists|paid)|idempot/i;
const SUCCESS = /\b(success|succeeded|completed|approved|code["']?\s*[:=]\s*["']?00)\b/i;

const isTimeout = (t: TimelineEvent) =>
  t.event_type === "REQUEST_TIMEOUT" || TIMEOUT.test(t.excerpt);
const isRejection = (t: TimelineEvent) =>
  t.event_type === "PROVIDER_BUSINESS_REJECTION" || (t.event_type === "ERROR" && REJECTION.test(t.excerpt));
const isSuccess = (t: TimelineEvent) =>
  !isTimeout(t) &&
  !isRejection(t) &&
  ["PARTNER_RESPONSE_RECEIVED", "PARTNER_CALLBACK_RECEIVED", "STATE_CHANGED"].includes(t.event_type) &&
  SUCCESS.test(t.excerpt);

class DSU {
  p = new Map<string, string>();
  find(x: string): string {
    if (!this.p.has(x)) this.p.set(x, x);
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r)!;
    this.p.set(x, r);
    return r;
  }
  union(a: string, b: string) {
    this.p.set(this.find(a), this.find(b));
  }
}

/** Group events into logical operations through strong business identifiers only. */
function groupOperations(timeline: TimelineEvent[]) {
  const d = new DSU();
  for (const t of timeline) {
    d.find(`e:${t.evidence_ref}`);
    for (const f of OPERATION_SCOPE)
      for (const v of t.ids[f] ?? []) if (v.length >= 6) d.union(`e:${t.evidence_ref}`, `${f}:${v.toLowerCase()}`);
  }
  const groups = new Map<string, TimelineEvent[]>();
  for (const t of timeline) {
    const root = d.find(`e:${t.evidence_ref}`);
    // An event with no strong operation identifier stays alone: it is never merged by proximity.
    groups.set(root, [...(groups.get(root) ?? []), t]);
  }
  return [...groups.values()];
}

function attemptKey(t: TimelineEvent): string {
  return t.request_id ?? t.correlation_id ?? t.trace_id ?? `ref:${t.evidence_ref}`;
}

function analyzeOperation(events: TimelineEvent[], index: number): LogicalOperation {
  const byAttempt = new Map<string, TimelineEvent[]>();
  for (const t of events) byAttempt.set(attemptKey(t), [...(byAttempt.get(attemptKey(t)) ?? []), t]);

  const prov = new Map<string, IdentifierProvenance>();
  for (const t of events)
    for (const f of OPERATION_SCOPE)
      for (const v of t.ids[f] ?? []) {
        const k = `${f}=${v}`;
        const e = prov.get(k) ?? { field: f, value: v, evidence_refs: [] };
        e.evidence_refs.push(t.evidence_ref);
        prov.set(k, e);
      }
  // Only identifiers seen in more than one attempt are what actually joined attempts.
  const joined_by = [...prov.values()].filter(
    (p) => new Set(p.evidence_refs.map((r) => attemptKey(events.find((e) => e.evidence_ref === r)!))).size > 1 || byAttempt.size === 1,
  );

  const ordered = [...byAttempt.entries()].sort(
    (a, b) => Math.min(...a[1].map((e) => e.epoch_us ?? Infinity)) - Math.min(...b[1].map((e) => e.epoch_us ?? Infinity)),
  );
  const attempts: AttemptAnalysis[] = ordered.map(([key, evs], i) => {
    const timeout = evs.some(isTimeout);
    const rejected = evs.some(isRejection);
    const success = evs.some(isSuccess);
    let outcome: Outcome;
    let reason: string;
    if (success) {
      outcome = "success";
      reason = "a success response/callback of this attempt is in the evidence";
    } else if (rejected) {
      outcome = "failed";
      reason = "the provider explicitly rejected this attempt; this says nothing about any earlier attempt";
    } else if (timeout) {
      outcome = "UNKNOWN";
      reason =
        "client timeout/deadline: the provider may have processed it; no authoritative status, callback or reconciliation record in the evidence";
    } else {
      outcome = "UNKNOWN";
      reason = "no response, callback or state change recorded for this attempt";
    }
    return {
      attempt_key: key,
      role: i === 0 ? "initial" : evs.every((e) => e.delivery && e.delivery.n > 1) ? "redelivery" : "retry",
      evidence_refs: evs.map((e) => e.evidence_ref),
      outcome,
      reason,
    };
  });

  // The operation outcome: a confirmed success anywhere wins; otherwise any unresolved attempt keeps it UNKNOWN.
  const ok = attempts.some((a) => a.outcome === "success");
  const unresolved = attempts.some((a) => a.outcome === "UNKNOWN");
  const operation: Outcome = ok
    ? attempts.every((a) => a.outcome === "success" || a.outcome === "UNKNOWN") && unresolved
      ? "partial"
      : "success"
    : unresolved
      ? "UNKNOWN"
      : "failed";

  const missing: string[] = [];
  if (unresolved && !ok)
    missing.push(
      "authoritative provider-side status of the unresolved attempt (query/inquiry API by the business identifier)",
      "provider callback or settlement/reconciliation record for the logical operation",
      "our persisted transaction record and its state transitions for the logical operation",
    );
  return { operation_id: `op-${index + 1}`, joined_by, attempts, outcome: operation, missing_evidence: missing };
}

export function analyzeCausality(timeline: TimelineEvent[]): CausalAnalysis {
  const ops = groupOperations(timeline)
    .filter((g) => g.length)
    .map((g, i) => analyzeOperation(g, i));
  const multi = ops.filter((o) => o.attempts.length > 1);
  const patterns: string[] = [];
  const recs: string[] = [];
  const contributing: string[] = [];
  const downstream: string[] = [];
  let trigger: string | null = null;
  let root: string | null = null;

  const sorted = [...timeline].sort((a, b) => (a.epoch_us ?? Infinity) - (b.epoch_us ?? Infinity));
  const lastError = [...sorted].reverse().find((t) => t.event_type === "ERROR" || isRejection(t)) ?? null;

  for (const op of ops) {
    const first = op.attempts[0];
    const later = op.attempts.slice(1);
    if (first?.outcome === "UNKNOWN" && timelineHas(timeline, first, isTimeout)) {
      patterns.push("client_timeout_unknown_outcome");
      trigger = `attempt ${first.attempt_key} hit a client timeout/deadline; its provider-side outcome is UNKNOWN`;
    }
    if (later.length) {
      patterns.push("duplicate_retry");
      const rejectedLater = later.find((a) => a.outcome === "failed");
      if (first?.outcome === "UNKNOWN") {
        root =
          "the retry path starts a new attempt for the same logical operation without first resolving the unknown outcome of the previous attempt (missing idempotency/reconciliation safeguard)";
        contributing.push("no authoritative status check between the timeout and the retry");
        if (rejectedLater) {
          patterns.push("idempotency_violation_or_duplicate_rejection");
          downstream.push(
            `attempt ${rejectedLater.attempt_key} was rejected by the provider; this is a downstream effect of the retry, not proof that the earlier attempt succeeded or failed`,
          );
        }
      }
    }
  }
  if (timeline.some((t) => t.delivery && t.delivery.n > 1)) {
    patterns.push("at_least_once_redelivery");
    contributing.push("the same message id was delivered more than once");
  }

  const unknown = ops.some((o) => o.outcome === "UNKNOWN" || o.outcome === "partial");
  if (unknown) {
    recs.push(
      "Verify the authoritative provider status for the logical operation (inquiry API / callback / reconciliation) before deciding its outcome.",
      "Block creating another attempt for the same logical operation while the outcome is UNKNOWN; reuse one idempotency key per logical operation.",
      "Persist an explicit PENDING/UNKNOWN state with the business identifier so the retry path and reconciliation can find it.",
    );
  }
  if (multi.length)
    recs.push("Do not retry a non-idempotent financial operation blindly and do not mark it successful without authoritative evidence.");

  const forbidden = [
    "the provider is the root cause only because it returned an error",
    "a timeout proves the operation failed",
    "a rejection of a later attempt proves an earlier attempt succeeded",
    "automatically re-issuing the operation or marking it successful",
    "ignoring business errors, or fixing only log formatting/wording",
  ];

  return {
    operations: ops,
    chain: {
      observed_error: lastError ? lastError.excerpt : null,
      symptom: lastError ? "the final visible operation failed" : null,
      trigger,
      root_cause: root,
      contributing_factors: [...new Set(contributing)],
      downstream_effects: [...new Set(downstream)],
    },
    patterns: [...new Set(patterns)],
    recommendations: recs,
    forbidden_conclusions: forbidden,
    has_unknown_outcome: unknown,
  };
}

function timelineHas(timeline: TimelineEvent[], a: AttemptAnalysis, pred: (t: TimelineEvent) => boolean) {
  const refs = new Set(a.evidence_refs);
  return timeline.some((t) => refs.has(t.evidence_ref) && pred(t));
}
