import { createHash } from "node:crypto";
import type { TimelineEvent } from "./correlate.ts";
import type { IdField } from "./events.ts";

/**
 * Iterative investigation state. Pure: every round is derived from the stored searches, the validated timeline and the
 * findings agent's proposals; the agent proposes hypotheses and next queries, these rules decide what they are worth.
 *  - a hypothesis is SUPPORTED only by resolvable runtime evidence AND a code location (independent cross-check);
 *    contradicting evidence makes it DISPROVED or UNRESOLVED; an agent's own status is never trusted upward;
 *  - a root cause is CONFIRMED only with a supported causal origin, a verified deployed commit and counted impact;
 *    an exhausted budget never promotes an outcome;
 *  - affected objects are counted by distinct business identifier, never by log lines; a truncated or failed search makes
 *    the count a lower bound; state/money impact stays UNKNOWN without authoritative state evidence;
 *  - an empty search is classified (no rows, truncated, permission, unavailable, window) — absence of a log is not proof.
 */

export const HYPOTHESIS_STATUSES = ["OPEN", "SUPPORTED", "DISPROVED", "UNRESOLVED"] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];
export const HYPOTHESIS_KINDS = [
  "direct_trigger",
  "contributing_factor",
  "causal_origin",
  "systemic_recurrence",
] as const;
export type HypothesisKind = (typeof HYPOTHESIS_KINDS)[number];
export type RootCauseOutcome = "CONFIRMED" | "PROBABLE" | "UNKNOWN" | "BLOCKED";

// ---------------------------------------------------------------- query coverage

export type NoDataReason =
  "rows" | "no_rows" | "truncated" | "permission" | "unavailable" | "error" | "manual_pending";

export interface SearchCoverage {
  id: number;
  reason: NoDataReason;
  rows: number;
  earliest_ms: number;
  latest_ms: number;
}

export interface SearchRowLike {
  id: number | string;
  status: string;
  result_count: number | null;
  truncated?: boolean | null;
  error?: string | null;
  earliest: Date | string;
  latest: Date | string;
}

const PERMISSION =
  /\b(401|403)\b|forbidden|unauthori[sz]ed|not authorized|permission|outside the allowlist|not allowed|credential expired|not connected/i;
const UNAVAILABLE = /timed? ?out|ECONN|ENOTFOUND|unavailable|\b50[234]\b|budget exhausted/i;

export function searchCoverage(rows: SearchRowLike[]): SearchCoverage[] {
  return rows.map((r) => {
    const rowsN = Number(r.result_count ?? 0);
    const reason: NoDataReason =
      r.status === "manual_pending"
        ? "manual_pending"
        : r.status === "failed" || r.status === "running"
          ? PERMISSION.test(r.error ?? "")
            ? "permission"
            : UNAVAILABLE.test(r.error ?? "")
              ? "unavailable"
              : "error"
          : r.truncated
            ? "truncated"
            : rowsN > 0
              ? "rows"
              : "no_rows";
    return {
      id: Number(r.id),
      reason,
      rows: rowsN,
      earliest_ms: new Date(r.earliest).getTime(),
      latest_ms: new Date(r.latest).getTime(),
    };
  });
}

/** Gaps a later round could close, or that block the conclusion. */
export function coverageGaps(coverage: SearchCoverage[], anchorMs: number | null) {
  const gaps: string[] = [];
  const answered = coverage.filter((c) => ["rows", "no_rows", "truncated"].includes(c.reason));
  if (
    anchorMs != null &&
    !answered.some((c) => c.earliest_ms <= anchorMs && anchorMs <= c.latest_ms)
  )
    gaps.push("window_misses_anchor");
  if (coverage.some((c) => c.reason === "truncated")) gaps.push("truncated");
  if (coverage.some((c) => c.reason === "permission")) gaps.push("permission");
  if (coverage.length && !answered.length) gaps.push("no_answered_search");
  return gaps;
}

// ---------------------------------------------------------------- impact

