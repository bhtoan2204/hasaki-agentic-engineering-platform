import { createHash } from "node:crypto";

/**
 * Unified incident RCA — deterministic reconciliation of the evidence the existing workflows persisted (no model call).
 *
 * Two questions are kept apart on purpose:
 *   bug verification   — is there a real defect in the code? (Bug Hunter's independent verifier / reproduction)
 *   incident causality — did that defect (or anything else) cause THIS production incident? (runtime RCA rounds, or
 *                        the hunt's own causality verdict)
 * A confirmed defect is never promoted to a confirmed root cause by itself, two sources agreeing never raise the level
 * (the conclusion is the strongest single, valid, fresh verdict), and a contradiction makes the RCA CONFLICTED.
 */

export type RcaStatus = "CONFIRMED" | "PROBABLE" | "UNKNOWN" | "CONFLICTED" | "BLOCKED";
export type Level = "confirmed" | "probable" | "unknown" | "against";

export interface CodeLocation {
  repository: string;
  file: string;
  line_start?: number | null;
  line_end?: number | null;
  function?: string | null;
}

export interface EvidenceItem {
  /** Stable reference to the source record (never a copy of a transcript). */
  ref: string;
  source: "bug_hunt" | "runtime";
  run_id: number;
  kind: "code_defect" | "runtime_hypothesis" | "runtime_finding";
  statement: string;
  location: CodeLocation | null;
  commit: string | null;
  /** Bug Hunter: is the defect real. */
  bug_verification?: "CONFIRMED" | "SUSPECTED" | "REJECTED" | "BLOCKED";
  /** Bug Hunter: did it cause the incident. */
  causality?: "CONFIRMED" | "PROBABLE" | "NOT_SUPPORTED" | "UNKNOWN" | "NOT_APPLICABLE";
  /** Runtime RCA hypothesis status and kind, and the round's outcome. */
  hypothesis_status?: string;
  hypothesis_kind?: string;
  run_outcome?: string;
  refs: string[];
  /** Fix target in its own workflow (a hunt finding, or the runtime run). */
  target?: { hunt_id?: number; finding_id?: number; run_id?: number };
  valid: boolean;
  invalid_reason?: string;
  stale?: boolean;
}

export interface SourceRun {
  run_id: number;
  kind: "runtime" | "bug_hunt" | "fix";
  run_status: string;
  /** Runtime: round outcome; hunt: hunt status (completed/partial/failed…). */
  outcome: string | null;
  missing: string[];
  impact?: string[];
  cause_key?: string | null;
}

export interface Cause {
  key: string;
  location: CodeLocation | null;
  statement: string;
  level: Exclude<Level, "against">;
  code_fixable: boolean;
  supporting: string[];
  contradicting: string[];
  defect: "CONFIRMED" | "SUSPECTED" | "REJECTED" | "UNVERIFIED";
  sources: Array<"bug_hunt" | "runtime">;
  fix_target: EvidenceItem["target"] | null;
}

