import { redactPii } from "../integrations/redact.ts";
import { parseObservedTime, type ObservedTime } from "./time.ts";

/**
 * Normalization of raw log rows (Splunk results or pasted exports) into the investigation's evidence model.
 * Pure. Identifiers are extracted BEFORE redaction (a shipment id must not be masked as a card number), then every
 * string that is kept is sanitized: credentials, customer PII and payment data never reach storage or a model.
 */

export const ID_FIELDS = ["order_code", "shipment_code", "shipment_id", "tracking_no", "request_id", "trace_id", "correlation_id", "message_id"] as const;
export type IdField = (typeof ID_FIELDS)[number];
export type Ids = Partial<Record<IdField, string[]>>;

/** Field-name aliases, compared after lower-casing and removing every non-alphanumeric character. */
const ALIASES: Record<IdField, string[]> = {
  order_code: ["ordercode", "orderno", "ordernumber", "ordercd", "salesordercode"],
  shipment_code: ["shipmentcode", "shippingcode", "deliverycode"],
  shipment_id: ["shipmentid", "shippingid", "deliveryid"],
  tracking_no: ["trackingno", "trackingnumber", "trackingcode", "trackingid", "waybill", "waybillno", "awb", "labelcode", "partnercode", "partnerordercode"],
  request_id: ["requestid", "xrequestid", "reqid"],
  trace_id: ["traceid", "xb3traceid", "ddtraceid", "otteltraceid"],
  correlation_id: ["correlationid", "xcorrelationid", "corrid"],
  message_id: ["messageid", "msgid", "eventid", "kafkakey", "kafkamessageid", "outboxid"],
};
const BY_ALIAS = new Map<string, IdField>();
for (const f of ID_FIELDS) {
  BY_ALIAS.set(f.replace(/[^a-z0-9]/g, ""), f);
  for (const a of ALIASES[f]) BY_ALIAS.set(a, f);
}
export const idFieldOf = (key: string): IdField | undefined => BY_ALIAS.get(key.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, ""));

/** Values that are not identifiers even when a field is named like one. */
const JUNK = /^(null|nil|none|undefined|true|false|0|-|n\/a|""|\[\]|\{\})$/i;
const ID_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{2,99}$/;

function addId(ids: Ids, field: IdField, value: unknown) {
  if (value === null || value === undefined || typeof value === "object") return;
  const v = String(value).trim();
  if (!v || JUNK.test(v) || !ID_VALUE.test(v)) return;
  const list = (ids[field] ??= []);
  if (!list.includes(v)) list.push(v);
}

function walk(v: unknown, ids: Ids, depth = 0) {
  if (depth > 6 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 50)) walk(x, ids, depth + 1);
    return;
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const f = idFieldOf(k);
    if (f) addId(ids, f, x);
    if (typeof x === "string" && /^\s*[{[]/.test(x)) walk(tryJson(x), ids, depth + 1);
    else walk(x, ids, depth + 1);
  }
}

