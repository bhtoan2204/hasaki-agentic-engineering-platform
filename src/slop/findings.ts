import { createHash } from "node:crypto";
import type { SlopSeverity } from "../config.ts";

/**
 * Finding model, stable fingerprints and baseline comparison for slop detection. Pure: no I/O, no model calls.
 */

export type FindingKind = "deterministic" | "heuristic";
export type FindingStatus = "new" | "worsened" | "existing" | "resolved" | "suppressed";

/** What a detector reports for one file (no fingerprint yet). */
export interface RawFinding {
  rule: string;
  category: string;
  severity: SlopSeverity;
  /** 0..1: how likely the finding is a real problem. */
  confidence: number;
  kind: FindingKind;
  path: string;
  line: number;
  /** Qualified name of the enclosing symbol ("" at file level). */
  symbol: string;
  /** Redacted source evidence, bounded. */
  snippet: string;
  message: string;
  /** Metric rules (complexity): the measured value; the fingerprint then ignores the snippet. */
  value?: number;
}

export interface Finding extends RawFinding {
  fingerprint: string;
  status: FindingStatus;
  /** Base value of a worsened metric finding. */
  base_value?: number;
}

export interface SlopReport {
  status: "ok" | "partial" | "error";
  level: "micro" | "standard";
  detector_version: string;
  findings: Finding[];
  counts: Record<FindingStatus, number>;
  by_category: Record<string, number>;
  files_scanned: number;
  cache_hits: number;
  detector_ms: number;
  /** Always 0: detection is deterministic and never calls a model. */
  llm_tokens: 0;
  unsupported_rules: Array<{ rule: string; status: "unsupported" | "covered_by"; detail: string }>;
  skipped: Array<{ path: string; reason: string }>;
  errors: Array<{ path?: string; error: string }>;
}

export const SEVERITY_RANK: Record<SlopSeverity, number> = { low: 1, medium: 2, high: 3 };
const METRIC_RULES = new Set(["complexity"]);

/** Collapse whitespace so re-indentation keeps the identity (snippets never contain line numbers). */
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Line-independent identity: rule | path | symbol | normalized snippet | ordinal among equal keys in the file.
 * Metric findings omit the snippet so a growing function keeps its identity (and can be "worsened").
 */
export function fingerprint(findings: RawFinding[]): Array<RawFinding & { fingerprint: string }> {
  const seen = new Map<string, number>();
  return findings.map((f) => {
    const key = [f.rule, f.path, f.symbol, METRIC_RULES.has(f.rule) ? "" : normalize(f.snippet)].join("|");
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return { ...f, fingerprint: createHash("sha256").update(`${key}|${ordinal}`).digest("hex") };
  });
}

/** Classify head findings against the base: new, worsened, existing, resolved; suppressed fingerprints never block. */
export function compare(
  base: RawFinding[],
  head: RawFinding[],
  suppressions: ReadonlySet<string> = new Set(),
): Finding[] {
  const before = new Map(fingerprint(base).map((f) => [f.fingerprint, f]));
  const after = fingerprint(head);
  const now = new Set(after.map((f) => f.fingerprint));
  const out: Finding[] = after.map((f) => {
    const b = before.get(f.fingerprint);
    let status: FindingStatus = "new";
    if (b)
      status =
        (f.value ?? 0) > (b.value ?? 0) || SEVERITY_RANK[f.severity] > SEVERITY_RANK[b.severity]
          ? "worsened"
          : "existing";
    if (suppressions.has(f.fingerprint)) status = "suppressed";
    return { ...f, status, ...(b && status === "worsened" && b.value !== undefined ? { base_value: b.value } : {}) };
  });
  for (const b of before.values())
    if (!now.has(b.fingerprint)) out.push({ ...b, status: "resolved" });
  return out;
}

export function tally(findings: Finding[]) {
  const counts: Record<FindingStatus, number> = { new: 0, worsened: 0, existing: 0, resolved: 0, suppressed: 0 };
  const by_category: Record<string, number> = {};
  for (const f of findings) {
    counts[f.status]++;
    if (f.status !== "resolved") by_category[f.category] = (by_category[f.category] ?? 0) + 1;
  }
  return { counts, by_category };
}

/** A report for a scan that could not run: failures are explicit, never "no findings". */
export function failedReport(error: string, detectorVersion: string): SlopReport {
  return {
    status: "error",
    level: "standard",
    detector_version: detectorVersion,
    findings: [],
    ...tally([]),
    files_scanned: 0,
    cache_hits: 0,
    detector_ms: 0,
    llm_tokens: 0,
    unsupported_rules: [],
    skipped: [],
    errors: [{ error }],
  };
}