export interface Reconciliation {
  status: RcaStatus;
  reasons: string[];
  causes: Cause[];
  conflicts: Array<{ cause: string; detail: string; refs: string[] }>;
  verified_defects: Array<{
    ref: string;
    location: CodeLocation | null;
    causality: string;
    statement: string;
  }>;
  runtime_findings: Array<{ ref: string; statement: string }>;
  missing_evidence: string[];
  next_actions: Array<{ kind: string; detail: string; cause?: string }>;
  impact: string[];
  excluded: Array<{ ref: string; reason: string }>;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[0-9a-f]{8,}|\d+/g, "#")
    .replace(/[^a-z#\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
const jaccard = (a: string, b: string) => {
  const x = new Set(norm(a)),
    y = new Set(norm(b));
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const t of x) if (y.has(t)) n++;
  return n / (x.size + y.size - n);
};
const RANK: Record<Level, number> = { against: -1, unknown: 0, probable: 1, confirmed: 2 };

/** One item's verdict on incident causality (bug verification is not causality). */
export function causalityLevel(i: EvidenceItem): Level {
  if (!i.valid) return "unknown";
  let l: Level = "unknown";
  if (i.source === "bug_hunt")
    l =
      i.causality === "CONFIRMED"
        ? "confirmed"
        : i.causality === "PROBABLE"
          ? "probable"
          : i.causality === "NOT_SUPPORTED"
            ? "against"
            : "unknown";
  else if (
    i.kind === "runtime_hypothesis" &&
    ["causal_origin", "direct_trigger"].includes(i.hypothesis_kind ?? "")
  )
    l =
      i.hypothesis_status === "DISPROVED"
        ? "against"
        : i.hypothesis_status === "SUPPORTED"
          ? i.run_outcome === "CONFIRMED" && i.hypothesis_kind === "causal_origin"
            ? "confirmed"
            : "probable"
          : "unknown";
  // Evidence measured on code that has since changed cannot confirm anything about the current incident.
  if (i.stale && l === "confirmed") l = "probable";
  return l;
}

const sameLocation = (a: CodeLocation, b: CodeLocation) => {
  if (a.repository !== b.repository || a.file !== b.file) return false;
  if (a.function && b.function) return a.function === b.function;
  if (a.line_start == null || b.line_start == null) return true;
  const ae = a.line_end ?? a.line_start,
    be = b.line_end ?? b.line_start;
  return a.line_start <= be + 15 && b.line_start <= ae + 15;
};
export const causeKey = (l: CodeLocation | null, statement: string) =>
  l
    ? `${l.repository}:${l.file}`.toLowerCase()
    : `text:${createHash("sha256").update(norm(statement).sort().join(" ")).digest("hex").slice(0, 16)}`;

export function reconcile(items: EvidenceItem[], runs: SourceRun[]): Reconciliation {
  const usable = items.filter((i) => i.valid);
  const excluded = items
    .filter((i) => !i.valid)
    .map((i) => ({ ref: i.ref, reason: i.invalid_reason ?? "invalid" }));
  // ---- cluster causes: same code location, or (no location) the same statement
  const clusters: Array<{ loc: CodeLocation | null; items: EvidenceItem[] }> = [];
  for (const i of usable.filter((x) => x.kind !== "runtime_finding")) {
    const c = clusters.find((c) =>
      i.location && c.loc
        ? sameLocation(i.location, c.loc)
        : !i.location && !c.loc && jaccard(i.statement, c.items[0].statement) >= 0.5,
    );
    if (c) {
      c.items.push(i);
      if (!c.loc?.function && i.location?.function) c.loc = i.location;
    } else clusters.push({ loc: i.location, items: [i] });
  }
  const causes: Cause[] = [];
  const conflicts: Reconciliation["conflicts"] = [];
  for (const c of clusters) {
    const levels = c.items.map((i) => ({ i, l: causalityLevel(i) }));
    const supporting = levels.filter((x) => RANK[x.l] >= 1);
    const against = levels.filter((x) => x.l === "against");
    const best = supporting.reduce<Level>((a, x) => (RANK[x.l] > RANK[a] ? x.l : a), "unknown");
    const key = causeKey(c.loc, c.items[0].statement);
    const defectItems = c.items.filter((i) => i.bug_verification);
    const defect = defectItems.some((i) => i.bug_verification === "CONFIRMED")
      ? "CONFIRMED"
      : defectItems.some((i) => i.bug_verification === "SUSPECTED")
        ? "SUSPECTED"
        : defectItems.length && defectItems.every((i) => i.bug_verification === "REJECTED")
          ? "REJECTED"
          : "UNVERIFIED";
    // A source that supports a cause and another (different run) that disproves it: a contradiction, not an average.
    if (
      supporting.length &&
      against.some((a) => !supporting.some((s) => s.i.run_id === a.i.run_id))
    )
      conflicts.push({
        cause: key,
        detail: `supported by ${supporting.map((s) => s.i.ref).join(", ")} but not supported/disproved by ${against.map((a) => a.i.ref).join(", ")}`,
        refs: [...supporting, ...against].map((x) => x.i.ref),
      });
    const target =
      c.items.find(
        (i) =>
          i.target?.finding_id && ["CONFIRMED", "SUSPECTED"].includes(i.bug_verification ?? ""),
      )?.target ??
      c.items.find((i) => i.source === "runtime" && i.target?.run_id && i.location)?.target ??
      null;
    causes.push({
      key,
      location: c.loc,
      statement: (supporting[0]?.i ?? c.items[0]).statement.slice(0, 400),
      level: best === "against" ? "unknown" : best,
      // Only a code location backed by code evidence becomes a code fix: provider, configuration or valid business
      // rejections are not forced into a code task.
      code_fixable:
        !!c.loc &&
        defect !== "REJECTED" &&
        !!target &&
        (defect !== "UNVERIFIED" || best !== "unknown"),
      supporting: supporting.map((s) => s.i.ref),
      contradicting: against.map((a) => a.i.ref),
      defect,
      sources: [...new Set(c.items.map((i) => i.source))],
      fix_target: target,
    });
  }
  // Two different causes each CONFIRMED by different runs: the incident cannot have both as "the" root cause.
  const confirmed = causes.filter((c) => c.level === "confirmed");
  if (confirmed.length > 1)
    conflicts.push({
      cause: confirmed.map((c) => c.key).join(" vs "),
      detail: `competing confirmed root causes: ${confirmed.map((c) => c.key).join(", ")}`,
      refs: confirmed.flatMap((c) => c.supporting),
    });
  const conflictKeys = new Set(conflicts.flatMap((c) => c.cause.split(" vs ")));
  const reasons: string[] = [];
  let status: RcaStatus;
  const finished = runs.filter((r) => r.kind !== "fix" && ["COMPLETED"].includes(r.run_status));
  const blocked =
    runs.filter((r) => r.kind !== "fix").length > 0 &&
    runs
      .filter((r) => r.kind !== "fix")
      .every(
        (r) =>
          r.outcome === "BLOCKED" ||
          ["FAILED", "CANCELED"].includes(r.run_status) ||
          r.outcome === "failed",
      );
  if (conflicts.length) {
    status = "CONFLICTED";
    reasons.push(...conflicts.map((c) => c.detail));
  } else if (confirmed.length === 1 && !conflictKeys.has(confirmed[0].key)) {
    status = "CONFIRMED";
    reasons.push(
      `root cause ${confirmed[0].key} confirmed by ${confirmed[0].supporting.join(", ")}`,
    );
  } else if (causes.some((c) => c.level === "probable")) {
    status = "PROBABLE";
    reasons.push("a supported hypothesis exists but its causality is not confirmed");
  } else if (blocked && !usable.length) {
    status = "BLOCKED";
    reasons.push("every investigation was blocked or failed before producing evidence");
  } else {
    status = "UNKNOWN";
    reasons.push(
      finished.length
        ? "no hypothesis is supported by valid evidence"
        : "no investigation has finished",
    );
  }
  // ---- verified defects (bug verification, reported with their own causality verdict)
  const verified_defects = usable
    .filter((i) => i.bug_verification === "CONFIRMED")
    .map((i) => ({
      ref: i.ref,
      location: i.location,
      causality: i.causality ?? "UNKNOWN",
      statement: i.statement.slice(0, 300),
    }));
  const missing = [...new Set(runs.flatMap((r) => r.missing))].slice(0, 20);
  for (const d of verified_defects)
    if (
      !["CONFIRMED", "PROBABLE"].includes(d.causality) &&
      !causes.some((c) => c.level !== "unknown" && c.supporting.includes(d.ref))
    )
      missing.push(
        `runtime evidence that defect ${d.location ? `${d.location.repository}:${d.location.file}` : d.ref} caused this incident`,
      );
  // ---- next actions (deterministic; never started automatically)
  const has = (k: SourceRun["kind"]) =>
    runs.some((r) => r.kind === k && !["FAILED", "CANCELED"].includes(r.run_status));
  const next: Reconciliation["next_actions"] = [];
  if (!has("runtime") && !has("bug_hunt"))
    next.push({
      kind: "start",
      detail: "Run a Runtime RCA (logs/traces) or a Bug Hunt (code) — or both",
    });
  else if (!has("runtime") && status !== "CONFIRMED")
    next.push({
      kind: "run_runtime",
      detail: verified_defects.length
        ? "Run a Runtime RCA to test whether the confirmed defect caused this incident"
        : "Run a Runtime RCA to look for the incident's cause in logs and traces",
    });
  else if (!has("bug_hunt") && status !== "CONFIRMED")
    next.push({
      kind: "run_bug_hunt",
      detail: causes.some((c) => c.location && c.level !== "unknown" && c.defect === "UNVERIFIED")
        ? "Run a Bug Hunt to verify the code defect behind the supported hypothesis"
        : "Run a Bug Hunt to look for (or rule out) a code defect behind this incident",
    });
  for (const c of conflicts)
    next.push({ kind: "resolve_conflict", detail: `Cross-check: ${c.detail}`, cause: c.cause });
  for (const i of usable.filter((x) => x.stale))
    next.push({
      kind: "refresh",
      detail: `Evidence ${i.ref} cites code that changed since it was collected: re-run that workflow on the current code to rely on it`,
    });
  const fixed = new Set(
    runs
      .filter((r) => r.kind === "fix")
      .map((r) => r.cause_key)
      .filter(Boolean),
  );
  for (const c of causes.filter(
    (x) =>
      x.code_fixable && !fixed.has(x.key) && (x.level !== "unknown" || x.defect === "CONFIRMED"),
  ))
    next.push({
      kind: "create_fix",
      detail: `Create a fix task for ${c.key}${c.level === "unknown" ? " (defect confirmed; incident causality not proven)" : ""}`,
      cause: c.key,
    });
  return {
    status,
    reasons,
    causes: causes.sort((a, b) => RANK[b.level] - RANK[a.level]),
    conflicts,
    verified_defects,
    runtime_findings: usable
      .filter((i) => i.kind === "runtime_finding")
      .map((i) => ({ ref: i.ref, statement: i.statement.slice(0, 300) })),
    missing_evidence: [...new Set(missing)],
    next_actions: next,
    impact: [...new Set(runs.flatMap((r) => r.impact ?? []))].slice(0, 10),
    excluded,
  };
}

/** What the RCA was computed from: same inputs → same hash → no new version. */
export function inputsHash(items: EvidenceItem[], runs: SourceRun[]) {
  const shape = {
    items: items
      .map((i) => [
        i.ref,
        i.commit ?? "",
        i.bug_verification ?? "",
        i.causality ?? "",
        i.hypothesis_status ?? "",
        i.run_outcome ?? "",
        i.valid,
        !!i.stale,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    runs: runs
      .map((r) => [r.run_id, r.kind, r.run_status, r.outcome ?? ""])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}