export function tryJson(s: unknown): unknown {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  if (!/^[{[]/.test(t)) {
    // common shape: `<prefix text> {json}` — parse the first balanced-looking object
    const i = t.indexOf("{");
    if (i <= 0 || !t.endsWith("}")) return undefined;
    try {
      return JSON.parse(t.slice(i));
    } catch {
      return undefined;
    }
  }
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** key=value / "key":"value" pairs in free text, for identifiers logged without structure. */
const KV = /["']?([A-Za-z][\w.-]{1,40})["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._:\/-]{2,99})/g;

export function extractIds(row: Record<string, unknown>, text: string): Ids {
  const ids: Ids = {};
  walk(row, ids);
  for (const m of text.matchAll(KV)) {
    const f = idFieldOf(m[1]);
    if (f) addId(ids, f, m[2]);
  }
  return ids;
}

// ---------------------------------------------------------------- sanitization

/** Field names whose values are customer PII, payment data or credentials — replaced entirely. */
const SENSITIVE_KEY =
  /^(?:.*[_-])?(phone|phonenumber|phone_number|mobile|tel|email|address|addr|street|full_?address|fullname|full_name|customer_?name|receiver|receiver_?name|receiver_?phone|receiver_?address|sender_?name|sender_?phone|recipient|card|card_?number|cardno|pan|cvv|cvc|expiry|password|passwd|pwd|secret|client_?secret|token|access_?token|refresh_?token|id_?token|api_?key|apikey|authorization|cookie|set-cookie|signature|otp|id_?card|cmnd|cccd|passport|bank_?account|account_?number|iban)$/i;

const SIGNED_URL_PARAM = /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Signature|signature|sig|token|access_token|Expires|GoogleAccessId|Key-Pair-Id|Policy)=)[^&\s"'<>]+/g;

/** Redact a parsed JSON value by field name; strings inside are also PII-masked. */
export function redactValue(v: unknown, depth = 0): unknown {
  if (depth > 8) return "…";
  if (typeof v === "string") {
    const inner = /^\s*[{[]/.test(v) ? tryJson(v) : undefined;
    if (inner !== undefined) return JSON.stringify(redactValue(inner, depth + 1));
    return sanitizeText(v);
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const f = idFieldOf(k);
      out[k] = !f && SENSITIVE_KEY.test(k) && x !== null && x !== "" ? "***" : redactValue(x, depth + 1);
    }
    return out;
  }
  return v;
}

/** Free text: credentials and PII patterns, `key=value` pairs with sensitive keys, signed URL parameters. */
export function sanitizeText(s: string): string {
  const parsed = /^\s*[{[]/.test(s) ? tryJson(s) : undefined;
  if (parsed !== undefined && typeof parsed === "object") return JSON.stringify(redactValue(parsed));
  return redactPii(s)
    .replace(SIGNED_URL_PARAM, "$1***")
    .replace(/(["']?([A-Za-z][\w-]{1,40})["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/g, (all, prefix, key) =>
      !idFieldOf(key) && SENSITIVE_KEY.test(key) ? `${prefix}"***"` : all,
    );
}

// ---------------------------------------------------------------- normalized event

export interface LogEvent {
  /** Stable evidence reference: S<search id>:<seq>. */
  ref: string;
  seq: number;
  time: ObservedTime | null;
  index: string | null;
  source: string | null;
  sourcetype: string | null;
  host: string | null;
  service: string | null;
  ids: Ids;
  /** Sanitized log message (bounded). */
  message: string;
  /** Sanitized full event (bounded); only returned on explicit request (splunk_get_event). */
  raw: string;
  /** Small sanitized scalar fields (bounded), useful for filtering without the raw text. */
  fields: Record<string, string>;
  /** Content hash of the sanitized raw text + time, used to detect duplicate log lines. */
  fingerprint: string;
}

const SERVICE_FIELDS = ["kubernetes.container_name", "kubernetes.labels.app", "kubernetes.labels.app.kubernetes.io/name", "service", "service_name", "app", "application", "container_name", "kubernetes.pod_name"];
const MESSAGE_FIELDS = ["message", "msg", "log", "body"];
const MAX_MESSAGE = 1000;
const MAX_RAW = 6000;

const str = (v: unknown) => (v === null || v === undefined ? null : Array.isArray(v) ? String(v[0] ?? "") || null : String(v) || null);

function fnv(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s);

export function normalizeEvent(row: Record<string, unknown>, seq: number, searchId: number | string, tz: string): LogEvent {
  const rawText = str(row._raw) ?? "";
  const parsed = tryJson(rawText) as Record<string, any> | undefined;
  const pick = (names: string[]) => {
    for (const n of names) {
      const v = str(row[n]) ?? (parsed ? str(n.split(".").reduce<any>((o, k) => (o == null ? o : o[k]), parsed)) : null);
      if (v) return v;
    }
    return null;
  };
  const ids = extractIds({ ...row, _parsed: parsed }, rawText);
  const message = pick(MESSAGE_FIELDS) ?? rawText;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "_raw" || k.startsWith("_") && k !== "_time" || Object.keys(fields).length >= 30) continue;
    if (v === null || typeof v === "object" && !Array.isArray(v)) continue;
    const s = str(v);
    if (s === null || s.length > 300) continue;
    fields[k] = !idFieldOf(k) && SENSITIVE_KEY.test(k) ? "***" : sanitizeText(s);
  }
  const raw = cut(sanitizeText(rawText), MAX_RAW);
  return {
    ref: `S${searchId}:${seq}`,
    seq,
    time: parseObservedTime(row._time ?? row.time ?? row.timestamp, tz),
    index: str(row.index),
    source: str(row.source),
    sourcetype: str(row.sourcetype),
    host: str(row.host),
    service: pick(SERVICE_FIELDS),
    ids,
    message: cut(sanitizeText(message), MAX_MESSAGE),
    raw,
    fields,
    fingerprint: fnv(`${str(row._time) ?? ""}|${raw}`),
  };
}

/** Compact view for model context: no raw text, a short excerpt. */
export function compactEvent(e: LogEvent, excerpt = 400) {
  return {
    event_ref: e.ref,
    timestamp: e.time?.iso ?? null,
    precision: e.time?.precision ?? null,
    index: e.index,
    source: e.source,
    sourcetype: e.sourcetype,
    service: e.service,
    ids: e.ids,
    excerpt: cut(e.message, excerpt),
  };
}

// ---------------------------------------------------------------- pasted results (manual mode)

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cur), (cur = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur), (cur = "");
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x !== "")) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/**
 * Results pasted by a user who ran the SPL in Splunk Web: Splunk JSON ({results:[…]}), a JSON array, export JSON
 * lines ({"result":{…}} per line) or CSV with a header row (Export → CSV, or copy of the table view).
 */
export function parsePastedResults(text: string): Record<string, unknown>[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      const j: any = JSON.parse(t);
      if (Array.isArray(j)) return j.map((x) => (x?.result && typeof x.result === "object" ? x.result : x));
      if (Array.isArray(j?.results)) return j.results;
      if (j?.result) return [j.result];
      return [j];
    } catch {
      const lines = t.split(/\r?\n/).filter((l) => l.trim());
      const out: Record<string, unknown>[] = [];
      for (const l of lines) {
        const j: any = tryJson(l);
        if (!j) throw new Error("pasted text is neither JSON, JSON lines nor CSV");
        if (j.preview === true) continue;
        out.push(j.result ?? j);
      }
      return out;
    }
  }
  const rows = parseCsv(t);
  if (!rows.length || !Object.keys(rows[0]).some((k) => ["_time", "_raw", "time", "message"].includes(k)))
    throw new Error("pasted CSV needs a header row with _time and _raw (or message)");
  return rows;
}
