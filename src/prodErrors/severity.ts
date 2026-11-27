/**
 * What a production error text says about itself, and how a group of them is judged. Pure: scan.ts, the Go port
 * (go/internal/proderrors/severity.go) and Radar (src/radar/detect.ts) all use this one definition.
 *
 * The Go port must agree on every vector of go/internal/proderrors/testdata/{classify,severity}-vectors.json. Go's RE2
 * has no lookaround, so every regex rule is "matches this and does not match that" over plain patterns.
 */

export type Severity = "critical" | "high" | "medium" | "low";
const SEV: Severity[] = ["low", "low", "medium", "high", "critical"];
const FATAL_LEVEL = /^(FATAL|PANIC|DPANIC|CRITICAL)$/;

/** Always a crash, whatever else the line says. */
const CRASH_STRONG =
  /\bfatal error:|runtime: out of memory|\boomkilled\b|outofmemoryerror|all goroutines are asleep/i;
/** A crash unless the line says it was recovered or is a retryable database deadlock. */
const CRASH_WEAK =
  /\bpanic\b|nil pointer|invalid memory address|index out of range|\bdeadlock\b|out of memory/i;
const RECOVERED =
  /recovered (from )?(a )?panic|panic (was |has been )?recovered|recovered panic|recovering from panic/i;
