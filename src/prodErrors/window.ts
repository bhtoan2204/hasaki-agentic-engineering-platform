/** Scan windows: presets, baselines and the configured namespaces (shared by the scan, its job queue and gateway). */
import { config } from "../config.ts";

/** Local calendar day and seconds since local midnight of `d` in time zone `tz`. */
export function zoned(d: Date, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hm: `${p.hour}:${p.minute}`,
    seconds: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second),
  };
}

/** Time presets offered by the page; "custom" takes explicit from/to. */
export const SCAN_PRESETS = ["1h", "4h", "12h", "24h", "today", "yesterday", "custom"] as const;
export type ScanPreset = (typeof SCAN_PRESETS)[number];
export interface ScanOptions {
  /** Subset of config.prodErrors.namespaces; empty/omitted = all. */
  namespaces?: string[];
  preset?: ScanPreset;
  /** ISO timestamps, for preset "custom". */
  from?: string;
  to?: string;
}
/** Longest custom window: the window plus its baseline must stay inside Splunk's search limit. */
export const MAX_CUSTOM_HOURS = 72;

/**
 * Scan window and the baseline it is compared with, as epoch seconds. Windows up to 24h are compared with the same
 * window 24h earlier (time-of-day effects cancel out); longer ones with the period just before them.
 */
export function scanWindow(
  opts: Pick<ScanOptions, "preset" | "from" | "to"> = {},
  now = new Date(),
  tz = config.prodErrors.timezone,
) {
  const preset: ScanPreset = opts.preset ?? "today";
  if (!SCAN_PRESETS.includes(preset))
    throw Object.assign(new Error(`khung thời gian không hợp lệ: ${preset}`), { status: 400 });
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const midnight = nowEpoch - zoned(now, tz).seconds;
  let start: number, end: number;
  if (preset === "today") {
    start = midnight;
    end = nowEpoch;
  } else if (preset === "yesterday") {
    start = midnight - 86400;
    end = midnight;
  } else if (preset === "custom") {
    start = Math.floor(Date.parse(opts.from ?? "") / 1000);
    end = Math.min(nowEpoch, Math.floor(Date.parse(opts.to ?? "") / 1000));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      throw Object.assign(new Error("khung tuỳ chọn cần 'từ' trước 'đến' (và không ở tương lai)"), {
        status: 400,
      });
    if (end - start > MAX_CUSTOM_HOURS * 3600)
      throw Object.assign(new Error(`khung tuỳ chọn tối đa ${MAX_CUSTOM_HOURS} giờ`), {
        status: 400,
      });
  } else {
    start = nowEpoch - Number(preset.replace("h", "")) * 3600;
    end = nowEpoch;
  }
  const shift = end - start <= 86400 ? 86400 : end - start;
  const baseStart = start - shift;
  if ((nowEpoch - baseStart) / 60 > config.splunk.maxMinutes)
    throw Object.assign(
      new Error(
        "khung quá xa trong quá khứ: Splunk chỉ cho tìm trong 7 ngày gần nhất (gồm cả kỳ so sánh)",
      ),
      { status: 400 },
    );
  const ze = zoned(new Date((end - 1) * 1000), tz); // the last second inside the window (yesterday ends at midnight)
  return {
    preset,
    compare: shift === 86400 ? ("yesterday" as const) : ("previous" as const),
    day: ze.date,
    hm: zoned(now, tz).hm,
    start,
    end,
    now: nowEpoch,
    baseStart,
    baseEnd: end - shift,
    /** Splunk search bounds (relative minutes) covering window + baseline. */
    minutes: Math.ceil((nowEpoch - baseStart) / 60) + 1,
    untilMinutes: Math.max(0, Math.floor((nowEpoch - end) / 60) - 1),
  };
}
export type ScanWindow = ReturnType<typeof scanWindow>;

/** Today (local) from midnight to now, and yesterday over the same time-of-day window, as epoch seconds. */
export function dayWindow(now: Date, tz = config.prodErrors.timezone) {
  const w = scanWindow({ preset: "today" }, now, tz);
  return { ...w, yesterdayStart: w.baseStart, yesterdayEnd: w.baseEnd };
}

/** Splunk index holding a namespace's logs. */
export function indexOf(namespace: string) {
  return (
    config.prodErrors.namespaces.find((n) => n.namespace === namespace)?.index ??
    config.prodErrors.index
  );
}

/** Configured namespaces, restricted to `wanted` when given (unknown names are rejected, not ignored). */
export function scanNamespaces(wanted?: string[]) {
  const all = config.prodErrors.namespaces;
  if (!wanted?.length) return all;
  const unknown = wanted.filter((n) => !all.some((x) => x.namespace === n));
  if (unknown.length)
    throw Object.assign(new Error(`namespace không có trong cấu hình: ${unknown.join(", ")}`), {
      status: 400,
    });
  return all.filter((x) => wanted.includes(x.namespace));
}
