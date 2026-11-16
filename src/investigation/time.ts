/**
 * Time handling for production investigations. Pure functions, no I/O.
 *
 * Every observed timestamp keeps three things: the original text Splunk returned (never rewritten), an integer
 * microsecond epoch for ordering and arithmetic, and the precision actually present in the source ("s" | "ms" | "us").
 * Display strings are rendered in the investigation timezone (default Asia/Ho_Chi_Minh) with exactly the observed
 * precision — a second-precision event is never shown as ".000".
 */

export type Precision = "s" | "ms" | "us";

export interface ObservedTime {
  /** As received from the source, untouched. */
  original: string;
  /** Microseconds since the epoch (integer; safe up to year 2255). */
  epoch_us: number;
  precision: Precision;
  /** ISO-8601 in the investigation timezone with the observed precision, e.g. 2026-11-10T08:48:00.123+07:00. */
  iso: string;
  timezone: string;
  /** True when the source carried no offset and the investigation timezone was assumed. */
  assumed_timezone: boolean;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function assertTimezone(tz: string) {
  try {
    partsFormatter(tz);
  } catch {
    throw new Error(`unknown timezone "${tz}"`);
  }
}

/** Offset of `tz` from UTC at the given instant, in minutes (Asia/Ho_Chi_Minh → 420). */
export function tzOffsetMinutes(tz: string, epochMs: number): number {
  const p = Object.fromEntries(
    partsFormatter(tz)
      .formatToParts(new Date(epochMs))
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
}

/** Wall-clock time in `tz` → epoch ms (resolves DST by re-checking the offset at the candidate instant). */
export function zonedToEpochMs(
  tz: string,
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
  ms = 0,
): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  let guess = wall - tzOffsetMinutes(tz, wall) * 60_000;
  guess = wall - tzOffsetMinutes(tz, guess) * 60_000;
  return guess;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function offsetText(min: number) {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Render an epoch (µs) in `tz` with the given precision. */
export function formatInZone(epochUs: number, tz: string, precision: Precision = "ms"): string {
  const ms = Math.floor(epochUs / 1000);
  const off = tzOffsetMinutes(tz, ms);
  const d = new Date(ms + off * 60_000);
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const us = ((epochUs % 1_000_000) + 1_000_000) % 1_000_000;
  const frac =
    precision === "s"
      ? ""
      : precision === "ms"
        ? `.${pad(Math.floor(us / 1000), 3)}`
        : `.${pad(us, 6)}`;
  return `${base}${frac}${offsetText(off)}`;
}

function precisionOf(fraction: string | undefined): Precision {
  if (!fraction) return "s";
  return fraction.length <= 3 ? "ms" : "us";
}

function fractionUs(fraction: string | undefined): number {
  if (!fraction) return 0;
  return Number(fraction.slice(0, 6).padEnd(6, "0"));
}

/**
 * Parse a timestamp as Splunk (or a pasted export) returns it:
 *  - ISO-8601 with offset: 2026-11-10T08:48:00.123+07:00 / ...Z
 *  - ISO without offset (the investigation timezone is assumed and flagged)
 *  - epoch seconds with optional fraction: 1762739280.123456
 *  - Splunk time format: 11/10/2026:08:48:00 (investigation timezone assumed)
 * Returns null for anything else — callers must not invent a time.
 */
export function parseObservedTime(value: unknown, tz: string): ObservedTime | null {
  if (value === null || value === undefined) return null;
  const original = String(value).trim();
  if (!original) return null;
  const done = (epochUs: number, precision: Precision, assumed: boolean): ObservedTime => ({
    original,
    epoch_us: epochUs,
    precision,
    iso: formatInZone(epochUs, tz, precision),
    timezone: tz,
    assumed_timezone: assumed,
  });
  let m = original.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i,
  );
  if (m) {
    const [, y, mo, d, h, mi, s, frac, off] = m;
    const fu = fractionUs(frac);
    if (off) {
      const sign = off === "Z" || off === "z" ? 0 : off[0] === "-" ? -1 : 1;
      const digits = off.replace(/[^0-9]/g, "");
      const offMin =
        sign === 0 ? 0 : sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
      const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - offMin * 60_000;
      return done(ms * 1000 + fu, precisionOf(frac), false);
    }
    return done(zonedToEpochMs(tz, +y, +mo, +d, +h, +mi, +s) * 1000 + fu, precisionOf(frac), true);
  }
  m = original.match(/^(\d{9,11})(?:\.(\d{1,9}))?$/);
  if (m) return done(Number(m[1]) * 1_000_000 + fractionUs(m[2]), precisionOf(m[2]), false);
  m = original.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}):(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/);
  if (m) {
    const [, mo, d, y, h, mi, s, frac] = m;
    return done(
      zonedToEpochMs(tz, +y, +mo, +d, +h, +mi, +s) * 1000 + fractionUs(frac),
      precisionOf(frac),
      true,
    );
  }
  return null;
}

