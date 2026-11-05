import { createHash } from "node:crypto";
import { config } from "../config.ts";
import { pool, q, one, json, withTx } from "../db/pool.ts";
import { settings } from "../db.ts";
import { splunkConnected, splunkExpired, splunkSearch } from "../integrations/splunk.ts";
import { workItems } from "../workitems/service.ts";
import { startRun } from "../workflow/engine.ts";
import { escapeHtml as esc, linkFooter, RULE, sendTelegramHtml } from "../telegram.ts";

/**
 * Daily production error scan (page "Lỗi production").
 *
 * One fixed, read-only SPL search (no LLM) over today's logs of the configured namespaces, compared with yesterday over
 * the same time-of-day window. Error lines are grouped by a signature (message with ids/numbers/hashes replaced), scored
 * (panic, new since yesterday, spike, money-related) and stored. "Điều tra" turns a group into a Bug Investigation work
 * item; the workflow still stops for the developer's approval before any fix. Scheduled scans notify Telegram about new
 * critical/high groups once per day.
 */

export type Severity = "critical" | "high" | "medium" | "low";
const SEV: Severity[] = ["low", "low", "medium", "high", "critical"];

export interface GroupRow {
  fingerprint: string;
  namespace: string;
  service: string;
  level: string;
  caller: string;
  signature: string;
  sample: string;
  detail: { err?: string; image?: string; request_id?: string; stack?: string; pod?: string };
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
  first_seen_at: string;
}

// ---------------------------------------------------------------- time window

/** Local calendar day and seconds since local midnight of `d` in time zone `tz`. */
export function zoned(d: Date, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, seconds: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) };
}

/** Today (local) from midnight to now, and yesterday over the same time-of-day window, as epoch seconds. */
export function dayWindow(now: Date, tz = config.prodErrors.timezone) {
  const z = zoned(now, tz);
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const start = nowEpoch - z.seconds;
  return { day: z.date, hm: z.hm, start, now: nowEpoch, yesterdayStart: start - 86400, yesterdayEnd: nowEpoch - 86400, minutes: Math.ceil(z.seconds / 60) + 1440 + 1 };
}

// ---------------------------------------------------------------- search

const LEVELS = ["ERROR", "FATAL", "PANIC", "DPANIC", "CRITICAL"];

/**
 * Both log shapes seen in k8s_prod: payment services log JSON at the top level (level/message/caller), OMS services'
 * JSON sits inside the container `log` string (spath input=log). Plain lines (gorm SQL, librdkafka) only count when they
 * are a Go panic / fatal error.
 */
export function buildScanSpl(w: ReturnType<typeof dayWindow>) {
  const c = config.prodErrors;
  const ns = c.namespaces.map((n) => `"${n.namespace}"`).join(",");
  return [
    `search index=${c.index} kubernetes.namespace_name IN (${ns}) (${LEVELS.join(" OR ")} OR "panic:" OR "fatal error")`,
    `where _time>=${w.start} OR _time<${w.yesterdayEnd}`,
    `spath input=log`,
    `eval lv=upper(coalesce(level,LEVEL)), msg=coalesce(message,MESSAGE,msg,log,_raw), err=coalesce(error,err), ns='kubernetes.namespace_name', svc='kubernetes.container_name'`,
    `where lv IN (${LEVELS.map((l) => `"${l}"`).join(",")}) OR (isnull(lv) AND match(msg,"^(panic:|fatal error:)"))`,
    `eval day=if(_time>=${w.start},"t","y")`,
    String.raw`eval sig=substr(msg . if(isnull(err), "", " :: " . err), 1, 400), sig=replace(sig,"[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}","<uuid>"), sig=replace(sig,"\\b[0-9a-fA-F]{16,}\\b","<hex>"), sig=replace(sig,"\\b[A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]*\\b","<n>"), sig=replace(sig,"\\s+"," "), sig=substr(sig,1,200)`,
    `stats count(eval(day="t")) as today count(eval(day="y")) as yesterday min(eval(if(day="t",_time,null()))) as first max(_time) as last latest(msg) as sample latest(err) as err latest(caller) as caller latest(kubernetes.container_image) as image latest(request_id) as request_id latest(stacktrace) as stack latest(kubernetes.pod_name) as pod by ns svc lv sig`,
    `where today>0`,
    `sort - today`,
    `head 300`,
  ].join(" | ");
}