const OBJECT_FIELDS: IdField[] = ["shipment_code", "shipment_id", "order_code", "tracking_no"];
const FAILURE = /\b(fail(ed|ure)?|error|reject(ed)?|invalid|exception)\b/i;

export interface ImpactCount {
  field: IdField;
  distinct: number;
  failure_events: number;
  /** Search results were truncated, failed or not run: the real number may be higher. */
  lower_bound: boolean;
}

export function impactCounts(timeline: TimelineEvent[], coverage: SearchCoverage[]) {
  const failures = timeline.filter(
    (t) =>
      t.confidence !== "unknown" && (t.event_type === "ERROR" || FAILURE.test(t.excerpt ?? "")),
  );
  const incomplete = coverage.some((c) => !["rows", "no_rows"].includes(c.reason));
  const objects: ImpactCount[] = OBJECT_FIELDS.map((field) => {
    const values = new Set<string>();
    for (const t of failures) {
      const v = t[field as keyof TimelineEvent] as string | null;
      if (v) values.add(v);
      for (const x of t.ids?.[field] ?? []) values.add(x);
    }
    return {
      field,
      distinct: values.size,
      failure_events: failures.length,
      lower_bound: incomplete,
    };
  }).filter((c) => c.distinct > 0);
  const unique = Math.max(0, ...objects.map((o) => o.distinct));
  const stateEvidence = timeline.some(
    (t) => t.event_type === "STATE_CHANGED" && t.confidence === "confirmed",
  );
  return {
    objects,
    failure_events: failures.length,
    /** Failure log lines beyond one per affected object: retries / repeats, not extra objects. */
    repeats: unique ? Math.max(0, failures.length - unique) : null,
    state_money: stateEvidence ? ("EVIDENCED" as const) : ("UNKNOWN" as const),
  };
}

// ---------------------------------------------------------------- hypotheses

export interface Hypothesis {
  id: string;
  statement: string;
  kind: HypothesisKind;
  status: HypothesisStatus;
  claimed_status: string | null;
  supporting_refs: string[];
  contradicting_refs: string[];
  predicted_observations: string[];
  code_location: string | null;
  service: string | null;
  notes: string[];
}

const CODE_LOCATION = /^([\w.-]+):([\w./-]+):(\d+)$/;
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

export function evaluateHypotheses(
  raw: unknown,
  ctx: { knownRefs: Set<string>; runtimeRefs: Set<string>; repositories: Set<string> },
): Hypothesis[] {
  const items = Array.isArray((raw as { hypotheses?: unknown })?.hypotheses)
    ? ((raw as { hypotheses: unknown[] }).hypotheses as Array<Record<string, unknown>>)
    : [];
  return items.slice(0, 20).map((h, i) => {
    const notes: string[] = [];
    const support = list(h.supporting_refs);
    const contra = list(h.contradicting_refs);
    const valid = (refs: string[]) => refs.filter((r) => ctx.knownRefs.has(r));
    const bad = [...support, ...contra].filter((r) => !ctx.knownRefs.has(r));
    if (bad.length)
      notes.push(`unresolvable evidence references dropped: ${bad.slice(0, 5).join(", ")}`);
    const supporting = valid(support);
    const contradicting = valid(contra);
    const loc = String(h.code_location ?? "").trim();
    const m = CODE_LOCATION.exec(loc);
    const code = m && (!ctx.repositories.size || ctx.repositories.has(m[1])) ? loc : null;
    if (loc && !code)
      notes.push(`code location not in a discovered repository: ${loc.slice(0, 120)}`);
    const runtime = supporting.some((r) => ctx.runtimeRefs.has(r));
    let status: HypothesisStatus;
    if (contradicting.length && !supporting.length) status = "DISPROVED";
    else if (contradicting.length) {
      status = "UNRESOLVED";
      notes.push("supporting and contradicting evidence both exist: cross-check before concluding");
    } else if (runtime && code) status = "SUPPORTED";
    else {
      status = "OPEN";
      if (supporting.length && !code)
        notes.push("no code location: the mechanism is not cross-checked in source");
      if (code && !runtime) notes.push("no runtime evidence for the mechanism");
    }
    const claimed = typeof h.status === "string" ? h.status.toUpperCase() : null;
    if (
      claimed &&
      claimed !== status &&
      (HYPOTHESIS_STATUSES as readonly string[]).includes(claimed)
    )
      notes.push(`status ${claimed} not supported by the evidence: ${status}`);
    const kind = (HYPOTHESIS_KINDS as readonly string[]).includes(String(h.kind))
      ? (h.kind as HypothesisKind)
      : "contributing_factor";
    return {
      id: String(h.id ?? `H${i + 1}`).slice(0, 20),
      statement: String(h.statement ?? h.hypothesis ?? "").slice(0, 800),
      kind,
      status,
      claimed_status: claimed,
      supporting_refs: supporting,
      contradicting_refs: contradicting,
      predicted_observations: list(h.predicted_observations)
        .slice(0, 5)
        .map((x) => x.slice(0, 300)),
      code_location: code,
      service: h.service ? String(h.service).slice(0, 80) : null,
      notes,
    };
  });
}