/** Splunk's absolute time modifier syntax (%m/%d/%Y:%H:%M:%S) for an epoch, in `tz` — for display and Splunk Web URLs. */
export function splunkTimeText(epochMs: number, tz: string): string {
  const off = tzOffsetMinutes(tz, epochMs);
  const d = new Date(epochMs + off * 60_000);
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}:${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * A Splunk time modifier (earliest=/latest= value) → epoch ms. Absolute values are read in `tz`; relative ones
 * (-15m, -2h@h, now) relative to `now`. Snap-to (@) is honoured for s/m/h/d.
 */
export function parseTimeModifier(raw: string, tz: string, now = Date.now()): number {
  const v = raw.trim().replace(/^["']|["']$/g, "");
  if (/^now(\(\))?$/i.test(v) || v === "") return now;
  const abs = parseObservedTime(v, tz);
  if (abs) return Math.floor(abs.epoch_us / 1000);
  const m = v.match(
    /^([+-])(\d+)(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|week|weeks)(?:@(s|m|h|d))?$/i,
  );
  if (m) {
    const unit = m[3][0].toLowerCase();
    const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit as "s"]!;
    let t = now + (m[1] === "-" ? -1 : 1) * Number(m[2]) * mult;
    if (m[4]) {
      const snap = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[4].toLowerCase() as "s"]!;
      const off = tzOffsetMinutes(tz, t) * 60_000;
      t = Math.floor((t + off) / snap) * snap - off;
    }
    return t;
  }
  throw new Error(
    `unsupported time modifier "${raw}" (use an absolute time like 11/10/2026:08:35:00, an ISO time, or -15m)`,
  );
}

/** Human duration with the precision the inputs allow: 1.234 s, 2 min 5.000 s, 350 ms. */
export function formatDuration(us: number, precision: Precision): string {
  const neg = us < 0;
  const a = Math.abs(us);
  const ms = a / 1000;
  const digits = precision === "s" ? 0 : precision === "ms" ? 3 : 6;
  let out: string;
  if (ms < 1000 && precision !== "s") out = `${ms.toFixed(precision === "us" ? 3 : 0)} ms`;
  else if (ms < 60_000) out = `${(ms / 1000).toFixed(digits)} s`;
  else {
    const min = Math.floor(ms / 60_000);
    const rest = (ms - min * 60_000) / 1000;
    out =
      min >= 60
        ? `${Math.floor(min / 60)} h ${min % 60} min ${rest.toFixed(digits)} s`
        : `${min} min ${rest.toFixed(digits)} s`;
  }
  return neg ? `-${out}` : out;
}

/** The coarser of two precisions — a difference is only as precise as its least precise operand. */
export const coarser = (a: Precision, b: Precision): Precision =>
  a === "s" || b === "s" ? "s" : a === "ms" || b === "ms" ? "ms" : "us";
