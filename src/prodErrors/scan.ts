import { createHash } from "node:crypto";
import { config } from "../config.ts";
import { pool, q, one, type Db } from "../db/pool.ts";
import { currentUserId } from "../auth/execution.ts";
import { activeScan, enqueueScan, firstToday, recoverScans, type ScanTrigger } from "./jobs.ts";
import { settings } from "../db.ts";
import { splunkConnected, splunkExpired } from "../integrations/splunk.ts";
import {
  signozEnabled,
  type signozTraceGaps,
  type SlowRequestGroup,
  signozStatus,
  type SpanErrorGroup,
} from "../integrations/signoz.ts";
import { redactPii } from "../integrations/redact.ts";
import { assess, assessV2, crashSpl, isCrash, type SeverityThresholds } from "./severity.ts";
import { ensureTestOwner } from "../auth/testOwner.ts";
import { workItems } from "../workitems/service.ts";
import { startRun } from "../workflow/engine.ts";
import { ingestProdErrorGroups } from "../workitems/intake.ts";
import { escapeHtml as esc, linkFooter, RULE, sendTelegramHtml } from "../telegram.ts";

/**
 * Daily production error scan (page "Lỗi production").
 *
 * One fixed, read-only SPL search (no LLM) over today's logs of the configured namespaces, compared with yesterday over
 * the same time-of-day window. When the scanning user also connected SigNoz, its error traces (`has_error = true`) of the
 * same namespaces and windows are counted per service, span and status and merged as their own groups (a group with the
 * same key in both sources keeps the larger counts). Errors are grouped by a signature (message with ids/numbers/hashes replaced), scored
 * (panic, new since yesterday, spike, money-related) and stored. "Điều tra" turns a group into a Bug Investigation work
 * item; the workflow still stops for the developer's approval before any fix. Scheduled scans notify Telegram about new
 * critical/high groups once per day.
 */

export type Severity = "critical" | "high" | "medium" | "low";
export type ScanSource = "splunk" | "signoz";

export interface GroupRow {
  fingerprint: string;
  namespace: string;
  service: string;
  level: string;
  caller: string;
  signature: string;
  sample: string;
  detail: {
    err?: string;
    image?: string;
    request_id?: string;
    trace_id?: string;
    stack?: string;
    pod?: string;
    sources?: ScanSource[];
    /** The only source of this group had no data for the comparison window. */
    no_baseline?: boolean;
    slow?: SlowDetail;
    /** The verdict of the formula that did not decide (see GroupContext). */
    severity_v1?: { severity: Severity; score: number; reasons: string[] };
    severity_v2?: { severity: Severity; score: number; reasons: string[] };
  };
  day: string;
  today_count: number;
  yesterday_count: number;
  first_at: string | null;
  last_at: string | null;
  severity: Severity;
  score: number;
  reasons: string[];
  status: "open" | "ignored";
  work_item_id: number | null;
  notified_day: string | null;
  /** The level last announced (a rise announces it again); null = never announced or re-armed. */
  notified_severity?: Severity | null;
  ignored_until?: string | null;
  first_seen_at: string;
}

// ---------------------------------------------------------------- time window (src/prodErrors/window.ts)

export {
  dayWindow,
  indexOf,
  MAX_CUSTOM_HOURS,
  SCAN_PRESETS,
  scanNamespaces,
  scanWindow,
  zoned,
  type ScanOptions,
  type ScanPreset,
  type ScanWindow,
} from "./window.ts";
import {
  dayWindow,
  indexOf,
  MAX_CUSTOM_HOURS,
  SCAN_PRESETS,
  zoned,
  type ScanOptions,
  type ScanWindow,
} from "./window.ts";
import { log } from "../logging.ts";

// ---------------------------------------------------------------- search

const LEVELS = ["ERROR", "FATAL", "PANIC", "DPANIC", "CRITICAL"];
/** Groups kept per source: the most frequent ones, crash groups first. */
export const SOURCE_CAP = 300;

/** The plain text level rule (Phase 1 extra levels): a line that starts, after a timestamp, with a level word. */
const TEXT_LEVEL = /^[0-9TZ:.,+\-/[\] ]{0,40}(?<tl>ERROR|FATAL|PANIC|CRITICAL)\b/i;
const splString = (re: RegExp) => re.source.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const FATAL_LEVELS = ["FATAL", "PANIC", "DPANIC", "CRITICAL"];

/**
 * Both log shapes seen in k8s_prod: payment services log JSON at the top level (level/message/caller), OMS services'
 * JSON sits inside the container `log` string (spath input=log). Plain lines (gorm SQL, librdkafka) only count when they
 * are a Go panic / fatal error. With `extraLevels`, the level may also come from `severity`, `lvl` or `log.level`, and
 * a plain text line counts when it starts with a level word after its timestamp.
 *
 * The groups come back crash first (`is_crash`), then by count, and the search asks for one row more than the cap so a
 * cut can be told: a rare panic is never pushed out by 300 noisier groups.
 */
export function buildScanSpl(
  w: ScanWindow,
  namespaces = config.prodErrors.namespaces,
  opts: { extraLevels?: boolean } = {},
) {
  const extra = opts.extraLevels ?? config.prodErrors.extraLevels;
  const byIndex = new Map<string, string[]>();
  for (const n of namespaces) {
    const index = indexOf(n.namespace);
    byIndex.set(index, [...(byIndex.get(index) ?? []), `"${n.namespace}"`]);
  }
  const scope = [...byIndex]
    .map(([index, ns]) => `(index=${index} kubernetes.namespace_name IN (${ns.join(",")}))`)
    .join(" OR ");
  const inWindow = `(_time>=${w.start} AND _time<=${w.end})`;
  const level = extra ? "coalesce(level,LEVEL,severity,lvl,'log.level')" : "coalesce(level,LEVEL)";
  return [
    `search ${byIndex.size > 1 ? `(${scope})` : scope} (${LEVELS.join(" OR ")} OR "panic:" OR "fatal error")`,
    `where ${inWindow} OR (_time>=${w.baseStart} AND _time<=${w.baseEnd})`,
    `spath input=log`,
    `eval lv=upper(${level}), msg=coalesce(message,MESSAGE,msg,log,_raw), err=coalesce(error,err), ns='kubernetes.namespace_name', svc='kubernetes.container_name'`,
    ...(extra
      ? [
          `rex field=msg "(?i)${splString(TEXT_LEVEL)}"`,
          `eval lv=if(isnull(lv) AND isnotnull(tl), upper(tl), lv)`,
        ]
      : []),
    `where lv IN (${LEVELS.map((l) => `"${l}"`).join(",")}) OR (isnull(lv) AND match(msg,"^(panic:|fatal error:)"))`,
    `eval day=if(${inWindow},"t","y")`,
    String.raw`eval sig=substr(msg . if(isnull(err), "", " :: " . err), 1, 400), sig=replace(sig,"[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}","<uuid>"), sig=replace(sig,"\\b[0-9a-fA-F]{16,}\\b","<hex>"), sig=replace(sig,"\\b[A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]*\\b","<n>"), sig=replace(sig,"\\s+"," "), sig=substr(sig,1,200)`,
    `eval txt=msg . " " . coalesce(err,"")`,
    `eval crash=${crashSpl(FATAL_LEVELS.map((l) => `"${l}"`).join(","))}`,
    `eval analytics_hour=floor(_time/3600)*3600`,
    `eventstats count AS analytics_hour_count by ns svc lv sig day analytics_hour`,
    `eval analytics_hour_point=if(day="t", tostring(analytics_hour).":".tostring(analytics_hour_count), null())`,
    `stats values(analytics_hour_point) as analytics_hourly count(eval(day="t")) as today count(eval(day="y")) as yesterday min(eval(if(day="t",_time,null()))) as first max(_time) as last latest(msg) as sample latest(err) as err latest(caller) as caller latest(kubernetes.container_image) as image latest(request_id) as request_id latest(stacktrace) as stack latest(kubernetes.pod_name) as pod max(crash) as is_crash by ns svc lv sig`,
    `where today>0`,
    `eval rank=is_crash*1000000000+today`,
    `sort - rank`,
    `head ${SOURCE_CAP + 1}`,
  ].join(" | ");
}