// ---------------------------------------------------------------- deployed version

export interface DeployedVersion {
  service: string;
  commit: string | null;
  verified: boolean;
  note: string;
}

/** A deployed commit counts only when it is a SHA read from a stored, resolvable record (e.g. an Argo CD search). */
export function deployedVersions(raw: unknown, knownRefs: Set<string>): DeployedVersion[] {
  const items = Array.isArray((raw as { deployed?: unknown })?.deployed)
    ? (raw as { deployed: Array<Record<string, unknown>> }).deployed
    : [];
  return items.slice(0, 10).map((d) => {
    const commit = /^[0-9a-f]{7,40}$/.test(String(d.commit ?? "")) ? String(d.commit) : null;
    const ref = String(d.evidence_ref ?? "");
    const verified = !!commit && knownRefs.has(ref);
    return {
      service: String(d.service ?? "").slice(0, 80),
      commit,
      verified,
      note: verified
        ? `read from ${ref}`
        : commit
          ? "commit not backed by a stored record: compare with HEAD only as separate evidence"
          : "deployed commit unavailable",
    };
  });
}

// ---------------------------------------------------------------- outcome, progress, next actions, stop

export function rootCauseOutcome(i: {
  hypotheses: Hypothesis[];
  impact: ReturnType<typeof impactCounts>;
  deployed: DeployedVersion[];
  blocked: boolean;
}): { outcome: RootCauseOutcome; reasons: string[] } {
  if (i.blocked)
    return {
      outcome: "BLOCKED",
      reasons: ["no evidence source answered (access or availability)"],
    };
  const origin = i.hypotheses.filter((h) => h.kind === "causal_origin" && h.status === "SUPPORTED");
  if (!origin.length)
    return {
      outcome: "UNKNOWN",
      reasons: ["no causal origin is supported by runtime and source evidence"],
    };
  const reasons: string[] = [];
  const deployed = i.deployed.some(
    (d) => d.verified && (!origin[0].service || d.service === origin[0].service),
  );
  if (!deployed)
    reasons.push(
      "deployed commit of the service is not verified: the code read may not be what ran",
    );
  if (!i.impact.objects.length) reasons.push("no affected business object is counted");
  return { outcome: reasons.length ? "PROBABLE" : "CONFIRMED", reasons };
}

export function progressSignature(s: {
  refs: string[];
  hypotheses: Hypothesis[];
  missing: string[];
}) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        [...new Set(s.refs)].sort(),
        s.hypotheses.map((h) => `${h.id}:${h.status}`).sort(),
        [...s.missing].sort(),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

export interface NextAction {
  kind:
    | "widen_window"
    | "search_identifier"
    | "find_event"
    | "check_prediction"
    | "resolve_deployed_version"
    | "cross_check_contradiction";
  detail: string;
  fingerprint: string;
}