const MONEY = /refund|hoàn tiền|charge|capture|settle|reconcil|duplicate|double|callback|webhook|\bipn\b|amount|\bcod\b|checksum|sign(ature)? not match|invalid sign/i;
const CRASH = /\bpanic\b|fatal error|nil pointer|index out of range|deadlock|out of memory|oomkilled/i;

/** Severity of one group from its level, text and today-vs-yesterday counts. */
export function assess(g: { level: string; signature: string; sample: string; today: number; yesterday: number }) {
  const reasons: string[] = [];
  const text = `${g.signature}\n${g.sample}`;
  let s = g.today >= 1000 ? 2 : 1;
  if (g.today >= 1000) reasons.push(`many|${g.today}`);
  if (/^(FATAL|PANIC|DPANIC|CRITICAL)$/.test(g.level) || CRASH.test(text)) {
    s = 4;
    reasons.push("panic");
  }
  let changed = false;
  if (g.yesterday === 0) {
    reasons.push("new");
    s = Math.max(s, g.today >= 5 ? 3 : 2);
    changed = true;
  } else if (g.today >= 50 && g.today >= 3 * g.yesterday) {
    reasons.push(`up|${Math.round(g.today / g.yesterday)}|${g.yesterday}`);
    s = Math.max(s, 3);
    changed = true;
  } else if (g.today * 2 <= g.yesterday) reasons.push(`down|${g.yesterday}`);
  if (MONEY.test(text)) {
    reasons.push("money");
    // new/spiking money-related errors go up one level; critical only with real volume
    if (changed && g.today >= 5) s = Math.max(s, Math.min(g.today >= 50 ? 4 : 3, s + 1));
  }
  const severity = SEV[s];
  return { severity, score: s * 1000 + Math.min(999, Math.round(Math.log10(g.today + 1) * 100)), reasons };
}

export const fingerprint = (ns: string, svc: string, level: string, sig: string) => createHash("sha1").update([ns, svc, level, sig].join("\u0000")).digest("hex").slice(0, 20);

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const iso = (v: unknown) => (v == null || v === "" ? null : new Date(Number(v) * 1000).toISOString());
const str = (v: unknown, max: number) => (v == null ? "" : String(Array.isArray(v) ? v[0] : v).slice(0, max));

/** Splunk result rows → group rows (exported for tests). */
export function toGroups(rows: any[], day: string) {
  return rows.map((r) => {
    const level = str(r.lv, 20) || "ERROR";
    const signature = str(r.sig, 200);
    const sample = str(r.sample, 2000);
    const today = num(r.today);
    const yesterday = num(r.yesterday);
    return {
      fingerprint: fingerprint(str(r.ns, 100), str(r.svc, 100), level, signature),
      namespace: str(r.ns, 100),
      service: str(r.svc, 100),
      level,
      caller: str(r.caller, 200),
      signature,
      sample,
      detail: { err: str(r.err, 1000) || undefined, image: str(r.image, 300) || undefined, request_id: str(r.request_id, 100) || undefined, stack: str(r.stack, 2500) || undefined, pod: str(r.pod, 100) || undefined },
      day,
      today_count: today,
      yesterday_count: yesterday,
      first_at: iso(r.first),
      last_at: iso(r.last),
      ...assess({ level, signature, sample, today, yesterday }),
    };
  });
}

// ---------------------------------------------------------------- scan

let running: Promise<unknown> | null = null;
export const scanning = () => !!running;

/** What the running scan is doing, for the page's progress bar. */
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
let progress: ScanProgress | null = null;
const setPhase = (phase: ScanProgress["phase"], pct: number) => progress && Object.assign(progress, { phase, pct: Math.max(progress.pct, pct) });

/** Start a scan in the background (one at a time). */
export function startScan(trigger: "manual" | "schedule") {
  if (running) return { started: false, running: true };
  running = runScan(trigger)
    .catch((e) => console.error("prod error scan:", (e as Error).message))
    .finally(() => (running = null));
  return { started: true, running: true };
}

