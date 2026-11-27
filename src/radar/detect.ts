import { createHash } from "node:crypto";
import { needsBump } from "../prodErrors/severity.ts";

/**
 * Engineering Radar detectors: pure, deterministic functions over series the platform already stores. Statistical
 * baselines are robust (median and MAD, so one earlier spike does not hide the next), thresholds are explicit and
 * configurable, and every detection carries the numbers that justify it. No model looks at raw events here.
 */

export type Severity = "low" | "medium" | "high" | "critical";
export type Confidence = "low" | "medium" | "high";
export type FindingKind =
  | "error_spike"
  | "latency_regression"
  | "new_signature"
  | "retry_pattern"
  | "recurring_incident"
  | "deploy_correlated"
  | "workflow_failures"
  | "ci_failures";

export interface RadarThresholds {
  /** Minimum events in the latest window before anything is a spike/new signature. */
  minCount: number;
  /** Robust z-score (|x - median| / (1.4826 * MAD)) that makes a spike. */
  zSpike: number;
  /** And at least this ratio over the baseline median. */
  ratioSpike: number;
  /** Baseline hours with data needed before a spike can be claimed (fewer: only "new signature" logic applies). */
  minBaseline: number;
  /** Quiet→active episodes (covered days) within recurrenceDays that make a recurring incident. */
  recurringDays: number;
  recurrenceDays: number;
  /** Distinct failing runs (workflow) or PRs (CI) within 7 days that make a persistent failure. */
  persistentFailures: number;
}
export const DEFAULT_THRESHOLDS: RadarThresholds = {
  minCount: 20,
  zSpike: 4,
  ratioSpike: 2,
  minBaseline: 12,
  recurringDays: 3,
  recurrenceDays: 7,
  persistentFailures: 3,
};

/** One hour of a production error series (prod_error_observations.hourly, comparable whatever the scan window). */
export interface SeriesPoint {
  at: Date;
  count: number;
}
export interface ErrorSeries {
  fingerprint: string;
  service: string;
  environment: string;
  level: string;
  signature: string;
  /** Hourly counts, oldest first (hours without events are absent). */
  points: SeriesPoint[];
  /** Start of the newest scan's window: hours from here on are "recent", earlier ones the baseline. */
  recentFrom: Date;
  latestScanId?: number;
  /** Days (YYYY-MM-DD, UTC) some successful scan covered: a covered day without events had zero, not unknown. */
  coveredDays: string[];
  firstSeenAt: Date;
  /** Deployed version/image of the newest and the previous observation when the source reports it. */
  version?: string | null;
  previousVersion?: string | null;
  reopenedAt?: Date | null;
}

export interface Detection {
  kind: FindingKind;
  fingerprint: string;
  service: string;
  environment: string;
  signature: string;
  severity: Severity;
  confidence: Confidence;
  stats: Record<string, number | string | null>;
  evidence: Array<{ type: string; ref: string; at: string; value?: number }>;
  prodFingerprint?: string;
  proposedWorkflow: string | null;
  nextAction: string;
  signalAt: Date;
}

export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const mad = (xs: number[]) => {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
};
/** Robust z-score; the +1 floor keeps a perfectly flat baseline from turning any change into infinity. */
export const robustZ = (x: number, base: number[]) => (x - median(base)) / (1.4826 * mad(base) + 1);

const RETRY_SIGNATURE =
  /\bretr(?:y|ies|ying)\b|\battempt\s*#?\d|\bbackoff\b|\bre-?queue|\bredeliver|\bmax(?:imum)? attempts\b/i;

export const findingFingerprint = (parts: string[]) =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);

/** The steps are Radar's own; what counts as a crash or money (and so raises a step) is the scan's definition. */
export function severityOf(
  ratio: number,
  count: number,
  level: string,
  signature: string,
): Severity {
  let s: Severity = ratio >= 10 || count >= 1000 ? "high" : ratio >= 4 ? "medium" : "low";
  if (needsBump(level, signature))
    s = s === "low" ? "medium" : s === "medium" ? "high" : "critical";
  return s;
}

const iso = (d: Date) => d.toISOString();
const recurringSeverity = (count: number, s: ErrorSeries): Severity => {
  const v = severityOf(1, count, s.level, s.signature);
  return v === "low" ? "medium" : v;
};