export { assess } from "./severity.ts";

export const fingerprint = (ns: string, svc: string, level: string, sig: string) =>
  createHash("sha1").update([ns, svc, level, sig].join("\u0000")).digest("hex").slice(0, 20);

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const iso = (v: unknown) =>
  v == null || v === "" ? null : new Date(Number(v) * 1000).toISOString();
const str = (v: unknown, max: number) =>
  v == null ? "" : String(Array.isArray(v) ? v[0] : v).slice(0, max);

/** The severity thresholds as configured (config.prodErrors.severity without its flag). */
export function severityThresholds(): SeverityThresholds {
  const { v2: _v2, ...thresholds } = config.prodErrors.severity;
  return thresholds;
}

/**
 * What severity v2 needs beyond the row: the window's length in hours, when each signature was first stored
 * (epoch seconds by fingerprint) and the thresholds. `v2` says which verdict is the group's severity; the other rides
 * along in `detail` (`severity_v2` while v1 decides, `severity_v1` once v2 does) to compare them on real data.
 */
export interface GroupContext {
  windowHours: number;
  baselineHours: number;
  /** End of the scan window, epoch seconds. */
  windowEnd: number;
  known: Record<string, number>;
  thresholds: SeverityThresholds;
  v2: boolean;
}

/** Splunk result rows → group rows (exported for tests). */
export function toGroups(rows: Partial<SourceRow>[], day: string, ctx?: GroupContext) {
  return rows.map((r) => {
    const level = str(r.lv, 20) || "ERROR";
    const signature = str(r.sig, 200);
    const sample = str(r.sample, 2000);
    const today = num(r.today);
    const yesterday = num(r.yesterday);
    const fp = fingerprint(str(r.ns, 100), str(r.svc, 100), level, signature);
    const v1 = assess({ level, signature, sample, today, yesterday, baseline: !r.no_baseline });
    const first = ctx?.known[fp];
    const v2 = ctx
      ? assessV2(
          {
            level,
            signature,
            sample,
            today,
            yesterday,
            baseline: !r.no_baseline,
            windowHours: ctx.windowHours,
            baselineHours: ctx.baselineHours,
            firstSeenAgeHours: first === undefined ? null : (ctx.windowEnd - first) / 3600,
          },
          ctx.thresholds,
        )
      : null;
    const decided = ctx?.v2 && v2 ? v2 : v1;
    return {
      fingerprint: fp,
      namespace: str(r.ns, 100),
      service: str(r.svc, 100),
      level,
      caller: str(r.caller, 200),
      signature,
      sample,
      detail: {
        err: str(r.err, 1000) || undefined,
        image: str(r.image, 300) || undefined,
        request_id: str(r.request_id, 100) || undefined,
        trace_id: str(r.trace_id, 100) || undefined,
        stack: str(r.stack, 2500) || undefined,
        pod: str(r.pod, 100) || undefined,
        sources:
          Array.isArray(r.sources) && r.sources.length ? (r.sources as ScanSource[]) : undefined,
        no_baseline: r.no_baseline || undefined,
        slow: r.slow,
        ...(ctx && v2 ? (ctx.v2 ? { severity_v1: v1 } : { severity_v2: v2 }) : {}),
      },
      hourly: (Array.isArray(r.analytics_hourly)
        ? r.analytics_hourly
        : r.analytics_hourly
          ? [r.analytics_hourly]
          : []
      ).flatMap((point: unknown) => {
        const match = /^(\d+):(\d+)$/.exec(String(point));
        if (!match) return [];
        const epoch = Number(match[1]) * 1000,
          count = Number(match[2]);
        if (!Number.isFinite(epoch) || epoch > 8.64e15 || !Number.isSafeInteger(count)) return [];
        return [{ hour: new Date(epoch).toISOString(), count }];
      }),
      day,
      today_count: today,
      yesterday_count: yesterday,
      first_at: iso(r.first),
      last_at: iso(r.last),
      ...decided,
    };
  });
}

// ---------------------------------------------------------------- SigNoz rows and merging

/** The SPL signature, computed in TypeScript: ids, hashes and numbers replaced so one error is one group. */
export function signatureOf(msg: string, err?: string) {
  return (msg + (err ? ` :: ${err}` : ""))
    .slice(0, 400)
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}/g, "<uuid>")
    .replace(/\b[0-9a-fA-F]{16,}\b/g, "<hex>")
    .replace(/\b[A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]*\b/g, "<n>")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

const text = (v: unknown) => (v == null || v === "" ? undefined : String(v));
const masked = (v: string | undefined) => (v === undefined ? v : redactPii(v));

/** How an error span reads in the list: span name, status code and status message. */
const spanMessage = (g: { name: string; code: string; status: string }) =>
  `${g.name}${g.code ? ` [${g.code}]` : ""}${g.status ? `: ${g.status}` : ""}`;

/** One group as a result row of the SPL `stats` stage; SigNoz rows are built in the same shape. */
/** Latency group: request statistics and where the slowest sample request spent untraced time. */
export interface SlowDetail {
  threshold_ms: number;
  total: number;
  p50_ms: number;
  p95_ms: number;
  max_ms?: number;
  gaps?: Array<{
    in: string;
    after: string | null;
    before: string | null;
    gap_ms: number;
    share: number;
  }>;
}

export interface SourceRow {
  ns: string;
  svc: string;
  lv: string;
  sig: string;
  today: number | string;
  yesterday: number | string;
  first?: number | string;
  last?: number | string;
  sample?: string;
  err?: string;
  caller?: string;
  image?: string;
  request_id?: string;
  trace_id?: string;
  stack?: string;
  pod?: string;
  no_baseline?: boolean;
  analytics_hourly?: string | string[];
  sources?: ScanSource[];
  slow?: SlowDetail;
  /** 1 when any event of the group is a crash (Splunk computes it before the cap). */
  is_crash?: string | number;
}

/** A row that must survive the per-source cap: marked by the search, a fatal level or a crash text. */
export function rowIsCrash(r: Pick<SourceRow, "lv" | "sig" | "sample" | "is_crash">) {
  return (
    Number(r.is_crash) > 0 ||
    FATAL_LEVELS.includes(String(r.lv ?? "").toUpperCase()) ||
    isCrash(`${r.sig}\n${r.sample ?? ""}`)
  );
}

/** The per-source cap: crash groups first, then by today; `truncated` says something was cut. */
export function capSourceRows(rows: SourceRow[], limit = SOURCE_CAP) {
  const ranked = [...rows].sort(
    (a, b) => Number(rowIsCrash(b)) - Number(rowIsCrash(a)) || num(b.today) - num(a.today),
  );
  return { rows: ranked.slice(0, limit), truncated: rows.length > limit };
}

/**
 * Namespace values a SigNoz error query reported against the configured namespaces. Degraded when none of them is
 * configured (the namespace attribute is probably not the Kubernetes namespace); the values are never remapped, since
 * the namespace is part of a group's fingerprint.
 */
export function namespaceMapping(found: string[], configured: string[]) {
  const distinct = [...new Set(found.filter(Boolean))];
  const unknown = distinct.filter((n) => !configured.includes(n));
  return { degraded: distinct.length > 0 && unknown.length === distinct.length, unknown };
}

/** What a Splunk search says about being cut short (auto-finalized at its time limit, results incomplete). */
export function partialReasons(messages: unknown) {
  return (Array.isArray(messages) ? messages.map(String) : []).filter(
    (m) =>
      !/^(INFO|DEBUG)\b/i.test(m) &&
      /finaliz|time ?limit|max_time|truncat|incomplete|partial|exceed/i.test(m),
  );
}

/**
 * SigNoz error span groups (window hourly, baseline totals) → result rows shaped like the SPL `stats` output. Span
 * groups whose messages differ only in ids or numbers share one signature and are added up (exported for tests).
 */
