import { config } from "../config.ts";
import { outputLocale } from "../agent/language.ts";
import { buildSearchUrl, runSearches, splunkConnected } from "../integrations/splunk.ts";
import type { ExecutionContext } from "../workflow/executors/registry.ts";
import type { ExecResult } from "../workflow/types.ts";
import {
  computeLatencies,
  correlate,
  evaluateCompleteness,
  type EventLabel,
  type TimelineEvent,
} from "./correlate.ts";
import type { LogEvent } from "./events.ts";
import { buildReport, type SearchSummary } from "./report.ts";
import { parseRequest, type ParsedRequest } from "./request.ts";
import { formatInZone } from "./time.ts";

/**
 * Deterministic steps of the Production Incident Investigation workflow (integration actions):
 *   investigation_parse     — request → identifiers, window, candidate services, objectives, initial SPL
 *   investigation_correlate — agent labels × stored evidence → timeline, completeness (config.final for the last pass)
 *   investigation_latency   — timeline → latency pairs with the compared events and their qualification
 *   investigation_report    — business summary + developer report (artifact), language = run output locale
 * Agents search and label; these steps decide what the evidence actually shows.
 */

const INDEX = /^[\w:-]{1,80}$/;

const say = (locale: "vi" | "en", vi: string, en: string) => (locale === "vi" ? vi : en);

function indexesOf(raw: unknown, locale: "vi" | "en"): { indexes: string[]; notes: string[] } {
  const notes: string[] = [];
  const given = (Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,]+/))
    .map((x) => String(x).trim())
    .filter(Boolean);
  let indexes = given.length ? given : [...config.splunk.defaultIndexes];
  const bad = indexes.filter((i) => !INDEX.test(i) || i.includes("*"));
  if (bad.length)
    notes.push(
      say(
        locale,
        `bỏ qua tên index không hợp lệ: ${bad.join(", ")}`,
        `invalid index names ignored: ${bad.join(", ")}`,
      ),
    );
  indexes = indexes.filter((i) => !bad.includes(i));
  const allowed = config.splunk.allowedIndexes.map((x) => x.toLowerCase());
  if (allowed.length) {
    const outside = indexes.filter((i) => !allowed.includes(i.toLowerCase()));
    if (outside.length)
      notes.push(
        say(
          locale,
          `bỏ qua index ngoài danh sách cho phép: ${outside.join(", ")}`,
          `indexes outside the allowlist ignored: ${outside.join(", ")}`,
        ),
      );
    indexes = indexes.filter((i) => allowed.includes(i.toLowerCase()));
  }
  return { indexes, notes };
}

export function requestText(ctx: Pick<ExecutionContext, "input" | "run">) {
  const inputs = (ctx.input.run.inputs ?? {}) as Record<string, unknown>;
  return (
    String(inputs.request ?? "").trim() ||
    [ctx.input.work_item?.title, ctx.input.work_item?.description]
      .filter(Boolean)
      .join("\n")
      .trim() ||
    ctx.run.title
  );
}