const DB_DEADLOCK =
  /deadlock found|deadlock detected|try restarting transaction|er_lock_deadlock|sqlstate[ =:(]*(40001|40p01)/i;

const MONEY_ALWAYS =
  /refund|hoàn tiền|reconcil|sign(ature)? not match|invalid sign|checksum|\bipn\b|\bcod\b|chargeback/i;
const MONEY_PHRASE =
  /duplicate (payment|transaction|order|charge|refund|callback)|double (charge|refund|payment|spend|debit)|amount (mismatch|not match|invalid)/i;
/** Words that are money only next to a money context. */
const MONEY_WORD = /\b(charge|capture|settle(d|ment)?|callback|webhook|amount)\b/i;
const MONEY_CONTEXT =
  /payment|order|transaction|wallet|thanh toán|đơn hàng|zalopay|momo|vnpay|paypal|stripe/i;

export const isCrash = (text: string) =>
  CRASH_STRONG.test(text) ||
  (CRASH_WEAK.test(text) && !RECOVERED.test(text) && !DB_DEADLOCK.test(text));

export const isMoney = (text: string) =>
  MONEY_ALWAYS.test(text) ||
  MONEY_PHRASE.test(text) ||
  (MONEY_WORD.test(text) && MONEY_CONTEXT.test(text));

/** The crash rule as SPL (`match` is PCRE, case sensitive unless told), over the field `txt`. */
export function crashSpl(fatalLevels: string) {
  const re = (r: RegExp) =>
    `match(txt,"(?i)${r.source.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
  return `if(lv IN (${fatalLevels}) OR ${re(CRASH_STRONG)} OR (${re(CRASH_WEAK)} AND NOT (${re(RECOVERED)} OR ${re(DB_DEADLOCK)})),1,0)`;
}

/** A level or text that marks a crash or a money error: what raises a severity one step in Radar as well. */
export const needsBump = (level: string, text: string) =>
  FATAL_LEVEL.test(String(level).toUpperCase()) || isCrash(text) || isMoney(text);

/** Severity of one group from its level, text and today-vs-yesterday counts (the formula in force until v2 replaces it). */
export function assess(g: {
  level: string;
  signature: string;
  sample: string;
  today: number;
  yesterday: number;
  /** false = the source has no data for the comparison window: no new / up / down judgement. */
  baseline?: boolean;
}) {
  const reasons: string[] = [];
  const text = `${g.signature}\n${g.sample}`;
  let s = g.today >= 1000 ? 2 : 1;
  if (g.today >= 1000) reasons.push(`many|${g.today}`);
  if (FATAL_LEVEL.test(g.level) || isCrash(text)) {
    s = 4;
    reasons.push("panic");
  }
  let changed = false;
  if (g.baseline === false) {
    // nothing to compare with
  } else if (g.yesterday === 0) {
    reasons.push("new");
    s = Math.max(s, g.today >= 5 ? 3 : 2);
    changed = true;
  } else if (g.today >= 50 && g.today >= 3 * g.yesterday) {
    reasons.push(`up|${Math.round(g.today / g.yesterday)}|${g.yesterday}`);
    s = Math.max(s, 3);
    changed = true;
  } else if (g.today * 2 <= g.yesterday) reasons.push(`down|${g.yesterday}`);
  if (isMoney(text)) {
    reasons.push("money");
    // new/spiking money-related errors go up one level; critical only with real volume
    if (changed && g.today >= 5) s = Math.max(s, Math.min(g.today >= 50 ? 4 : 3, s + 1));
  }
  // Slowness alone is never an incident: one slow request is low, a new slow endpoint medium, only a spike is high.
  if (g.level === "SLOW")
    s = reasons.some((r) => r.startsWith("up|")) ? 3 : changed && g.today >= 5 ? 2 : 1;
  return {
    severity: SEV[s],
    score: s * 1000 + Math.min(999, Math.round(Math.log10(g.today + 1) * 100)),
    reasons,
  };
}

/** Thresholds of v2, configurable in config.prodErrors.severity and handed to the Go engine by the gateway. */
export interface SeverityThresholds {
  /** Events per hour from which a group is "many" (medium). */
  heavyRate: number;
  /** Events per hour from which an unchanged group is chronic (high). */
  chronicHigh: number;
  spikeRatio: number;
  /** A spike needs at least this many events per hour. */
  spikeMinRate: number;
  minNewCount: number;
  /** Windows shorter than this count as this long when a rate is taken. */
  minWindowHours: number;
  /** A window shorter than minWindowHours with fewer events than this is never judged above medium (crashes excepted). */
  minSampleCount: number;
  /** A group first seen within this many hours is still "new" when nothing happened yesterday. */
  newWithinHours: number;
}

export const DEFAULT_THRESHOLDS: SeverityThresholds = {
  heavyRate: 40,
  chronicHigh: 200,
  spikeRatio: 3,
  spikeMinRate: 6,
  minNewCount: 5,
  minWindowHours: 1,
  minSampleCount: 20,
  newWithinHours: 24,
};

/**
 * Severity v2: rates per hour instead of counts (a 1h and a 24h scan agree), new judged by when the signature was first
 * seen, a step for chronic high-volume errors, and no high verdict from a tiny sample in a very short window.
 */
export function assessV2(
  g: {
    level: string;
    signature: string;
    sample: string;
    today: number;
    yesterday: number;
    baseline?: boolean;
    windowHours: number;
    baselineHours: number;
    /** Hours since the signature was first stored, as of the window's end; null = never stored before. */
    firstSeenAgeHours: number | null;
  },
  t: SeverityThresholds = DEFAULT_THRESHOLDS,
) {
  const reasons: string[] = [];
  const text = `${g.signature}\n${g.sample}`;
  const rate = g.today / Math.max(g.windowHours, t.minWindowHours);
  const baseRate = g.yesterday / Math.max(g.baselineHours, t.minWindowHours);
  const crash = FATAL_LEVEL.test(g.level) || isCrash(text);
  let s = 1;
  if (rate >= t.heavyRate) {
    s = 2;
    reasons.push(`many|${g.today}`);
  }
  if (crash) {
    s = 4;
    reasons.push("panic");
  }
  let changed = false;
  let isNew = false;
  if (g.baseline === false) {
    // nothing to compare with
  } else if (g.yesterday === 0) {
    isNew = g.firstSeenAgeHours === null || g.firstSeenAgeHours <= t.newWithinHours;
    if (isNew) {
      reasons.push("new");
      s = Math.max(s, g.today >= t.minNewCount ? 3 : 2);
      changed = true;
    } else {
      reasons.push("returned");
      s = Math.max(s, 2);
    }
  } else if (rate >= t.spikeMinRate && rate >= t.spikeRatio * baseRate) {
    reasons.push(`up|${Math.round(g.today / g.yesterday)}|${g.yesterday}`);
    s = Math.max(s, 3);
    changed = true;
  } else if (g.today * 2 <= g.yesterday) reasons.push(`down|${g.yesterday}`);
  if (!isNew && rate >= t.chronicHigh) {
    reasons.push(`chronic|${Math.round(rate)}`);
    s = Math.max(s, 3);
  }
  if (isMoney(text)) {
    reasons.push("money");
    if (changed && g.today >= t.minNewCount)
      s = Math.max(s, Math.min(rate >= t.heavyRate ? 4 : 3, s + 1));
  }
  if (g.windowHours < t.minWindowHours && g.today < t.minSampleCount && !crash) s = Math.min(s, 2);
  if (g.level === "SLOW")
    s = reasons.some((r) => r.startsWith("up|")) ? 3 : changed && g.today >= t.minNewCount ? 2 : 1;
  return {
    severity: SEV[s],
    score: s * 1000 + Math.min(999, Math.round(Math.log10(g.today + 1) * 100)),
    reasons,
  };
}