export function signozRows(
  today: SpanErrorGroup[],
  baseline: SpanErrorGroup[],
  samples: Array<{ timestamp: string; data: Record<string, unknown> }> = [],
  hasBaseline = true,
) {
  type G = SourceRow & { today: number; yesterday: number; hourly: Map<number, number> };
  const groups = new Map<string, G>();
  const keyOf = (g: SpanErrorGroup) => {
    const sig = redactPii(
      signatureOf(`${g.name}${g.code ? ` [${g.code}]` : ""}`, g.status || undefined),
    );
    return { key: [g.ns, g.service, "ERROR", sig].join("\u0000"), sig };
  };
  const at = (g: SpanErrorGroup) => {
    const { key, sig } = keyOf(g);
    let row = groups.get(key);
    if (!row) {
      row = {
        ns: g.ns,
        svc: g.service,
        lv: "ERROR",
        sig,
        today: 0,
        yesterday: 0,
        hourly: new Map(),
        sources: ["signoz"],
      };
      if (!hasBaseline) row.no_baseline = true;
      groups.set(key, row);
    }
    return row;
  };
  for (const g of today) {
    const row = at(g);
    row.today += g.count;
    row.sample ??= redactPii(spanMessage(g));
    row.err ??= masked(text(g.status));
    row.caller ??= masked(text(g.name));
    for (const [hour, n] of g.hourly) {
      row.hourly.set(hour, (row.hourly.get(hour) ?? 0) + n);
      row.first = Math.min(Number(row.first ?? Infinity), hour);
      row.last = Math.max(Number(row.last ?? 0), hour);
    }
  }
  for (const g of baseline) {
    const row = groups.get(keyOf(g).key);
    if (row) row.yesterday += g.count;
  }
  // Newest spans first: the first span matching a group gives its trace id and a more precise last time. A sample that
  // carries a status message or code belongs to the group with exactly those; one without them matches on service and name.
  for (const s of samples) {
    const d = s.data;
    const time = Math.floor(Date.parse(s.timestamp) / 1000);
    const exact = d.status_message !== undefined || d.response_status_code !== undefined;
    const sig = exact
      ? redactPii(
          signatureOf(
            `${text(d.name) ?? ""}${text(d.response_status_code) ? ` [${text(d.response_status_code)}]` : ""}`,
            text(d.status_message),
          ),
        )
      : "";
    for (const row of groups.values()) {
      if (
        row.trace_id ||
        row.svc !== text(d["service.name"]) ||
        row.caller !== masked(text(d.name)) ||
        (exact && row.sig !== sig)
      )
        continue;
      row.trace_id = text(d.trace_id);
      if (Number.isFinite(time)) row.last = Math.max(Number(row.last ?? 0), time);
      break;
    }
  }
  return capSourceRows([...groups.values()].filter((g) => g.today > 0) as unknown as SourceRow[])
    .rows.map((g) => g as unknown as SourceRow & { hourly: Map<number, number> })
    .map(({ hourly, ...g }): SourceRow => ({
      ...g,
      analytics_hourly: [...hourly].sort(([a], [b]) => a - b).map(([hour, n]) => `${hour}:${n}`),
    }));
}

/**
 * SigNoz latency groups → result rows with level SLOW (one per entry span). The slowest sample of each group gives its
 * trace id, request id and maximum duration (exported for tests).
 */
export function signozSlowRows(
  today: SlowRequestGroup[],
  baseline: SlowRequestGroup[],
  samples: Array<{ timestamp: string; data: Record<string, unknown> }>,
  thresholdMs: number,
) {
  // Entry spans differing only in ids (/order/123, /order/456) share one signature: one group, counts added up.
  const sigOf = (name: string) => redactPii(signatureOf(name));
  const keyOf = (g: { ns: string; service: string; name: string }) =>
    [g.ns, g.service, sigOf(g.name)].join("\u0000");
  const before = new Map<string, number>();
  for (const g of baseline) before.set(keyOf(g), (before.get(keyOf(g)) ?? 0) + g.slow);
  const merged = new Map<string, SlowRequestGroup>();
  for (const g of today) {
    const prev = merged.get(keyOf(g));
    const busiest = !prev || g.total > prev.total ? g : prev;
    merged.set(keyOf(g), {
      ...busiest,
      slow: (prev?.slow ?? 0) + g.slow,
      total: (prev?.total ?? 0) + g.total,
    });
  }
  return [...merged.values()].slice(0, 300).map((g): SourceRow => {
    const s = samples.find(
      (x) =>
        text(x.data["service.name"]) === g.service &&
        sigOf(String(x.data.name ?? "")) === sigOf(g.name),
    )?.data;
    const max = s ? Math.round(Number(s.duration_nano ?? 0) / 1e6) : undefined;
    const reqId = s && text(s["request.id"] ?? s.request_id);
    return {
      ns: g.ns,
      svc: g.service,
      lv: "SLOW",
      sig: sigOf(g.name),
      caller: masked(text(g.name)),
      today: g.slow,
      yesterday: before.get(keyOf(g)) ?? 0,
      sample: `${g.slow}/${g.total} request > ${thresholdMs}ms · p50 ${g.p50_ms}ms · p95 ${g.p95_ms}ms${max ? ` · chậm nhất ${max}ms` : ""}`,
      trace_id: s && text(s.trace_id),
      request_id: reqId,
      sources: ["signoz"],
      slow: {
        threshold_ms: thresholdMs,
        total: g.total,
        p50_ms: g.p50_ms,
        p95_ms: g.p95_ms,
        max_ms: max,
      },
    };
  });
}

/**
 * Splunk and SigNoz result rows → one row per group. Both sources usually hold the same cluster logs, so a group
 * seen by both keeps the larger count instead of the sum (exported for tests).
 */
export function mergeSourceRows(...sources: Array<{ source: ScanSource; rows: SourceRow[] }>) {
  const merged = new Map<
    string,
    SourceRow & { sources: ScanSource[]; analytics_hourly: string[] }
  >();
  // Each source keeps its own 300 largest groups: a busy log source must not push every trace group out.
  for (const { source, rows } of sources)
    for (const r of capSourceRows(rows).rows) {
      const key = [r.ns, r.svc, String(r.lv ?? "").toUpperCase() || "ERROR", r.sig].join("\u0000");
      const prev = merged.get(key);
      const hourly = (h: unknown) => (Array.isArray(h) ? h : h ? [h] : []).map(String);
      if (!prev) {
        merged.set(key, { ...r, sources: [source], analytics_hourly: hourly(r.analytics_hourly) });
        continue;
      }
      const hours = new Map<string, number>();
      for (const point of [...prev.analytics_hourly, ...hourly(r.analytics_hourly)]) {
        const [h, n] = point.split(":");
        hours.set(h, Math.max(hours.get(h) ?? 0, Number(n) || 0));
      }
      const finite = (...v: unknown[]) => v.map(Number).filter((x) => Number.isFinite(x) && x > 0);
      merged.set(key, {
        ...r,
        ...prev,
        today: Math.max(num(prev.today), num(r.today)),
        yesterday: Math.max(num(prev.yesterday), num(r.yesterday)),
        // Rows without times (latency groups) must not turn into ±Infinity.
        first: finite(prev.first, r.first).length
          ? Math.min(...finite(prev.first, r.first))
          : (prev.first ?? r.first),
        last: finite(prev.last, r.last).length
          ? Math.max(...finite(prev.last, r.last))
          : (prev.last ?? r.last),
        sources: [...new Set([...prev.sources, source])],
        no_baseline: (prev.no_baseline && r.no_baseline) || undefined,
        analytics_hourly: [...hours].map(([h, n]) => `${h}:${n}`),
      });
    }
  return [...merged.values()].sort((a, b) => num(b.today) - num(a.today));
}

// ---------------------------------------------------------------- scan

/** Whether a scan is queued or running on any instance. */
export const scanning = async () => !!(await activeScan());

/** What the running scan is doing, for the page's progress bar (stored on the scan row: every instance sees it). */
export interface ScanProgress {
  phase: "connect" | "search" | "group" | "save" | "notify";
  /** 0–100 over the whole scan */
  pct: number;
  /** Splunk's own progress of the search, 0–100 */
  searchPct: number;
  splunkState?: string;
  scanned: number;
  matched: number;
  startedAt: string;
}

/**
 * Queue a scan (one at a time across all instances). Options are validated before anything is stored; platform-go
 * claims and runs it.
 */