export function planInvestigation(
  text: string,
  inputs: Record<string, unknown>,
  now = Date.now(),
  locale: "vi" | "en" = "vi",
) {
  const parsed = parseRequest(text, {
    timezone: config.splunk.timezone,
    maxMinutes: config.splunk.maxMinutes,
    now,
    locale,
  });
  const { indexes, notes } = indexesOf(inputs.indexes, locale);
  // explicit range from the form wins over what the text implies
  if (inputs.earliest || inputs.latest) {
    const e = inputs.earliest ? Date.parse(String(inputs.earliest)) : parsed.time.earliest_ms;
    const l = inputs.latest ? Date.parse(String(inputs.latest)) : parsed.time.latest_ms;
    if (Number.isFinite(e) && Number.isFinite(l) && e < l) {
      parsed.time.earliest_ms = e;
      parsed.time.latest_ms = Math.min(l, now);
      parsed.time.earliest = formatInZone(e * 1000, parsed.time.timezone, "s");
      parsed.time.latest = formatInZone(parsed.time.latest_ms * 1000, parsed.time.timezone, "s");
      parsed.time.assumed = false;
      parsed.time.notes = [
        ...parsed.time.notes,
        say(locale, "khoảng thời gian do người dùng chọn", "time range set explicitly by the user"),
      ];
    } else
      notes.push(
        say(
          locale,
          "bỏ qua khoảng thời gian đã chọn: thời điểm bắt đầu phải trước thời điểm kết thúc (ISO-8601 có múi giờ)",
          "explicit time range ignored: earliest must be before latest (ISO-8601 with offset)",
        ),
      );
  }
  const environment = String(inputs.environment ?? config.splunk.environment);
  if (environment !== config.splunk.environment)
    notes.push(
      say(
        locale,
        `chỉ cấu hình môi trường Splunk "${config.splunk.environment}"; truy vấn dùng môi trường này`,
        `only the "${config.splunk.environment}" Splunk environment is configured; searches use it`,
      ),
    );
  const ids = parsed.anchors.slice(0, 3);
  const initial_queries = indexes.slice(0, 3).flatMap((idx) =>
    ids.length
      ? ids.slice(0, 2).map((id) => ({
          query: `index=${idx} "${id.replace(/"/g, "")}" | table _time index source sourcetype host kubernetes.container_name message _raw | sort 0 _time | head 500`,
          earliest: parsed.time.earliest,
          latest: parsed.time.latest,
          splunk_url: buildSearchUrl(
            `search index=${idx} "${id}"`,
            parsed.time.earliest_ms,
            parsed.time.latest_ms,
          ),
        }))
      : [],
  );
  if (!ids.length)
    notes.push(
      say(
        locale,
        "yêu cầu không có mã định danh: tìm theo service/lỗi trong khoảng thời gian, không quét cả index",
        "no identifier found in the request: search by service/error terms within the window, never the whole index",
      ),
    );
  return { ...parsed, indexes, environment, notes, initial_queries, read_only: true };
}

export async function investigationParse(ctx: ExecutionContext): Promise<ExecResult> {
  const text = requestText(ctx);
  if (!text)
    return {
      kind: "failed",
      error: "empty investigation request: describe what to investigate (inputs.request)",
      retryable: false,
    };
  const locale = outputLocale(ctx.run);
  const out = planInvestigation(
    text,
    (ctx.input.run.inputs ?? {}) as Record<string, unknown>,
    Date.now(),
    locale,
  );
  if (!out.indexes.length)
    return {
      kind: "failed",
      error: `no searchable index: ${out.notes.join("; ") || "configure splunk.defaultIndexes"}`,
      retryable: false,
    };
  await ctx.log(
    "system",
    say(
      locale,
      `điều tra: ${out.anchors.length} mã định danh, khoảng thời gian ${out.time.earliest} → ${out.time.latest}, index ${out.indexes.join(", ")}, mục tiêu ${out.objectives.join(", ")}`,
      `investigation: ${out.anchors.length} identifier(s), window ${out.time.earliest} → ${out.time.latest}, indexes ${out.indexes.join(", ")}, objectives ${out.objectives.join(", ")}`,
    ),
  );
  return { kind: "completed", output: out };
}

const parsedOf = (ctx: ExecutionContext): (ParsedRequest & { indexes?: string[] }) | null =>
  (Object.values(ctx.input.upstream).find(
    (u) => u.output?.anchors && u.output?.time?.earliest_ms !== undefined,
  )?.output as any) ?? null;

function labelsFrom(ctx: ExecutionContext): EventLabel[] {
  const labels: EventLabel[] = [];
  for (const [key, u] of Object.entries(ctx.input.upstream)) {
    if (u.status !== "COMPLETED" || !Array.isArray(u.output?.events)) continue;
    for (const e of u.output.events)
      if (e && typeof e === "object" && e.evidence_ref) labels.push({ ...e, labeled_by: key });
  }
  return labels;
}

export function searchSummaries(rows: Awaited<ReturnType<typeof runSearches>>): SearchSummary[] {
  const tz = config.splunk.timezone;
  return rows.map((r) => ({
    id: Number(r.id),
    query: r.query,
    earliest: formatInZone(r.earliest.getTime() * 1000, tz, "s"),
    latest: formatInZone(r.latest.getTime() * 1000, tz, "s"),
    status: r.status,
    mode: r.mode,
    result_count: r.result_count,
    duration_ms: r.duration_ms,
    splunk_url: buildSearchUrl(r.query, r.earliest.getTime(), r.latest.getTime()),
    error: r.error,
    step_key: r.step_key,
  }));
}