export async function runScan(trigger: "manual" | "schedule", now = new Date()) {
  const scan = (await one<{ id: number }>(pool, "INSERT INTO prod_error_scans (trigger) VALUES ($1) RETURNING id", [trigger]))!;
  const w = dayWindow(now);
  progress = { phase: "connect", pct: 2, searchPct: 0, scanned: 0, matched: 0, startedAt: new Date().toISOString() };
  try {
    if (!splunkConnected()) throw new Error(splunkExpired() ? "phiên Splunk hết hạn — dán cookie mới ở trang Integrations" : "chưa kết nối Splunk — dán cookie ở trang Integrations");
    const r = await splunkSearch({ query: buildScanSpl(w), since_minutes: w.minutes, max_results: 300, timeout_seconds: config.prodErrors.timeoutSeconds }, (p) => {
      if (!progress) return;
      // the Splunk search is most of the wall time: 5% → 90%
      Object.assign(progress, { phase: "search", searchPct: p.pct, splunkState: p.state, scanned: p.scanned, matched: p.matched, pct: Math.max(progress.pct, 5 + Math.round(p.pct * 0.85)) });
    });
    setPhase("group", 92);
    const groups = toGroups(r.results, w.day);
    setPhase("save", 95);
    await withTx(async (c) => {
      for (const g of groups)
        await q(
          c,
          `INSERT INTO prod_error_groups (fingerprint, namespace, service, level, caller, signature, sample, detail, day, today_count, yesterday_count, first_at, last_at, severity, score, reasons)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (fingerprint) DO UPDATE SET caller = excluded.caller, sample = excluded.sample, detail = excluded.detail, day = excluded.day,
             today_count = excluded.today_count, yesterday_count = excluded.yesterday_count, first_at = excluded.first_at, last_at = excluded.last_at,
             severity = excluded.severity, score = excluded.score, reasons = excluded.reasons, updated_at = now()`,
          [g.fingerprint, g.namespace, g.service, g.level, g.caller, g.signature, g.sample, json(g.detail), g.day, g.today_count, g.yesterday_count, g.first_at, g.last_at, g.severity, g.score, json(g.reasons)],
        );
    });
    const warnings = (r.messages ?? []).filter((m: string) => !/^INFO/.test(m)).join("; ") || null;
    setPhase("notify", 98);
    const notified = trigger === "schedule" ? await notifyNew(w.day, w.hm) : 0;
    await q(pool, "UPDATE prod_error_scans SET finished_at = now(), ok = true, groups = $2, events = $3, error = $4, notified = $5 WHERE id = $1", [
      scan.id,
      groups.length,
      groups.reduce((a, g) => a + g.today_count, 0),
      warnings,
      notified,
    ]);
    return { ok: true, groups: groups.length };
  } catch (e) {
    const msg = (e as Error).message;
    await q(pool, "UPDATE prod_error_scans SET finished_at = now(), ok = false, error = $2 WHERE id = $1", [scan.id, msg]);
    if (trigger === "schedule") await notifyFailure(w.day, w.hm, msg);
    throw e;
  } finally {
    progress = null;
  }
}

// ---------------------------------------------------------------- notifications (scheduled scans only)

const pageUrl = () => `${config.publicUrl.replace(/\/$/, "")}/#/prod-errors`;
const SEV_ICON: Record<Severity, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪" };
const MAX_IN_MESSAGE = 6;
const count = (n: number) => n.toLocaleString("vi-VN");

function trendText(g: Pick<GroupRow, "today_count" | "yesterday_count">) {
  if (g.yesterday_count === 0) return "🆕 mới xuất hiện hôm nay";
  const r = g.today_count / g.yesterday_count;
  if (r >= 1.5) return `📈 tăng ×${r >= 10 ? Math.round(r) : r.toFixed(1)} (hôm qua ${count(g.yesterday_count)})`;
  return `hôm qua ${count(g.yesterday_count)}`;
}