export async function startScan(
  trigger: ScanTrigger,
  opts: ScanOptions = {},
  input: { requestedBy?: number | null; dedupeKey?: string } = {},
) {
  const requestedBy = input.requestedBy ?? currentUserId() ?? null;
  const r = await enqueueScan(trigger, opts, { requestedBy, dedupeKey: input.dedupeKey });
  return { started: r.started, running: r.running, ...(r.job ? { scan_id: r.job.id } : {}) };
}

/**
 * Queue a scan and wait until platform-go finishes it (tests, CLI). Rejects with the scan's error when it failed.
 */
export async function runScan(trigger: ScanTrigger, now = new Date(), opts: ScanOptions = {}) {
  const r = await enqueueScan(trigger, opts, { requestedBy: currentUserId() ?? null, now });
  if (!r.job) throw Object.assign(new Error("một lượt quét khác đang chạy"), { status: 409 });
  const deadline = Date.now() + (config.prodErrors.timeoutSeconds + 120) * 1000;
  for (;;) {
    const row = await one<{ status: string; error: string | null; groups: number | null }>(
      pool,
      "SELECT status, error, groups FROM prod_error_scans WHERE id = $1",
      [r.job.id],
    );
    if (row?.status === "succeeded") return { ok: true, groups: row.groups ?? 0 };
    if (row && row.status !== "queued" && row.status !== "running")
      throw new Error(row.error ?? `scan ${row.status}`);
    if (Date.now() > deadline) throw new Error(`scan ${r.job.id} did not finish in time`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

/** The three largest untraced gaps of a trace, span names masked (shared with the gateway). */
export const maskGaps = (gaps: Awaited<ReturnType<typeof signozTraceGaps>>) =>
  gaps.slice(0, 3).map((g) => ({
    in: masked(g.in) ?? "",
    after: g.after && (masked(g.after) ?? null),
    before: g.before && (masked(g.before) ?? null),
    gap_ms: g.gap_ms,
    share: g.share,
  }));

export const SIGNOZ_TRUNCATED =
  "SigNoz: quá nhiều nhóm trace lỗi, chỉ lấy các nhóm nhiều nhất; các nhóm nhỏ có thể bị bỏ sót";
export const SIGNOZ_NAMESPACE_MISMATCH = (unknown: string[]) =>
  `SigNoz: giá trị namespace (${unknown.slice(0, 5).join(", ")}) không khớp namespace nào trong cấu hình; kiểm tra config.signoz.namespaceKey (giá trị không bị đổi, vì namespace nằm trong fingerprint)`;
export const SIGNOZ_NO_BASELINE =
  "SigNoz: chưa có trace của kỳ so sánh (hôm qua cùng khung giờ), các nhóm chỉ từ SigNoz không được đánh giá mới/tăng";

/** Groups of one scan, upserted only over groups no newer scan has written (a stale worker never wins). */
export async function publishGroups(c: Db, scanId: number, groups: ReturnType<typeof toGroups>) {
  if (!groups.length) return;
  const rows = JSON.stringify(
    groups.map((g) => ({ ...g, detail: g.detail, reasons: g.reasons, hourly: g.hourly })),
  );
  await q(
    c,
    `INSERT INTO prod_error_groups (fingerprint, namespace, service, level, caller, signature, sample, detail, day,
       today_count, yesterday_count, first_at, last_at, severity, score, reasons, last_scan_id)
     SELECT g.fingerprint, g.namespace, g.service, g.level, g.caller, g.signature, g.sample, g.detail, g.day,
       g.today_count, g.yesterday_count, g.first_at, g.last_at, g.severity, g.score, g.reasons, $2
     FROM jsonb_to_recordset($1::jsonb) AS g(fingerprint text, namespace text, service text, level text, caller text,
       signature text, sample text, detail jsonb, day date, today_count int, yesterday_count int, first_at timestamptz,
       last_at timestamptz, severity text, score int, reasons jsonb)
     ON CONFLICT (fingerprint) DO UPDATE SET last_scan_id = excluded.last_scan_id, caller = excluded.caller,
       sample = excluded.sample, detail = excluded.detail, day = excluded.day, today_count = excluded.today_count,
       yesterday_count = excluded.yesterday_count, first_at = excluded.first_at, last_at = excluded.last_at,
       severity = excluded.severity, score = excluded.score, reasons = excluded.reasons, updated_at = now()
     WHERE prod_error_groups.last_scan_id IS NULL OR prod_error_groups.last_scan_id <= excluded.last_scan_id`,
    [rows, scanId],
  );
  await q(
    c,
    `INSERT INTO prod_error_observations(scan_id,fingerprint,event_count,baseline_count,first_at,last_at,severity,hourly)
     SELECT $2, g.fingerprint, g.today_count, g.yesterday_count, g.first_at, g.last_at, g.severity, g.hourly
     FROM jsonb_to_recordset($1::jsonb) AS g(fingerprint text, today_count int, yesterday_count int,
       first_at timestamptz, last_at timestamptz, severity text, hourly jsonb)
     ON CONFLICT(scan_id,fingerprint) DO NOTHING`,
    [rows, scanId],
  );
}

/**
 * After publication (by platform-go, through the gateway): Telegram for scheduled scans, then policy intake. Idempotent per group: a group
 * is announced once per day (notified_day) and ingested once (intake keys), so a finalize retried after a crash
 * does not repeat either.
 */
export async function finalizeScan(
  scanId: number,
  trigger: ScanTrigger,
  w: Pick<ScanWindow, "day" | "hm">,
) {
  // An ignored group that spiked or whose ignore ran out is open again before the announcement is chosen.
  await reopenIgnored(scanId).catch((e) => log.error("reopen ignored:", (e as Error).message));
  const notified = trigger === "schedule" ? await notifyNew(w.day, w.hm, scanId) : 0;
  // Policy-controlled intake (no-op without a policy): one envelope per group, never per log row.
  await ingestProdErrorGroups().catch((e) => log.error("intake:", (e as Error).message));
  return notified;
}

// ---------------------------------------------------------------- notifications (scheduled scans only)

const pageUrl = () => `${config.publicUrl.replace(/\/$/, "")}/#/prod-errors`;
const SEV_ICON: Record<Severity, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪" };
const MAX_IN_MESSAGE = 6;
const count = (n: number) => n.toLocaleString("vi-VN");

/** Reasons are stored as keys (`chronic|250`); the two v2 ones read better spelled out in the alert. */
function reasonLabel(reason: string) {
  const [code, n] = reason.split("|");
  if (code === "chronic") return `mãn tính ~${n}/giờ`;
  if (code === "returned") return "xuất hiện lại";
  return reason;
}

function trendText(g: Pick<GroupRow, "today_count" | "yesterday_count" | "detail">) {
  if (g.detail?.no_baseline) return "chưa có dữ liệu hôm qua";
  if (g.yesterday_count === 0) return "🆕 mới xuất hiện hôm nay";
  const r = g.today_count / g.yesterday_count;
  if (r >= 1.5)
    return `📈 tăng ×${r >= 10 ? Math.round(r) : r.toFixed(1)} (hôm qua ${count(g.yesterday_count)})`;
  return `hôm qua ${count(g.yesterday_count)}`;
}

/** The Telegram message for newly found critical/high groups (exported for tests). */
export function buildAlertMessage(rows: GroupRow[], hm: string) {
  const projects = new Map<string, number>();
  for (const g of rows) {
    const p =
      config.prodErrors.namespaces.find((n) => n.namespace === g.namespace)?.project ?? g.namespace;
    projects.set(p, (projects.get(p) ?? 0) + 1);
  }
  const crit = rows.filter((g) => g.severity === "critical").length;
  const blocks = rows.slice(0, MAX_IN_MESSAGE).map((g) => {
    const why = g.reasons.filter((r) => !/^mới|^tăng|^nhiều/.test(r)).map(reasonLabel);
    return [
      `${SEV_ICON[g.severity]} <b>${g.severity.toUpperCase()}</b> · <b>${esc(g.service)}</b>`,
      `<code>${esc(g.signature.length > 160 ? g.signature.slice(0, 157) + "…" : g.signature)}</code>`,
      `▸ ${count(g.today_count)} lần hôm nay · ${trendText(g)}`,
      ...(g.notified_severity && g.notified_severity !== g.severity
        ? [`▸ ⬆️ tăng bậc (${g.notified_severity} → ${g.severity})`]
        : []),
      ...(g.caller ? [`▸ tại <code>${esc(g.caller)}</code>`] : []),
      ...(why.length ? [`▸ <i>${esc(why.join(", "))}</i>`] : []),
    ].join("\n");
  });
  const footer = linkFooter(pageUrl(), "Mở trang Lỗi production");
  const text = [
    `🚨 <b>LỖI PRODUCTION · ${esc(hm)}</b>`,
    RULE,
    `<b>${rows.length}</b> nhóm lỗi mới cần xem${crit ? ` (<b>${crit} critical</b>)` : ""} · ${[...projects].map(([p, n]) => `${esc(p)} ${n}`).join(" · ")}`,
    "",
    blocks.join("\n\n"),
    ...(rows.length > MAX_IN_MESSAGE
      ? ["", `<i>… và ${rows.length - MAX_IN_MESSAGE} nhóm khác trên trang.</i>`]
      : []),
    "",
    "Bấm <b>Điều tra</b> trên trang để agent tìm nguyên nhân.",
    ...(footer.text ? [footer.text] : []),
  ].join("\n");
  return { text, replyMarkup: footer.reply_markup };
}

export function buildFailureMessage(hm: string, msg: string) {
  const expired = /hết hạn/i.test(msg);
  const missing = !expired && /chưa kết nối/i.test(msg);
  const footer = linkFooter(
    `${config.publicUrl.replace(/\/$/, "")}/#/integrations`,
    expired ? "Dán cookie Splunk mới" : missing ? "Kết nối Splunk hoặc SigNoz" : "Mở Integrations",
  );
  const text = [
    `⚠️ <b>KHÔNG QUÉT ĐƯỢC LỖI PRODUCTION · ${esc(hm)}</b>`,
    RULE,
    `<i>${esc(msg)}</i>`,
    "",
    expired
      ? "Cách xử lý: đăng nhập Splunk, copy cookie và dán ở trang Integrations (hoặc kết nối SigNoz), rồi bấm <b>Quét ngay</b> ở trang Lỗi production."
      : missing
        ? "Cách xử lý: kết nối Splunk hoặc SigNoz ở trang Integrations, rồi bấm <b>Quét ngay</b> ở trang Lỗi production."
        : "Bấm <b>Quét ngay</b> ở trang Lỗi production để thử lại.",
    ...(footer.text ? ["", footer.text] : []),
  ].join("\n");
  return { text, replyMarkup: footer.reply_markup };
}

const RANK_SQL = (col: string) =>
  `CASE ${col} WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END`;

/**
 * Telegram: open critical/high groups this scan wrote that were never announced, or whose level rose above the one
 * announced (a chronic group is not announced again every day; `renotifyDays` can ask for a reminder). Groups a
 * partial scan only carried over from an earlier scan are not announced. Returns how many were announced.
 */
async function notifyNew(day: string, hm: string, scanId: number) {
  if (!(await getSettings()).notify) return 0;
  const legacy = !config.prodErrors.notifyOnEscalation;
  const rows = legacy
    ? await q<GroupRow>(
        pool,
        `SELECT * FROM prod_error_groups WHERE day = $1 AND status = 'open' AND severity IN ('critical', 'high') AND work_item_id IS NULL
           AND notified_day IS DISTINCT FROM day ORDER BY score DESC`,
        [day],
      )
    : await q<GroupRow>(
        pool,
        `SELECT * FROM prod_error_groups
          WHERE day = $1 AND status = 'open' AND severity IN ('critical', 'high') AND work_item_id IS NULL AND last_scan_id = $2
            AND (notified_severity IS NULL OR ${RANK_SQL("severity")} > ${RANK_SQL("notified_severity")}
                 OR ($3::int > 0 AND notified_at < now() - make_interval(days => $3::int)))
          ORDER BY score DESC`,
        [day, scanId, Math.max(0, Math.floor(config.prodErrors.renotifyDays))],
      );
  if (!rows.length) return 0;
  const m = buildAlertMessage(rows, hm);
  const res = await sendTelegramHtml(m.text, m.replyMarkup);
  const ok = "ok" in res && res.ok;
  if (ok)
    await q(
      pool,
      `UPDATE prod_error_groups SET notified_day = day, notified_severity = severity, notified_at = now()
        WHERE fingerprint = ANY($1)`,
      [rows.map((r) => r.fingerprint)],
    );
  return ok ? rows.length : 0;
}

/** One failure notice per local day across all instances (the day is claimed atomically in settings). */
export async function notifyFailure(day: string, hm: string, msg: string) {
  if (!(await getSettings()).notify || !(await firstToday("prod_errors_failure_notice_day", day)))
    return;
  const m = buildFailureMessage(hm, msg);
  await sendTelegramHtml(m.text, m.replyMarkup);
}

// ---------------------------------------------------------------- settings + schedule

export interface ProdErrorSettings {
  schedule: string[];
  notify: boolean;
}

function parseSettings(raw: string | null): ProdErrorSettings {
  try {
    const s = JSON.parse(raw ?? "null");
    if (s) return { schedule: s.schedule ?? config.prodErrors.schedule, notify: s.notify ?? true };
  } catch {
    /* ignore: unreadable settings fall back to defaults */
  }
  return { schedule: config.prodErrors.schedule, notify: true };
}

export async function getSettings(): Promise<ProdErrorSettings> {
  return parseSettings(await settings.get("prod_errors"));
}

export async function saveSettings(input: { schedule?: unknown; notify?: unknown }) {
  const raw = Array.isArray(input.schedule)
    ? input.schedule
    : String(input.schedule ?? "").split(/[\s,;]+/);
  const schedule = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))].map((t) => {
    const m = t.match(/^(\d{1,2})(?::|h)?(\d{2})?$/);
    if (!m || Number(m[1]) > 23 || Number(m[2] ?? 0) > 59)
      throw new Error(`giờ "${t}" không hợp lệ (dạng HH:MM, vd 09:00)`);
    return `${m[1].padStart(2, "0")}:${m[2] ?? "00"}`;
  });
  const s = { schedule: schedule.sort(), notify: input.notify !== false };
  await settings.set("prod_errors", JSON.stringify(s));
  return s;
}

