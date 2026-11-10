import { formatInZone, tzOffsetMinutes, zonedToEpochMs } from "./time.ts";
import type { IdField } from "./events.ts";
import type { Objective } from "./correlate.ts";

/**
 * Deterministic parsing of a natural-language investigation request (Vietnamese or English): identifiers, the time
 * anchor and search window, candidate services and the questions to answer. It grounds the agents — they see the raw
 * request too and may refine it, but searches start from what is literally in the request. Nothing here is a finding:
 * services are candidates and an assumed window is flagged as assumed.
 */

export interface ParsedIdentifier {
  type: IdField | "unknown";
  value: string;
  /** The words that classified it (e.g. "order", "mã vận đơn"); empty when only the shape matched. */
  hint: string;
}

export interface ParsedRequest {
  request: string;
  language: "vi" | "en";
  identifiers: ParsedIdentifier[];
  /** Identifier values the investigation is anchored on (all identifiers, strongest first). */
  anchors: string[];
  time: {
    timezone: string;
    anchor: string | null;
    earliest: string;
    latest: string;
    earliest_ms: number;
    latest_ms: number;
    approximate: boolean;
    assumed: boolean;
    notes: string[];
  };
  services: Array<{ name: string; matched: string }>;
  objectives: Objective[];
  questions: string[];
}

export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();

const VI_MARKS = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;
const VI_WORDS = /\b(don hang|van don|kiem tra|thoi gian|phan hoi|luc|ngay|khoang|bao lau|tim|xem|truy vet|gui|nhan)\b/;

export function detectLanguage(text: string): "vi" | "en" {
  return VI_MARKS.test(text) || VI_WORDS.test(fold(text)) ? "vi" : "en";
}