const fp = (kind: string, detail: string) =>
  createHash("sha256")
    .update(`${kind}\0${detail.toLowerCase().replace(/\s+/g, " ").trim()}`)
    .digest("hex")
    .slice(0, 16);
const action = (kind: NextAction["kind"], detail: string): NextAction => ({
  kind,
  detail,
  fingerprint: fp(kind, detail),
});

/**
 * Highest information gain first: a window that misses the request, a contradiction, identifiers never searched, the
 * missing event types, predictions of open hypotheses, the deployed commit. Equivalent actions already planned in an
 * earlier round are not planned again.
 */
export function planNextActions(i: {
  gaps: string[];
  anchor: string | null;
  identifiers: Partial<Record<IdField, string[]>>;
  searchedText: string;
  missing: Array<{ objective: string; needed: string }>;
  hypotheses: Hypothesis[];
  deployed: DeployedVersion[];
  done: Set<string>;
  max?: number;
}): NextAction[] {
  const out: NextAction[] = [];
  if (i.gaps.includes("window_misses_anchor") && i.anchor)
    out.push(action("widen_window", `cover ${i.anchor} (at most ±2h around it, step by step)`));
  for (const h of i.hypotheses.filter((x) => x.status === "UNRESOLVED"))
    out.push(
      action(
        "cross_check_contradiction",
        `${h.id}: find which of the conflicting records is authoritative`,
      ),
    );
  const searched = i.searchedText.toLowerCase();
  for (const [field, values] of Object.entries(i.identifiers))
    for (const v of (values ?? []).slice(0, 5))
      if (v && !searched.includes(v.toLowerCase()))
        out.push(action("search_identifier", `${field}=${v}`));
  for (const m of i.missing) out.push(action("find_event", `${m.objective}: ${m.needed}`));
  for (const h of i.hypotheses.filter((x) => x.status === "OPEN"))
    for (const p of h.predicted_observations) out.push(action("check_prediction", `${h.id}: ${p}`));
  if (!i.deployed.some((d) => d.verified))
    out.push(
      action(
        "resolve_deployed_version",
        "read the deployed image/commit of the failing service (Argo CD app or release record)",
      ),
    );
  const seen = new Set(i.done);
  return out
    .filter((a) => (seen.has(a.fingerprint) ? false : (seen.add(a.fingerprint), true)))
    .slice(0, i.max ?? 5);
}

export type StopReason =
  | "sufficient_evidence"
  | "blocked"
  | "max_rounds"
  | "query_budget"
  | "no_progress"
  | "no_remaining_actions"
  | "disabled";

export function stopReason(i: {
  enabled: boolean;
  round: number;
  maxRounds: number;
  queriesUsed: number;
  queryBudget: number;
  outcome: RootCauseOutcome;
  signature: string;
  previousSignature: string | null;
  actions: NextAction[];
}): StopReason | null {
  if (i.outcome === "BLOCKED") return "blocked";
  if (i.outcome === "CONFIRMED") return "sufficient_evidence";
  if (!i.enabled) return "disabled";
  if (i.round >= i.maxRounds) return "max_rounds";
  if (i.queriesUsed >= i.queryBudget) return "query_budget";
  if (i.previousSignature === i.signature) return "no_progress";
  if (!i.actions.length) return "no_remaining_actions";
  return null;
}

/** The persisted state of one round (artifact `investigation_round`, immutable). */
export interface RoundState {
  round: number;
  max_rounds: number;
  step_id: number;
  generation: number;
  time: { earliest: string; latest: string; timezone: string; anchor: string | null };
  services: string[];
  outcome: RootCauseOutcome;
  outcome_reasons: string[];
  hypotheses: Hypothesis[];
  deployed: DeployedVersion[];
  impact: ReturnType<typeof impactCounts>;
  coverage: Array<{ id: number; reason: NoDataReason; rows: number }>;
  gaps: string[];
  missing: Array<{ objective: string; needed: string }>;
  actions: NextAction[];
  refs: string[];
  new_evidence: number;
  queries_used: number;
  query_budget: number;
  signature: string;
  stop_reason: StopReason | null;
}