let timer: NodeJS.Timeout | null = null;
/**
 * Every 30 s: queue the scan of a configured time (local) that has come. The slot is the job's dedupe key, so of
 * all instances (and restarts within the minute) exactly one scan per slot is queued. Expired scan leases are
 * recovered on the same tick.
 */
export function startProdErrorSchedule() {
  if (timer) return;
  if (!config.prodErrors.userId)
    log.warn(
      "Scheduled production scans need an explicit local prodErrors.userId with its own Splunk login; manual scans remain available.",
    );
  timer = setInterval(() => void scheduleTick(), 30_000);
  timer.unref();
}

export async function scheduleTick(now = new Date()) {
  try {
    // One statement when idle (the common case): the schedule, and whether any scan is queued or running.
    const tick = (await one<{ settings: string | null; active: boolean }>(
      pool,
      `SELECT (SELECT value FROM settings WHERE key='prod_errors') AS settings,
         EXISTS(SELECT 1 FROM prod_error_scans WHERE status IN ('queued','running')) AS active`,
    ))!;
    if (tick.active) {
      await recoverScans();
    }
    const userId = config.prodErrors.userId;
    if (!userId) return;
    const z = zoned(now, config.prodErrors.timezone);
    if (!parseSettings(tick.settings).schedule.includes(z.hm)) return;
    const user = await one(pool, "SELECT active FROM users WHERE id = $1", [userId]);
    if (!user?.active) throw new Error("Configured production scan user is missing or inactive");
    await startScan(
      "schedule",
      {},
      { requestedBy: userId, dedupeKey: `schedule:${z.date} ${z.hm}` },
    );
  } catch (e) {
    log.error("prod error schedule:", (e as Error).message);
  }
}

// ---------------------------------------------------------------- page API