/** Keyword (folded) → identifier type; longest phrases first so "mã vận đơn" beats "đơn". */
const ID_HINTS: Array<[RegExp, IdField]> = [
  [/(ma van don|tracking(?: number| no| code)?|waybill|awb)\s*[:#]?\s*$/, "tracking_no"],
  [/(shipment code|ma giao hang|ma shipment|shipment_code)\s*[:#]?\s*$/, "shipment_code"],
  [/(shipment id|shipment_id|shipment)\s*[:#]?\s*$/, "shipment_id"],
  [/(van don)\s*[:#]?\s*$/, "tracking_no"],
  [/(request[ _-]?id|x-request-id|req id)\s*[:#]?\s*$/, "request_id"],
  [/(trace[ _-]?id|trace)\s*[:#]?\s*$/, "trace_id"],
  [/(correlation[ _-]?id)\s*[:#]?\s*$/, "correlation_id"],
  [/(message[ _-]?id|msg id|event id|kafka key)\s*[:#]?\s*$/, "message_id"],
  [/(order(?: code| no| number)?|ma don(?: hang)?|don hang|don)\s*[:#]?\s*$/, "order_code"],
];

const TOKEN = /[A-Za-z0-9][A-Za-z0-9_-]{5,63}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STOP = new Set(["hasakinow", "production", "november", "december", "shipping", "tracking", "callback", "response", "message", "investigate", "shipment"]);

function looksLikeId(tok: string) {
  if (UUID.test(tok)) return true;
  if (STOP.has(tok.toLowerCase())) return false;
  const digits = (tok.match(/\d/g) ?? []).length;
  // identifiers mix digits and letters (2611095VL160RW01) or are long digit strings (shipment ids)
  return (digits >= 3 && /[A-Za-z]/.test(tok) && tok.length >= 8) || (/^\d{8,20}$/.test(tok));
}

export function extractIdentifiers(text: string): ParsedIdentifier[] {
  const out: ParsedIdentifier[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    const tok = m[0].replace(/[-_]+$/, "");
    if (!looksLikeId(tok) || seen.has(tok)) continue;
    // years/dates/times are not identifiers
    if (/^(19|20)\d{2}(\d{4})?$/.test(tok) || /^\d{1,2}h\d{2}$/i.test(tok)) continue;
    const before = fold(text.slice(Math.max(0, m.index! - 40), m.index!));
    let type: ParsedIdentifier["type"] = "unknown";
    let hint = "";
    for (const [re, t] of ID_HINTS) {
      const h = before.match(re);
      if (h) {
        type = t;
        hint = h[1];
        break;
      }
    }
    if (type === "unknown" && UUID.test(tok)) type = "unknown";
    seen.add(tok);
    out.push({ type, value: tok, hint });
  }
  return out;
}

// ---------------------------------------------------------------- time

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

interface DateParts { y?: number; mo: number; d: number; ambiguous?: boolean }

function parseDate(f: string, lang: "vi" | "en", now: { y: number; mo: number; d: number }): DateParts | null {
  let m = f.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
  m = f.match(/\b(?:ngay\s*)?(\d{1,2})\s*thang\s*(\d{1,2})(?:\s*(?:nam\s*)?(\d{4}))?/);
  if (m) return { y: m[3] ? +m[3] : undefined, mo: +m[2], d: +m[1] };
  m = f.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/);
  if (m) return { y: m[3] ? +m[3] : undefined, mo: MONTHS[m[1]], d: +m[2] };
  m = f.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:,?\s*(\d{4}))?/);
  if (m) return { y: m[3] ? +m[3] : undefined, mo: MONTHS[m[2]], d: +m[1] };
  m = f.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{4}))?\b/);
  if (m) {
    const a = +m[1], b = +m[2];
    const y = m[3] ? +m[3] : undefined;
    // Vietnamese writes dd/mm; English is ambiguous — dd/mm unless that is impossible
    if (lang === "en" && a <= 12 && b <= 12 && a !== b) return { y, mo: a, d: b, ambiguous: true };
    if (a > 12) return { y, mo: b, d: a };
    if (b > 12) return { y, mo: a, d: b };
    return { y, mo: b, d: a, ambiguous: lang === "en" && a !== b };
  }
  if (/\b(hom nay|today)\b/.test(f)) return { ...now };
  if (/\b(hom qua|yesterday)\b/.test(f)) {
    const t = new Date(Date.UTC(now.y, now.mo - 1, now.d) - 86_400_000);
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  return null;
}

function parseClock(f: string): { h: number; mi: number; s: number; approximate: boolean } | null {
  const approximate = /\b(around|about|approximately|approx|khoang|tam|chung|gan)\b|~/.test(f);
  let m = f.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|sang|chieu|toi)?\b/);
  if (!m) m = f.match(/\b(\d{1,2})h(\d{2})?(?:m(\d{2})?)?\s*(am|pm|sang|chieu|toi)?\b/);
  if (!m) {
    const g = f.match(/\b(\d{1,2})\s*gio(?:\s*(\d{1,2})(?:\s*phut)?)?\s*(sang|chieu|toi)?/);
    if (g) m = [g[0], g[1], g[2] ?? "0", undefined as any, g[3]] as any;
  }
  if (!m) return null;
  let h = +m[1];
  const mi = +(m[2] ?? 0);
  const s = +(m[3] ?? 0);
  const ap = m[4];
  if ((ap === "pm" || ap === "chieu" || ap === "toi") && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || mi > 59 || s > 59) return null;
  return { h, mi, s, approximate };
}

export interface WindowDefaults {
  timezone: string;
  beforeMinutes?: number;
  afterMinutes?: number;
  maxMinutes: number;
  now?: number;
  /** Language of the notes (the run's output locale); defaults to the request's language. */
  locale?: "vi" | "en";
}

export function parseTimeWindow(text: string, lang: "vi" | "en", o: WindowDefaults): ParsedRequest["time"] {
  const tz = o.timezone;
  const nowMs = o.now ?? Date.now();
  const local = new Date(nowMs + tzOffsetMinutes(tz, nowMs) * 60_000);
  const today = { y: local.getUTCFullYear(), mo: local.getUTCMonth() + 1, d: local.getUTCDate() };
  const f = fold(text);
  const notes: string[] = [];
  const nl = o.locale ?? lang;
  const date = parseDate(f, lang, today);
  const clock = parseClock(f.replace(/\b\d{4}-\d{2}-\d{2}\b/, (d) => d));
  const before = (o.beforeMinutes ?? 15) * 60_000;
  const after = (o.afterMinutes ?? 30) * 60_000;
  let y = date?.y ?? today.y;
  if (date && !date.y) {
    const candidate = zonedToEpochMs(tz, y, date.mo, date.d);
    if (candidate > nowMs + 86_400_000) {
      y -= 1;
      notes.push(nl === "vi" ? "năm không ghi rõ: dùng năm trước vì ngày này chưa tới" : "no year given: the previous year is used because the date is in the future");
    } else notes.push(nl === "vi" ? `năm không ghi rõ: dùng ${y}` : `no year given: ${y} is assumed`);
  }
  if (date?.ambiguous) notes.push(nl === "vi" ? "ngày dạng số có thể hiểu hai cách; đã đọc là ngày/tháng" : `numeric date is ambiguous; read as ${date.mo}/${date.d} (month/day)`);
  let anchor: number | null = null;
  let earliest: number;
  let latest: number;
  let assumed = false;
  if (clock) {
    const d = date ?? today;
    anchor = zonedToEpochMs(tz, date ? y : today.y, d.mo, d.d, clock.h, clock.mi, clock.s);
    if (!date) notes.push(nl === "vi" ? "không ghi ngày: dùng hôm nay" : "no date given: today is assumed");
    earliest = anchor - before;
    latest = anchor + after;
  } else if (date) {
    earliest = zonedToEpochMs(tz, y, date.mo, date.d);
    latest = earliest + 86_400_000;
    notes.push(nl === "vi" ? "không có giờ: tìm cả ngày" : "no time of day: the whole day is searched");
  } else {
    latest = nowMs;
    earliest = nowMs - 24 * 3_600_000;
    assumed = true;
    notes.push(nl === "vi" ? "yêu cầu không có thời điểm: mặc định 24 giờ gần nhất" : "no time in the request: the last 24 hours are assumed");
  }
  if (latest > nowMs) latest = nowMs;
  if (latest - earliest > o.maxMinutes * 60_000) earliest = latest - o.maxMinutes * 60_000;
  if (earliest >= latest) earliest = latest - before;
  return {
    timezone: tz,
    anchor: anchor === null ? null : formatInZone(anchor * 1000, tz, "s"),
    earliest: formatInZone(earliest * 1000, tz, "s"),
    latest: formatInZone(latest * 1000, tz, "s"),
    earliest_ms: earliest,
    latest_ms: latest,
    approximate: clock?.approximate ?? !clock,
    assumed,
    notes,
  };
}

// ---------------------------------------------------------------- services & objectives

/** Known external partners and internal systems: candidates for discovery, never confirmed services. */
const SERVICES: Array<[RegExp, string]> = [
  [/\bhasaki\s*now\b|\bhasakinow\b|\bnow\b(?=.*(phan hoi|respond|response|ship|giao|van don|tracking|label))/, "HasakiNOW"],
  [/\bghn\b|giao hang nhanh/, "GHN"],
  [/\bghtk\b|giao hang tiet kiem/, "GHTK"],
  [/\bspx\b|shopee express/, "SPX"],
  [/\bvnpay\b/, "VNPay"],
  [/\bmomo\b/, "MoMo"],
  [/\bzalo\s*pay\b/, "ZaloPay"],
  [/\boms\b/, "OMS"],
  [/\bwms\b/, "WMS"],
  [/\bkafka\b/, "Kafka"],
  [/\brabbit\s*mq\b/, "RabbitMQ"],
  [/\bpayment\b|thanh toan/, "Payment"],
];

const OBJECTIVE_RULES: Array<[RegExp, Objective]> = [
  [/(exact message|message sent|payload|request sent|request body|noi dung (gui|message)|message gui|tin nhan gui|message (da )?gui|request gui|gui (cho|sang|toi))/, "outbound_message"],
  [/(how long|took to respond|response time|latency|respond|bao lau|thoi gian .*phan hoi|phan hoi|do tre|cham)/, "partner_response_latency"],
  [/(tracking|ma van don|thong tin van chuyen|shipping info|shipping\/tracking)/, "tracking_info"],
  [/(shipping label|label url|nhan van chuyen|tem van chuyen|\blabel\b|in tem)/, "shipping_label_time"],
  [/(callback|webhook)/, "callback_time"],
  [/(\bwhy\b|error|fail|exception|loi|tai sao|vi sao|nguyen nhan|slow)/, "error_cause"],
];

export function parseRequest(text: string, o: WindowDefaults): ParsedRequest {
  const request = String(text ?? "").trim();
  const language = detectLanguage(request);
  const identifiers = extractIdentifiers(request);
  const f = fold(request);
  const services: ParsedRequest["services"] = [];
  for (const [re, name] of SERVICES) {
    const m = f.match(re);
    if (m && !services.some((s) => s.name === name)) services.push({ name, matched: m[0] });
  }
  const objectives: Objective[] = [];
  for (const [re, obj] of OBJECTIVE_RULES) if (re.test(f) && !objectives.includes(obj)) objectives.push(obj);
  // tracking info asked together with latency is answered by the latency pair; keep both
  if (!objectives.length) objectives.push("timeline");
  const rank = (t: ParsedIdentifier["type"]) => ["order_code", "shipment_code", "shipment_id", "tracking_no", "request_id", "correlation_id", "message_id", "trace_id", "unknown"].indexOf(t);
  const anchors = [...identifiers].sort((a, b) => rank(a.type) - rank(b.type)).map((i) => i.value);
  const questions = request
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
  return { request, language, identifiers, anchors, time: parseTimeWindow(request, language, o), services, objectives, questions };
}

// ---------------------------------------------------------------- intent routing

export interface WorkflowTriggers {
  phrases: string[];
  requires_any?: string[];
  excludes?: string[];
  /** When an exclude matched, one of these must be present to still route (explicit request). */
  explicit?: string[];
}

/** Score a request against a workflow's triggers (diacritic-insensitive). 0 = do not route. */
export function scoreTriggers(text: string, t: WorkflowTriggers): { score: number; matched: string[] } {
  const f = ` ${fold(text).replace(/\s+/g, " ")} `;
  const has = (p: string) => f.includes(fold(p));
  const phrases = t.phrases.filter(has);
  if (!phrases.length) return { score: 0, matched: [] };
  const support = (t.requires_any ?? []).filter(has);
  if (t.requires_any?.length && !support.length) return { score: 0, matched: phrases };
  const excluded = (t.excludes ?? []).filter(has);
  if (excluded.length && !(t.explicit ?? []).some(has)) return { score: 0, matched: [...phrases, ...excluded.map((x) => `!${x}`)] };
  return { score: phrases.length * 2 + support.length, matched: [...phrases, ...support] };
}