async function correlation(ctx: ExecutionContext) {
  const parsed = parsedOf(ctx);
  const rows = await runSearches(ctx.run.id);
  const events = new Map<string, LogEvent>();
  for (const r of rows) for (const e of r.events ?? []) events.set(e.ref, e);
  const result = correlate({
    events,
    labels: labelsFrom(ctx),
    anchors: parsed?.anchors ?? [],
    locale: outputLocale(ctx.run),
  });
  const completeness = evaluateCompleteness(
    result.timeline,
    parsed?.objectives ?? [],
    outputLocale(ctx.run),
  );
  return { parsed, rows, result, completeness };
}

const CAP = 300;

export async function investigationCorrelate(ctx: ExecutionContext): Promise<ExecResult> {
  const { rows, result, completeness } = await correlation(ctx);
  const manualPending = rows.filter((r) => r.status === "manual_pending").length;
  const final = ctx.step.config.final === true;
  const missing = completeness.missing.map((m) => m.objective).join(", ");
  await ctx.log(
    "system",
    say(
      outputLocale(ctx.run),
      `ghép sự kiện${final ? " (lần cuối)" : ""}: ${result.timeline.length} liên kết được, ${result.uncorrelated.length} không liên kết, ${result.rejected.length} nhãn bị loại; ${completeness.complete ? "đủ bằng chứng" : `còn thiếu: ${missing}`}`,
      `correlation${final ? " (final)" : ""}: ${result.timeline.length} correlated, ${result.uncorrelated.length} uncorrelated, ${result.rejected.length} rejected label(s); ${completeness.complete ? "evidence complete" : `missing: ${missing}`}`,
    ),
  );
  return {
    kind: "completed",
    output: {
      complete: completeness.complete,
      satisfied: completeness.satisfied,
      missing: completeness.missing,
      timeline: result.timeline.slice(0, CAP),
      uncorrelated: result.uncorrelated.slice(0, 100),
      rejected: result.rejected,
      identifiers: result.identifiers,
      unlabeled_refs: result.unlabeled_refs,
      searches: searchSummaries(rows),
      manual_pending: manualPending,
      splunk_connected: splunkConnected(),
      ...(result.timeline.length > CAP ? { truncated: true } : {}),
    },
  };
}

export async function investigationLatency(ctx: ExecutionContext): Promise<ExecResult> {
  const from = String(ctx.step.config.from ?? "timeline");
  const timeline: TimelineEvent[] = ctx.input.upstream[from]?.output?.timeline ?? [];
  const latencies = computeLatencies(timeline, outputLocale(ctx.run));
  const pairs = latencies.length
    ? ": " + latencies.map((l) => `${l.key}=${l.latency_text ?? "n/a"}`).join(", ")
    : "";
  await ctx.log(
    "system",
    say(
      outputLocale(ctx.run),
      `độ trễ: đo được ${latencies.length} cặp sự kiện${pairs}`,
      `latency: ${latencies.length} measured pair(s)${pairs}`,
    ),
  );
  return {
    kind: "completed",
    output: { latencies, measured: latencies.filter((l) => l.latency_us !== null).length },
  };
}

export async function investigationReport(ctx: ExecutionContext): Promise<ExecResult> {
  const c = (ctx.step.config.from ?? {}) as Record<string, string>;
  const up = (k: string, d: string) => ctx.input.upstream[c[k] ?? d]?.output;
  const parsed = parsedOf(ctx);
  if (!parsed)
    return { kind: "failed", error: "no parsed investigation request upstream", retryable: false };
  const timelineOut = up("timeline", "timeline") ?? {};
  const rows = await runSearches(ctx.run.id);
  const locale = outputLocale(ctx.run);
  const report = buildReport({
    locale,
    parsed,
    timeline: timelineOut.timeline ?? [],
    uncorrelated: timelineOut.uncorrelated ?? [],
    rejected: timelineOut.rejected ?? [],
    latencies: up("latency", "latency")?.latencies ?? [],
    completeness: { complete: !!timelineOut.complete, missing: timelineOut.missing ?? [] },
    searches: searchSummaries(rows),
    findings: up("findings", "analyze_findings"),
    code: up("code", "analyze_code"),
    access: {
      connected: splunkConnected(),
      manual_pending: rows.filter((r) => r.status === "manual_pending").length,
    },
  });
  const artifactId = await ctx.artifact(
    "report",
    locale === "vi" ? "Bao-cao-dieu-tra.md" : "Investigation-report.md",
    report.markdown,
    { summary: report.summary, status: report.status },
  );
  return {
    kind: "completed",
    output: { ...report, report_artifact_id: artifactId, report_markdown: report.markdown },
  };
}