export async function listGroups(opts: { day?: string; all?: boolean } = {}) {
  const today = dayWindow(new Date()).day;
  // Independent queries run concurrently: against a remote database each one is a full network round trip.
  const wanted = opts.day && /^\d{4}-\d{2}-\d{2}$/.test(opts.day) ? opts.day : null;
  const [latestRow, lastScan, lastOk, settingsNow, active] = await Promise.all([
    wanted
      ? Promise.resolve(undefined)
      : one<{ day: string }>(pool, "SELECT max(day)::text AS day FROM prod_error_groups"),
    one(pool, "SELECT * FROM prod_error_scans ORDER BY id DESC LIMIT 1"),
    one(pool, "SELECT * FROM prod_error_scans WHERE ok ORDER BY id DESC LIMIT 1"),
    getSettings(),
    activeScan(),
  ]);
  const day = wanted ?? latestRow?.day ?? today;
  // Show the groups of the latest successful scan (it may cover some projects and any time window). Scans from before
  // scan options existed have no window: those fall back to "the latest day", as before.
  const byScan = !wanted && lastOk?.window_start ? Number(lastOk.id) : null;
  const key = byScan ?? day;
  // A partial scan lacks a source: that source's groups of the last complete scan stay listed, marked stale.
  const failed = (lastOk?.sources ?? {}) as Record<
    string,
    { status?: string; slow?: string } | undefined
  >;
  const gaps = {
    splunk: failed.splunk?.status === "failed",
    signoz: failed.signoz?.status === "failed",
    slow: failed.signoz?.slow === "failed",
  };
  const carryFrom =
    byScan && lastOk?.partial && (gaps.splunk || gaps.signoz || gaps.slow)
      ? await one<{ id: number; finished_at: string }>(
          pool,
          "SELECT id, finished_at FROM prod_error_scans WHERE ok AND NOT partial AND id < $1 ORDER BY id DESC LIMIT 1",
          [byScan],
        )
      : undefined;
  const carry = carryFrom
    ? `(g.last_scan_id = ${Number(carryFrom.id)} AND (
         (${gaps.splunk} AND g.detail->'sources' ? 'splunk')
         OR (${gaps.signoz} AND g.detail->'sources' ? 'signoz' AND g.level <> 'SLOW')
         OR (${gaps.slow} AND g.level = 'SLOW')))`
    : "false";
  const filter = byScan ? `(g.last_scan_id = $1 OR ${carry})` : "g.day = $1";
  const staleSource = carryFrom
    ? `CASE WHEN g.last_scan_id = $1 THEN NULL WHEN g.level = 'SLOW' THEN 'signoz_slow'
            WHEN ${gaps.splunk} AND g.detail->'sources' ? 'splunk' THEN 'splunk' ELSE 'signoz' END`
    : "NULL::text";
  const groupsQuery = q(
    pool,
    // The stack trace is over half of the list payload and is read only when a card's trace is opened (the incident
    // detail route returns it): the list carries `has_stack` instead.
    `SELECT (jsonb_populate_record(g, jsonb_build_object('detail', (g.detail - 'stack') || jsonb_build_object('has_stack', g.detail ? 'stack')))).*,
            g.day::text AS day, ${staleSource} AS stale_source, w.owner_id AS work_item_owner_id, w.code AS work_item_code, w.title AS work_item_title, w.status AS work_item_status,
            r.id AS run_id, r.status AS run_status,
            (SELECT coalesce(json_agg(json_build_object('repo', p.repo, 'url', p.url, 'title', p.title) ORDER BY p.id), '[]')
               FROM pull_requests p WHERE p.work_item_id = g.work_item_id) AS pull_requests
       FROM prod_error_groups g
       LEFT JOIN work_items w ON w.id = g.work_item_id
       LEFT JOIN LATERAL (SELECT id, status FROM workflow_runs WHERE work_item_id = g.work_item_id ORDER BY id DESC LIMIT 1) r ON true
      WHERE ${filter} AND ($2 OR g.status = 'open') ORDER BY g.score DESC, g.today_count DESC`,
    [key, !!opts.all],
  );
  const [groups, ignoredRow] = await Promise.all([
    groupsQuery,
    one<{ n: number }>(
      pool,
      `SELECT count(*)::int AS n FROM prod_error_groups g WHERE ${filter} AND status = 'ignored'`,
      [key],
    ),
  ]);
  const ignored = ignoredRow!.n;
  return {
    day,
    today,
    scanning: !!active,
    progress: active?.status === "running" ? (active.progress as unknown as ScanProgress) : null,
    active: active ? { id: active.id, status: active.status, engine: active.engine } : null,
    lastScan,
    lastOk,
    ignored,
    settings: settingsNow,
    splunk: { connected: splunkConnected(), expired: splunkExpired() },
    signoz: { connected: signozEnabled(), base_url: signozStatus().base_url },
    namespaces: config.prodErrors.namespaces.map((n) => ({ ...n, index: indexOf(n.namespace) })),
    /** The scan whose results are listed (window, baseline, projects), for the page header and column labels. */
    shown: byScan ? lastOk : null,
    /** The newest scan is missing a source (or got a cut one): which, and the scan whose groups stand in for it. */
    partial: !!lastOk?.partial,
    sources: lastOk?.sources ?? {},
    stale: carryFrom
      ? {
          scan_id: Number(carryFrom.id),
          finished_at: carryFrom.finished_at,
          sources: Object.entries(gaps)
            .filter(([, failed]) => failed)
            .map(([name]) => name),
        }
      : null,
    presets: SCAN_PRESETS,
    maxCustomHours: MAX_CUSTOM_HOURS,
    groups,
  };
}

/** Historical incident detail for analytics drilldowns; linked records are redacted at the API boundary. */
export async function getIncidentDetail(fingerprint: string) {
  if (!/^[0-9a-f]{20}$/.test(fingerprint))
    throw Object.assign(new Error("invalid fingerprint"), { status: 400 });
  const [group, observations, lifecycle] = await Promise.all([
    one(
      pool,
      `SELECT g.*,g.day::text AS day,w.owner_id AS work_item_owner_id,w.code AS work_item_code,
      w.title AS work_item_title,w.status AS work_item_status,
      COALESCE(g.first_at,(SELECT min(first_at) FROM prod_error_observations o WHERE o.fingerprint=g.fingerprint)) AS observed_first_at,
      COALESCE(g.last_at,(SELECT max(last_at) FROM prod_error_observations o WHERE o.fingerprint=g.fingerprint)) AS observed_last_at,
      EXISTS(SELECT 1 FROM prod_error_observations o WHERE o.fingerprint=g.fingerprint AND o.baseline_count>0) AS observed_recurring,
      (SELECT id FROM workflow_runs WHERE work_item_id=g.work_item_id ORDER BY id DESC LIMIT 1) AS run_id,
      (SELECT status FROM workflow_runs WHERE work_item_id=g.work_item_id ORDER BY id DESC LIMIT 1) AS run_status,
      (SELECT COALESCE(json_agg(json_build_object('repo',p.repo,'url',p.url,'title',p.title) ORDER BY p.id),'[]')
       FROM pull_requests p WHERE p.work_item_id=g.work_item_id) AS pull_requests
      FROM prod_error_groups g LEFT JOIN work_items w ON w.id=g.work_item_id WHERE g.fingerprint=$1`,
      [fingerprint],
    ),
    q(
      pool,
      `WITH raw AS MATERIALIZED (
      SELECT o.scan_id,o.event_count,o.baseline_count,o.first_at,o.last_at,o.severity,o.hourly,
        s.window_start,s.window_end,s.trigger,s.ok,s.finished_at
      FROM prod_error_observations o JOIN prod_error_scans s ON s.id=o.scan_id
      WHERE o.fingerprint=$1 AND s.ok
    ), hourly AS (
      SELECT (h->>'hour')::timestamptz AS window_start,(h->>'hour')::timestamptz+interval '1 hour' AS window_end,
        (h->>'count')::bigint AS event_count,r.severity,r.trigger,r.scan_id,
        least(r.window_end,(h->>'hour')::timestamptz+interval '1 hour')-greatest(r.window_start,(h->>'hour')::timestamptz) AS coverage
      FROM raw r CROSS JOIN LATERAL jsonb_array_elements(r.hourly) h
    ), dedup_hourly AS (
      SELECT DISTINCT ON(window_start) window_start,window_end,event_count,severity,trigger,scan_id
      FROM hourly ORDER BY window_start,coverage DESC,scan_id DESC
    ), legacy AS (
      SELECT DISTINCT ON(window_start,window_end) window_start,window_end,event_count,baseline_count,severity,trigger,scan_id
      FROM raw WHERE jsonb_array_length(hourly)=0
      ORDER BY window_start,window_end,(window_end-window_start) DESC,scan_id DESC
    )
    SELECT window_start,window_end,event_count,NULL::bigint AS baseline_count,severity,trigger,scan_id
    FROM dedup_hourly
    UNION ALL
    SELECT window_start,window_end,event_count,baseline_count,severity,trigger,scan_id FROM legacy
    WHERE NOT EXISTS(SELECT 1 FROM dedup_hourly)
    ORDER BY window_start DESC LIMIT 500`,
      [fingerprint],
    ),
    q(
      pool,
      `SELECT e.action,e.evidence,e.created_at,u.username FROM prod_error_lifecycle_events e
      LEFT JOIN users u ON u.id=e.actor_id WHERE e.fingerprint=$1 ORDER BY e.id DESC LIMIT 100`,
      [fingerprint],
    ),
  ]);
  if (!group) throw Object.assign(new Error("incident not found"), { status: 404 });
  return { group, observations, lifecycle };
}