/** The Telegram message for newly found critical/high groups (exported for tests). */
export function buildAlertMessage(rows: GroupRow[], hm: string) {
  const projects = new Map<string, number>();
  for (const g of rows) {
    const p = config.prodErrors.namespaces.find((n) => n.namespace === g.namespace)?.project ?? g.namespace;
    projects.set(p, (projects.get(p) ?? 0) + 1);
  }
  const crit = rows.filter((g) => g.severity === "critical").length;
  const blocks = rows.slice(0, MAX_IN_MESSAGE).map((g) => {
    const why = g.reasons.filter((r) => !/^mới|^tăng|^nhiều/.test(r));
    return [
      `${SEV_ICON[g.severity]} <b>${g.severity.toUpperCase()}</b> · <b>${esc(g.service)}</b>`,
      `<code>${esc(g.signature.length > 160 ? g.signature.slice(0, 157) + "…" : g.signature)}</code>`,
      `▸ ${count(g.today_count)} lần hôm nay · ${trendText(g)}`,
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
    ...(rows.length > MAX_IN_MESSAGE ? ["", `<i>… và ${rows.length - MAX_IN_MESSAGE} nhóm khác trên trang.</i>`] : []),
    "",
    "Bấm <b>Điều tra</b> trên trang để agent tìm nguyên nhân.",
    ...(footer.text ? [footer.text] : []),
  ].join("\n");
  return { text, replyMarkup: footer.reply_markup };
}

export function buildFailureMessage(hm: string, msg: string) {
  const expired = /hết hạn|chưa kết nối/i.test(msg);
  const footer = linkFooter(`${config.publicUrl.replace(/\/$/, "")}/#/integrations`, expired ? "Dán cookie Splunk mới" : "Mở Integrations");
  const text = [
    `⚠️ <b>KHÔNG QUÉT ĐƯỢC LỖI PRODUCTION · ${esc(hm)}</b>`,
    RULE,
    `<i>${esc(msg)}</i>`,
    "",
    expired ? "Cách xử lý: đăng nhập Splunk, copy cookie và dán ở trang Integrations, rồi bấm <b>Quét ngay</b> ở trang Lỗi production." : "Bấm <b>Quét ngay</b> ở trang Lỗi production để thử lại.",
    ...(footer.text ? ["", footer.text] : []),
  ].join("\n");
  return { text, replyMarkup: footer.reply_markup };
}

/** Telegram: open critical/high groups not announced yet today. Returns how many were announced. */
async function notifyNew(day: string, hm: string) {
  if (!(await getSettings()).notify) return 0;
  const rows = await q<GroupRow>(
    pool,
    `SELECT * FROM prod_error_groups WHERE day = $1 AND status = 'open' AND severity IN ('critical', 'high') AND work_item_id IS NULL
       AND notified_day IS DISTINCT FROM day ORDER BY score DESC`,
    [day],
  );
  if (!rows.length) return 0;
  const m = buildAlertMessage(rows, hm);
  const res = await sendTelegramHtml(m.text, m.replyMarkup);
  const ok = "ok" in res && res.ok;
  if (ok) await q(pool, "UPDATE prod_error_groups SET notified_day = day WHERE fingerprint = ANY($1)", [rows.map((r) => r.fingerprint)]);
  return ok ? rows.length : 0;
}

let failureNoticeDay = "";
async function notifyFailure(day: string, hm: string, msg: string) {
  if (failureNoticeDay === day || !(await getSettings()).notify) return;
  failureNoticeDay = day;
  const m = buildFailureMessage(hm, msg);
  await sendTelegramHtml(m.text, m.replyMarkup);
}

// ---------------------------------------------------------------- settings + schedule

export interface ProdErrorSettings {
  schedule: string[];
  notify: boolean;
}

export async function getSettings(): Promise<ProdErrorSettings> {
  try {
    const s = JSON.parse((await settings.get("prod_errors")) ?? "null");
    if (s) return { schedule: s.schedule ?? config.prodErrors.schedule, notify: s.notify ?? true };
  } catch {}
  return { schedule: config.prodErrors.schedule, notify: true };
}

export async function saveSettings(input: { schedule?: unknown; notify?: unknown }) {
  const raw = Array.isArray(input.schedule) ? input.schedule : String(input.schedule ?? "").split(/[\s,;]+/);
  const schedule = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))].map((t) => {
    const m = t.match(/^(\d{1,2})(?::|h)?(\d{2})?$/);
    if (!m || Number(m[1]) > 23 || Number(m[2] ?? 0) > 59) throw new Error(`giờ "${t}" không hợp lệ (dạng HH:MM, vd 09:00)`);
    return `${m[1].padStart(2, "0")}:${m[2] ?? "00"}`;
  });
  const s = { schedule: schedule.sort(), notify: input.notify !== false };
  await settings.set("prod_errors", JSON.stringify(s));
  return s;
}