/** Spikes, latency regressions, new signatures, retry storms, recurrences and deploy correlation for one series. */
export function detectSeries(
  s: ErrorSeries,
  t: RadarThresholds = DEFAULT_THRESHOLDS,
  now = new Date(),
): Detection[] {
  const pts = s.points;
  const recent = pts.filter((p) => p.at >= s.recentFrom);
  if (!recent.length) return [];
  const weekAgo = s.recentFrom.getTime() - 7 * 86_400_000;
  const base = pts
    .filter((p) => p.at < s.recentFrom && p.at.getTime() >= weekAgo)
    .map((p) => p.count);
  const recentTotal = recent.reduce((a, p) => a + p.count, 0);
  // Hourly rate of the recent window against the hourly baseline: windows of different length stay comparable.
  const rate = recentTotal / recent.length;
  const last = { at: recent[recent.length - 1].at, count: recentTotal };
  const history = base;
  const out: Detection[] = [];
  const latency = s.level === "SLOW";
  const evidence = [
    {
      type: latency ? "slow_requests" : "error_events",
      ref: `prod_error:${s.fingerprint}${s.latestScanId ? `@scan:${s.latestScanId}` : ""}`,
      at: iso(last.at),
      value: recentTotal,
    },
    ...recent.slice(-5).map((p) => ({
      type: "hourly",
      ref: `prod_error:${s.fingerprint}@hour`,
      at: iso(p.at),
      value: p.count,
    })),
  ];
  const make = (
    kind: FindingKind,
    severity: Severity,
    confidence: Confidence,
    stats: Detection["stats"],
    nextAction: string,
  ): Detection => ({
    kind,
    fingerprint: findingFingerprint(["prod", s.service, s.environment, s.level, s.signature]),
    service: s.service,
    environment: s.environment,
    signature: s.signature,
    severity,
    confidence,
    stats,
    evidence,
    prodFingerprint: s.fingerprint,
    proposedWorkflow: "production-incident-investigation",
    nextAction,
    signalAt: last.at,
  });

  const fresh = now.getTime() - s.firstSeenAt.getTime() <= 24 * 3_600_000;
  const priorActivity = history.some((c) => c > 0);
  if (!priorActivity && fresh && last.count >= t.minCount) {
    out.push(
      make(
        "new_signature",
        severityOf(10, last.count, s.level, s.signature),
        last.count >= t.minCount * 5 ? "high" : "medium",
        { count: last.count, baseline_median: 0, first_seen_at: iso(s.firstSeenAt) },
        "Investigate the new error signature: correlate traces and recent changes",
      ),
    );
  } else if (base.length >= t.minBaseline && last.count >= t.minCount) {
    const m = median(base);
    const z = robustZ(rate, base);
    const ratio = rate / Math.max(1, m);
    if (z >= t.zSpike && ratio >= t.ratioSpike)
      out.push(
        make(
          latency ? "latency_regression" : "error_spike",
          severityOf(ratio, last.count, s.level, s.signature),
          base.length >= 48 && z >= t.zSpike * 2 ? "high" : "medium",
          {
            recent_events: last.count,
            recent_hours: recent.length,
            hourly_rate: Math.round(rate * 10) / 10,
            baseline_hourly_median: m,
            baseline_hourly_mad: mad(base),
            baseline_hours: base.length,
            z: Math.round(z * 10) / 10,
            ratio: Math.round(ratio * 10) / 10,
          },
          latency
            ? "Investigate the latency regression: compare slow traces before and after the change point"
            : "Investigate the error spike: correlate with deployments and dependencies",
        ),
      );
  }
  const spiking = out.length > 0;
  if (spiking && RETRY_SIGNATURE.test(s.signature)) {
    const d = out[0];
    out.push({
      ...d,
      kind: "retry_pattern",
      nextAction:
        "Check whether the retried failure is retryable at all (non-retryable errors amplify load)",
    });
  }
  if (spiking && s.version && s.previousVersion && s.version !== s.previousVersion)
    out.push({
      ...out[0],
      kind: "deploy_correlated",
      stats: { ...out[0].stats, version: s.version, previous_version: s.previousVersion },
      nextAction: `Compare the deployment ${s.previousVersion} → ${s.version} with the error change point; consider rollback review`,
    });
  // Recurrence on DAILY totals of covered days (a covered day without events counts as zero): the signature went quiet
  // and came back several times, or a resolved incident reopened. A steady error is one episode, never "recurring".
  const since = now.getTime() - t.recurrenceDays * 86_400_000;
  const active = Math.max(1, Math.ceil(t.minCount / 4));
  const byDay = new Map<string, number>();
  for (const d of s.coveredDays)
    if (new Date(`${d}T00:00:00Z`).getTime() >= since - 86_400_000) byDay.set(d, 0);
  for (const p of pts) {
    const d = iso(p.at).slice(0, 10);
    if (byDay.has(d)) byDay.set(d, byDay.get(d)! + p.count);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  let episodes = 0;
  for (let i = 1; i < days.length; i++)
    if (days[i][1] >= active && days[i - 1][1] < active) episodes++;
  if (days[0] && days[0][1] >= active) episodes++;
  const reopened = !!s.reopenedAt && s.reopenedAt.getTime() >= since;
  if ((episodes >= t.recurringDays && last.count > 0) || (reopened && last.count > 0))
    out.push(
      make(
        "recurring_incident",
        recurringSeverity(last.count, s),
        reopened || episodes >= t.recurringDays + 2 ? "high" : "medium",
        { episodes, window_days: t.recurrenceDays, reopened: reopened ? iso(s.reopenedAt!) : null },
        "Recurring incident: look for the unresolved root cause (earlier fixes may have treated the symptom)",
      ),
    );
  return out;
}

/** Repeated failures of the same workflow step with the same normalized error, or repeated CI failures of a repo. */
export interface FailureGroup {
  scope: "workflow" | "ci";
  key: string;
  label: string;
  signature: string;
  runs: number[];
  lastAt: Date;
}
export function detectFailures(
  groups: FailureGroup[],
  t: RadarThresholds = DEFAULT_THRESHOLDS,
): Detection[] {
  return groups
    .filter((g) => new Set(g.runs).size >= t.persistentFailures)
    .map((g) => {
      const n = new Set(g.runs).size;
      return {
        kind: g.scope === "ci" ? ("ci_failures" as const) : ("workflow_failures" as const),
        fingerprint: findingFingerprint([g.scope, g.key, g.signature]),
        service: g.label,
        environment: g.scope,
        signature: g.signature,
        severity: n >= t.persistentFailures * 3 ? "high" : "medium",
        confidence: n >= t.persistentFailures * 2 ? "high" : "medium",
        stats: { failing: n, window_days: 7 },
        evidence: [...new Set(g.runs)].slice(-10).map((id) => ({
          type: g.scope === "ci" ? "pull_request" : "workflow_run",
          ref: `${g.scope === "ci" ? "pull_request" : "run"}:${id}`,
          at: iso(g.lastAt),
        })),
        proposedWorkflow: null,
        nextAction:
          g.scope === "ci"
            ? "Persistent CI failures: check the pipeline and recently merged changes"
            : "Persistent workflow failures: inspect the shared failure signature (environment, provider or definition)",
        signalAt: g.lastAt,
      };
    });
}

const SEV_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
/**
 * Correlation: detections sharing a fingerprint (same service/env/signature) become ONE finding with every kind, the
 * highest severity and confidence; findings of the same service and environment in the same pass are linked as related.
 */
export function correlate(ds: Detection[]) {
  const byFp = new Map<string, Detection & { kinds: FindingKind[] }>();
  for (const d of ds) {
    const cur = byFp.get(d.fingerprint);
    if (!cur) byFp.set(d.fingerprint, { ...d, kinds: [d.kind] });
    else {
      if (!cur.kinds.includes(d.kind)) cur.kinds.push(d.kind);
      if (SEV_RANK[d.severity] > SEV_RANK[cur.severity]) cur.severity = d.severity;
      if (CONF_RANK[d.confidence] > CONF_RANK[cur.confidence]) cur.confidence = d.confidence;
      cur.stats = { ...cur.stats, ...d.stats };
      if (d.kind === "deploy_correlated" || d.kind === "retry_pattern")
        cur.nextAction = d.nextAction;
    }
  }
  const findings = [...byFp.values()];
  for (const f of findings)
    (f as typeof f & { related: string[] }).related = findings
      .filter((o) => o !== f && o.service === f.service && o.environment === f.environment)
      .map((o) => o.fingerprint)
      .slice(0, 10);
  return findings as Array<Detection & { kinds: FindingKind[]; related: string[] }>;
}
export const severityRank = (s: string) => SEV_RANK[s as Severity] ?? 0;