async function getGroup(fp: string) {
  const g = await one<GroupRow>(
    pool,
    "SELECT *, day::text AS day FROM prod_error_groups WHERE fingerprint = $1",
    [fp],
  );
  if (!g) throw Object.assign(new Error("không có nhóm lỗi này"), { status: 404 });
  return g;
}

/**
 * Ignore a group for `days` (default: config.prodErrors.ignoreTtl.days), or open it again. The ignore remembers the
 * rate (events per hour) the group had, so a later spike can be told from the same noise (reopenIgnored).
 */
export async function setIgnored(fp: string, ignored: boolean, opts: { days?: number } = {}) {
  await getGroup(fp);
  const ttl = config.prodErrors.ignoreTtl;
  if (!ignored) {
    await q(
      pool,
      `UPDATE prod_error_groups SET status = 'open', ignored_until = NULL, ignored_at = NULL, ignored_rate = NULL,
         updated_at = now() WHERE fingerprint = $1`,
      [fp],
    );
    return { fingerprint: fp, status: "open" };
  }
  const days = Math.min(90, Math.max(1, Math.floor(opts.days ?? ttl.days)));
  const row = await one<{ ignored_until: string | null }>(
    pool,
    `UPDATE prod_error_groups SET status = 'ignored', ignored_at = now(), updated_at = now(),
       ignored_until = CASE WHEN $3 THEN now() + make_interval(days => $2::int) END,
       ignored_rate = (SELECT o.event_count / GREATEST(EXTRACT(EPOCH FROM (s.window_end - s.window_start)) / 3600, 1)
                         FROM prod_error_observations o JOIN prod_error_scans s ON s.id = o.scan_id
                        WHERE o.fingerprint = $1 ORDER BY o.scan_id DESC LIMIT 1)
     WHERE fingerprint = $1 RETURNING ignored_until`,
    [fp, days, ttl.enabled],
  );
  return { fingerprint: fp, status: "ignored", ignored_until: row?.ignored_until ?? null };
}

/**
 * After a scan: an ignored group comes back when its ignore ran out, or when this scan saw it spike (at least
 * `wakeMinCount` events and a rate of `max(wakeMinRate, wakeRatio × the rate it had when ignored)`). Its announced level
 * is reset so a group that is high or critical again is announced again. Audited, and deliberately not a lifecycle
 * "reopen": Radar reads those as a recurring incident.
 */
export async function reopenIgnored(scanId: number) {
  const ttl = config.prodErrors.ignoreTtl;
  if (!ttl.enabled) return [];
  const reopened = await q<{ fingerprint: string; why: string; today_count: number }>(
    pool,
    `WITH s AS (
       SELECT GREATEST(EXTRACT(EPOCH FROM (window_end - window_start)) / 3600, 1) AS hours
         FROM prod_error_scans WHERE id = $1),
     due AS (
       SELECT g.fingerprint, g.today_count,
              CASE WHEN g.ignored_until IS NOT NULL AND g.ignored_until < now() THEN 'ttl' ELSE 'spike' END AS why
         FROM prod_error_groups g, s
        WHERE g.status = 'ignored' AND (
              (g.ignored_until IS NOT NULL AND g.ignored_until < now())
           OR (g.last_scan_id = $1 AND g.today_count >= $4
               AND g.today_count / s.hours >= GREATEST($2::numeric, $3::numeric * COALESCE(g.ignored_rate, 0))))
     )
     UPDATE prod_error_groups g SET status = 'open', ignored_until = NULL, ignored_at = NULL, ignored_rate = NULL,
            notified_severity = NULL, notified_at = NULL, notified_day = NULL, updated_at = now()
       FROM due WHERE g.fingerprint = due.fingerprint
     RETURNING g.fingerprint, due.why, due.today_count`,
    [scanId, ttl.wakeMinRate, ttl.wakeRatio, ttl.wakeMinCount],
  );
  for (const r of reopened)
    await q(
      pool,
      `INSERT INTO audit_log (actor_id, action, resource_type, resource_id, detail)
       VALUES (NULL, 'prod_errors.group.auto_reopen', 'prod_error_group', $1, $2)`,
      [r.fingerprint, JSON.stringify({ why: r.why, scan_id: scanId, today_count: r.today_count })],
    );
  return reopened;
}

/**
 * Attach an existing work item (by code, e.g. HSK-123 / REQ-45, or numeric id) as the fix for a group, or detach with
 * an empty reference. Lets a bug that was already reported elsewhere be tracked from the production error page.
 */
export async function linkWorkItem(fp: string, ref: string, ownerId?: number) {
  await getGroup(fp);
  const r = ref.trim();
  if (!r) {
    await q(
      pool,
      "UPDATE prod_error_groups SET work_item_id = NULL, updated_at = now() WHERE fingerprint = $1",
      [fp],
    );
    return { fingerprint: fp, work_item_id: null };
  }
  const owner = ownerId ?? (config.test.platformTest === "1" ? await ensureTestOwner() : undefined);
  if (!owner) throw new Error("owner is required");
  const wi =
    (await workItems.byCode(r, owner)) ??
    (/^\d+$/.test(r) ? await workItems.get(Number(r)) : undefined);
  if (!wi || Number(wi.owner_id) !== owner) throw new Error(`không có work item "${r}"`);
  await q(
    pool,
    "UPDATE prod_error_groups SET work_item_id = $2, updated_at = now() WHERE fingerprint = $1",
    [fp, wi.id],
  );
  return { fingerprint: fp, work_item_id: wi.id, code: wi.code };
}

/** Production error groups a work item is fixing (shown on the work item page). */
export function groupsForWorkItem(id: number) {
  return q(
    pool,
    `SELECT fingerprint, namespace, service, level, caller, signature, severity, status, day::text AS day, today_count, yesterday_count, last_at,
            (SELECT max(day)::text FROM prod_error_groups) AS latest_day
       FROM prod_error_groups WHERE work_item_id = $1 ORDER BY score DESC`,
    [id],
  );
}

/** Repository name and commit from an image like registry/payment/payment-zalopay:prod.2611051524.efd844a */
export function imageInfo(image?: string) {
  const m = image?.match(/\/([^/:]+):[^:]*?\.([0-9a-f]{7,40})$/i);
  return m
    ? { repo: m[1], commit: m[2] }
    : image
      ? { repo: image.split("/").pop()!.split(":")[0], commit: undefined }
      : {};
}