let timer: NodeJS.Timeout | null = null;
/** Checks every 30 s whether a configured time (local) has come; a restart within the same minute does not rescan. */
export function startProdErrorSchedule() {
  if (timer) return;
  let lastSlot = "";
  timer = setInterval(async () => {
    try {
      const z = zoned(new Date(), config.prodErrors.timezone);
      const slot = `${z.date} ${z.hm}`;
      if (slot === lastSlot || !(await getSettings()).schedule.includes(z.hm)) return;
      lastSlot = slot;
      const recent = await one(pool, "SELECT 1 FROM prod_error_scans WHERE trigger = 'schedule' AND started_at > now() - interval '5 minutes'");
      if (!recent) startScan("schedule");
    } catch (e) {
      console.error("prod error schedule:", (e as Error).message);
    }
  }, 30_000);
  timer.unref();
}

// ---------------------------------------------------------------- page API

export async function listGroups(opts: { day?: string; all?: boolean } = {}) {
  const today = dayWindow(new Date()).day;
  const latest = (await one<{ day: string }>(pool, "SELECT max(day)::text AS day FROM prod_error_groups"))?.day ?? null;
  const day = opts.day && /^\d{4}-\d{2}-\d{2}$/.test(opts.day) ? opts.day : latest ?? today;
  const groups = await q(
    pool,
    `SELECT g.*, g.day::text AS day, w.code AS work_item_code, w.title AS work_item_title, w.status AS work_item_status,
            r.id AS run_id, r.status AS run_status,
            (SELECT coalesce(json_agg(json_build_object('repo', p.repo, 'url', p.url, 'title', p.title) ORDER BY p.id), '[]')
               FROM pull_requests p WHERE p.work_item_id = g.work_item_id) AS pull_requests
       FROM prod_error_groups g
       LEFT JOIN work_items w ON w.id = g.work_item_id
       LEFT JOIN LATERAL (SELECT id, status FROM workflow_runs WHERE work_item_id = g.work_item_id ORDER BY id DESC LIMIT 1) r ON true
      WHERE g.day = $1 AND ($2 OR g.status = 'open') ORDER BY g.score DESC, g.today_count DESC`,
    [day, !!opts.all],
  );
  const ignored = (await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM prod_error_groups WHERE day = $1 AND status = 'ignored'", [day]))!.n;
  const lastScan = await one(pool, "SELECT * FROM prod_error_scans ORDER BY id DESC LIMIT 1");
  const lastOk = await one(pool, "SELECT * FROM prod_error_scans WHERE ok ORDER BY id DESC LIMIT 1");
  return {
    day,
    today,
    scanning: scanning(),
    progress,
    lastScan,
    lastOk,
    ignored,
    settings: await getSettings(),
    splunk: { connected: splunkConnected(), expired: splunkExpired() },
    namespaces: config.prodErrors.namespaces,
    groups,
  };
}

async function getGroup(fp: string) {
  const g = await one<GroupRow>(pool, "SELECT *, day::text AS day FROM prod_error_groups WHERE fingerprint = $1", [fp]);
  if (!g) throw Object.assign(new Error("không có nhóm lỗi này"), { status: 404 });
  return g;
}

export async function setIgnored(fp: string, ignored: boolean) {
  await getGroup(fp);
  await q(pool, "UPDATE prod_error_groups SET status = $2, updated_at = now() WHERE fingerprint = $1", [fp, ignored ? "ignored" : "open"]);
  return { fingerprint: fp, status: ignored ? "ignored" : "open" };
}

/**
 * Attach an existing work item (by code, e.g. HSK-123 / REQ-45, or numeric id) as the fix for a group, or detach with
 * an empty reference. Lets a bug that was already reported elsewhere be tracked from the production error page.
 */
export async function linkWorkItem(fp: string, ref: string) {
  await getGroup(fp);
  const r = ref.trim();
  if (!r) {
    await q(pool, "UPDATE prod_error_groups SET work_item_id = NULL, updated_at = now() WHERE fingerprint = $1", [fp]);
    return { fingerprint: fp, work_item_id: null };
  }
  const wi = (await workItems.byCode(r)) ?? (/^\d+$/.test(r) ? await workItems.get(Number(r)) : undefined);
  if (!wi) throw new Error(`không có work item "${r}"`);
  await q(pool, "UPDATE prod_error_groups SET work_item_id = $2, updated_at = now() WHERE fingerprint = $1", [fp, wi.id]);
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
  return m ? { repo: m[1], commit: m[2] } : image ? { repo: image.split("/").pop()!.split(":")[0], commit: undefined } : {};
}

export function describeGroup(g: GroupRow) {
  const d = g.detail ?? {};
  const img = imageInfo(d.image);
  const fence = (s: string) => "```text\n" + s.replace(/```/g, "ˋˋˋ") + "\n```";
  const t = (s: string | null) => (s ? new Date(s).toLocaleTimeString("vi-VN", { timeZone: config.prodErrors.timezone, hour12: false }) : "?");
  const spl = `index=${config.prodErrors.index} kubernetes.namespace_name="${g.namespace}" kubernetes.container_name="${g.service}"${g.caller ? ` "${g.caller}"` : ""}`;
  return [
    `Lỗi production phát hiện từ Splunk (quét ngày ${g.day}).`,
    "",
    `- Namespace / service: \`${g.namespace}\` / \`${g.service}\``,
    d.image ? `- Image đang chạy: \`${d.image}\`${img.commit ? ` (repo \`${img.repo}\`, commit \`${img.commit}\`)` : ""}` : "",
    g.caller ? `- Vị trí log: \`${g.caller}\`` : "",
    `- Mức log: ${g.level}`,
    `- Hôm nay: ${g.today_count} lần (lần đầu ${t(g.first_at)}, gần nhất ${t(g.last_at)}); hôm qua cùng khung giờ: ${g.yesterday_count} lần`,
    `- Đánh giá: **${g.severity}**${g.reasons.length ? ` — ${g.reasons.join("; ")}` : ""}`,
    "",
    "Log mẫu (đã che PII):",
    fence(g.sample),
    d.err ? `Error: \`${d.err.replace(/`/g, "'")}\`` : "",
    d.stack ? `\nStacktrace:\n${fence(d.stack)}` : "",
    d.request_id ? `\nrequest_id gần nhất: \`${d.request_id}\` (log cùng request: \`index=${config.prodErrors.index} "${d.request_id}"\`)` : "",
    "",
    "Xem thêm log bằng tool `splunk.search` (chỉ đọc), ví dụ:",
    fence(spl),
    "",
    "Yêu cầu:",
    `1. Tìm nguyên nhân gốc trong code${img.repo ? ` repo \`${img.repo}\`` : ""}${img.commit ? ` (đối chiếu đúng commit \`${img.commit}\` đang chạy prod)` : ""}.`,
    "2. Đánh giá ảnh hưởng: có làm sai trạng thái đơn / giao dịch / tiền không, bao nhiêu bản ghi bị ảnh hưởng hôm nay.",
    "3. Nếu là lỗi dữ liệu hoặc đối tác (không phải bug code), nói rõ và đề xuất xử lý (giảm mức log, retry, cảnh báo) thay vì sửa logic.",
    "4. Đề xuất fix và test hồi quy.",
  ]
    .filter((l) => l !== "")
    .join("\n")
    .replace(/\n(Log mẫu|Xem thêm|Yêu cầu)/g, "\n\n$1");
}

/** Create a Bug Investigation work item for a group and start its workflow (stops for approval before any fix). */
export async function investigate(fp: string) {
  const g = await getGroup(fp);
  if (g.work_item_id) {
    const wi = await workItems.get(g.work_item_id);
    if (wi) return { created: false, work_item_id: wi.id, code: wi.code };
  }
  const project = config.prodErrors.namespaces.find((n) => n.namespace === g.namespace)?.project ?? "";
  const title = `[Prod] ${g.service}: ${g.signature}`.slice(0, 160);
  const item = await workItems.createManual({ title, description: describeGroup(g), project });
  await q(pool, "UPDATE prod_error_groups SET work_item_id = $2, updated_at = now() WHERE fingerprint = $1", [fp, item.id]);
  const run: any = await startRun({ definitionKey: "bug-investigation", workItemId: item.id });
  return { created: true, work_item_id: item.id, code: item.code, run_id: run?.id ?? null };
}