export function describeGroup(g: GroupRow) {
  const d = g.detail ?? {};
  const img = imageInfo(d.image);
  const fence = (s: string) => "```text\n" + s.replace(/```/g, "ˋˋˋ") + "\n```";
  const t = (s: string | null) =>
    s
      ? new Date(s).toLocaleTimeString("vi-VN", {
          timeZone: config.prodErrors.timezone,
          hour12: false,
        })
      : "?";
  const spl = `index=${indexOf(g.namespace)} kubernetes.namespace_name="${g.namespace}" kubernetes.container_name="${g.service}"${g.caller ? ` "${g.caller}"` : ""}`;
  if (g.level === "SLOW" && d.slow) {
    const sl = d.slow;
    const gap = (x: NonNullable<typeof sl.gaps>[number]) =>
      `- ${x.gap_ms}ms (${Math.round(x.share * 100)}% thời gian) trong \`${x.in}\`, sau \`${x.after ?? "đầu span"}\`, trước \`${x.before ?? "cuối span"}\``;
    return [
      `Request chậm trên production phát hiện từ SigNoz (quét ngày ${g.day}).`,
      "",
      `- Namespace / service: \`${g.namespace}\` / \`${g.service}\``,
      `- Endpoint (span gốc): \`${g.caller}\``,
      `- Hôm nay: ${g.today_count}/${sl.total} request chậm hơn ${sl.threshold_ms}ms (lần gần nhất ${t(g.last_at)}); hôm qua cùng khung giờ: ${d.no_baseline ? "chưa có dữ liệu" : `${g.yesterday_count} request`}`,
      `- Độ trễ: p50 ${sl.p50_ms}ms, p95 ${sl.p95_ms}ms${sl.max_ms ? `, chậm nhất ${sl.max_ms}ms` : ""}`,
      `- Đánh giá: **${g.severity}**${g.reasons.length ? ` — ${g.reasons.join("; ")}` : ""}`,
      d.trace_id ? `\ntrace_id request chậm nhất: \`${d.trace_id}\`` : "",
      d.request_id
        ? `request_id: \`${d.request_id}\` (log cùng request: \`index=${indexOf(g.namespace)} "${d.request_id}"\`)`
        : "",
      sl.gaps?.length
        ? `\nThời gian không có span con nào chạy trong trace đó (code không được trace: gọi ngoài chưa instrument, lock, sleep, CPU):\n${sl.gaps.map(gap).join("\n")}`
        : "",
      "",
      `Xem trace bằng \`signoz_get_trace\` (chỉ đọc)${d.trace_id ? ` với trace_id \`${d.trace_id}\`` : ""}${d.request_id ? ` hoặc request_id \`${d.request_id}\`` : ""}; trường \`gaps\` chỉ ra khoảng thời gian không có span. Tìm thêm request chậm cùng endpoint bằng \`signoz_search_traces\`, và log cùng request trên Splunk bằng request_id.`,
      "",
      "Yêu cầu:",
      `1. Tìm đoạn code gây chậm${img.repo ? ` trong repo \`${img.repo}\`` : ""}: đọc code nằm giữa span \`after\` và \`before\` của khoảng trống lớn nhất.`,
      "2. Xác định có phải luôn chậm hay chỉ thỉnh thoảng (phụ thuộc dữ liệu, lock, đối tác), và ảnh hưởng tới người dùng / đơn hàng.",
      "3. Nếu đoạn chậm chưa có span, đề xuất thêm instrumentation để lần sau thấy rõ.",
      "4. Đề xuất fix và cách đo lại sau khi sửa.",
    ]
      .filter((l) => l !== "")
      .join("\n")
      .replace(/\n(Thời gian không|Xem trace|Yêu cầu)/g, "\n\n$1");
  }
  const traceOnly = !!d.sources?.length && !d.sources.includes("splunk");
  return [
    `Lỗi production phát hiện từ ${(d.sources ?? ["splunk"]).map((s) => (s === "signoz" ? "SigNoz" : "Splunk")).join(" và ")} (quét ngày ${g.day}).`,
    "",
    `- Namespace / service: \`${g.namespace}\` / \`${g.service}\``,
    d.image
      ? `- Image đang chạy: \`${d.image}\`${img.commit ? ` (repo \`${img.repo}\`, commit \`${img.commit}\`)` : ""}`
      : "",
    g.caller ? `- ${d.sources?.includes("splunk") ? "Vị trí log" : "Span"}: \`${g.caller}\`` : "",
    traceOnly ? "" : `- Mức log: ${g.level}`,
    `- Hôm nay: ${g.today_count} lần (lần đầu ${t(g.first_at)}, gần nhất ${t(g.last_at)}); hôm qua cùng khung giờ: ${d.no_baseline ? "chưa có dữ liệu" : `${g.yesterday_count} lần`}`,
    `- Đánh giá: **${g.severity}**${g.reasons.length ? ` — ${g.reasons.join("; ")}` : ""}`,
    "",
    traceOnly
      ? "Span lỗi mẫu (tên span [mã trạng thái]: status message, đã che PII):"
      : "Log mẫu (đã che PII):",
    fence(g.sample),
    d.err ? `Error: \`${d.err.replace(/`/g, "'")}\`` : "",
    d.stack ? `\nStacktrace:\n${fence(d.stack)}` : "",
    d.request_id
      ? `\nrequest_id gần nhất: \`${d.request_id}\` (log cùng request: \`index=${indexOf(g.namespace)} "${d.request_id}"\`)`
      : "",
    d.trace_id ? `\ntrace_id gần nhất: \`${d.trace_id}\`` : "",
    "",
    ...((d.sources ?? ["splunk"]).includes("splunk")
      ? ["Xem thêm log bằng tool `splunk.search` (chỉ đọc), ví dụ:", fence(spl)]
      : []),
    ...(d.sources?.includes("signoz")
      ? [
          `Xem trace lỗi bằng tool \`signoz_search_traces\` (chỉ đọc, \`has_error = true\`), lọc theo môi trường \`${g.namespace}\` và service \`${g.service}\`${d.trace_id ? `; xem cả trace bằng \`signoz_get_trace\` với trace_id \`${d.trace_id}\`` : ""}.`,
        ]
      : []),
    "",
    "Yêu cầu:",
    `1. Tìm nguyên nhân gốc trong code${img.repo ? ` repo \`${img.repo}\`` : ""}${img.commit ? ` (đối chiếu đúng commit \`${img.commit}\` đang chạy prod)` : ""}.`,
    "2. Đánh giá ảnh hưởng: có làm sai trạng thái đơn / giao dịch / tiền không, bao nhiêu bản ghi bị ảnh hưởng hôm nay.",
    "3. Nếu là lỗi dữ liệu hoặc đối tác (không phải bug code), nói rõ và đề xuất xử lý (giảm mức log, retry, cảnh báo) thay vì sửa logic.",
    "4. Đề xuất fix và test hồi quy.",
  ]
    .filter((l) => l !== "")
    .join("\n")
    .replace(/\n(Log mẫu|Span lỗi mẫu|Xem thêm|Xem trace|Yêu cầu)/g, "\n\n$1");
}

/** Create a Bug Investigation work item for a group and start its workflow (stops for approval before any fix). */
export async function investigate(fp: string, ownerId?: number) {
  const g = await getGroup(fp);
  if (g.work_item_id && ownerId) {
    const wi = await workItems.get(g.work_item_id);
    if (wi && Number(wi.owner_id) === ownerId)
      return { created: false, work_item_id: wi.id, code: wi.code };
  } else if (g.work_item_id && !ownerId) {
    const wi = await workItems.get(g.work_item_id);
    if (wi) return { created: false, work_item_id: wi.id, code: wi.code };
  }
  const project =
    config.prodErrors.namespaces.find((n) => n.namespace === g.namespace)?.project ?? "";
  const title = `[Prod] ${g.service}: ${g.signature}`.slice(0, 160);
  const item = await workItems.createManual({
    title,
    description: describeGroup(g),
    project,
    ownerId,
  });
  if (!g.work_item_id)
    await q(
      pool,
      "UPDATE prod_error_groups SET work_item_id = $2, updated_at = now() WHERE fingerprint = $1",
      [fp, item.id],
    );
  const run = await startRun({
    definitionKey: "bug-investigation",
    workItemId: item.id,
    ownerId: item.owner_id ?? ownerId,
  });
  return { created: true, work_item_id: item.id, code: item.code, run_id: run?.id ?? null };
}
