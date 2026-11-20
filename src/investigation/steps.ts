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
import { selectProviders } from "./observability.ts";
import { pool, q } from "../db/pool.ts";
import { noteDecision } from "../workflow/decisions.ts";
import { sanitizeText } from "./events.ts";
import {
  coverageGaps,
  deployedVersions,
  evaluateHypotheses,
  impactCounts,
  planNextActions,
  progressSignature,
  rootCauseOutcome,
  searchCoverage,
  stopReason,
  type NextAction,
  type RoundState,
} from "./rounds.ts";

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
  const qc = environment === "qc";
  if (qc)
    notes.push(
      say(
        locale,
        "môi trường QC không có Splunk: log được đọc qua Argo CD (qc_log_search), kèm Kafka UI và QC database",
        "QC has no Splunk: logs are read through Argo CD (qc_log_search), with Kafka UI and the QC databases",
      ),
    );
  else if (environment !== config.splunk.environment)
    notes.push(
      say(
        locale,
        `chỉ cấu hình môi trường Splunk "${config.splunk.environment}"; truy vấn dùng môi trường này`,
        `only the "${config.splunk.environment}" Splunk environment is configured; searches use it`,
      ),
    );
  const { providers, missing } = qc ? { providers: [], missing: [] } : selectProviders(inputs.observability);
  if (missing.includes("signoz"))
    notes.push(
      say(
        locale,
        "đã chọn SigNoz nhưng người chạy chưa kết nối hoặc đã tắt SigNoz (Integrations): không truy vấn được SigNoz",
        "SigNoz was selected but the run owner has not connected or has disabled it (Integrations): SigNoz cannot be queried",
      ),
    );
  const ids = parsed.anchors.slice(0, 3);
  const window = { earliest: parsed.time.earliest, latest: parsed.time.latest };
  const signoz_queries = providers.includes("signoz")
    ? [
        { tool: "signoz_aggregate_logs", args: { ...window, severity: "ERROR", group_by: ["service.name"] } },
        ...ids.slice(0, 2).map((id) => ({
          tool: "signoz_search_logs",
          args: { ...window, expression: `body CONTAINS '${id.replace(/['\\]/g, "")}'`, limit: 200 },
        })),
      ]
    : [];
  const initial_queries = (providers.includes("splunk") ? indexes.slice(0, 3) : []).flatMap((idx) =>
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
  return {
    ...parsed,
    indexes,
    environment,
    observability: providers,
    notes,
    initial_queries,
    signoz_queries,
    read_only: true,
  };
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
  if (!out.indexes.length && out.observability.includes("splunk"))
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
  )?.output) ?? null;

function labelsFrom(ctx: ExecutionContext): EventLabel[] {
  const labels: EventLabel[] = [];
  for (const [key, u] of Object.entries(ctx.input.upstream)) {
    if (u.status !== "COMPLETED" || !Array.isArray(u.output?.events)) continue;
    for (const e of u.output.events)
      if (e && typeof e === "object" && e.evidence_ref) labels.push({ ...e, labeled_by: key });
  }
  return labels;
}

/** Iterative rounds: labels of earlier rounds' search attempts stay evidence (each is re-validated by correlate). */
async function roundLabels(ctx: ExecutionContext): Promise<EventLabel[]> {
  const current = labelsFrom(ctx);
  if (config.investigation.maxRounds <= 0) return current;
  const rows = await q<{ key: string; events: unknown[] }>(
    pool,
    `SELECT s.key, a.output->'events' AS events FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id
      WHERE a.run_id = $1 AND a.status = 'COMPLETED' AND jsonb_typeof(a.output->'events') = 'array' ORDER BY a.id`,
    [ctx.run.id],
  );
  const byRef = new Map<string, EventLabel>();
  for (const r of rows)
    for (const e of r.events as EventLabel[])
      if (e && typeof e === "object" && e.evidence_ref) byRef.set(e.evidence_ref, { ...e, labeled_by: r.key });
  for (const l of current) byRef.set(l.evidence_ref, l);
  return [...byRef.values()];
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
    splunk_url:
      r.mode === "argocd"
        ? null
        : buildSearchUrl(r.query, r.earliest.getTime(), r.latest.getTime()),
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
    labels: await roundLabels(ctx),
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
  const refine = String(ctx.step.config.refine_step ?? "refine_search");
  const refineStatus = (
    await q<{ status: string }>(pool, "SELECT status FROM workflow_steps WHERE run_id = $1 AND key = $2", [ctx.run.id, refine])
  )[0]?.status;
  // A refine step skipped by its run_if would be skipped again: no further round can search.
  const canRefine = !!refineStatus && refineStatus !== "SKIPPED";
  const round = await investigationRound(ctx, parsed, timelineOut, rows, up("findings", "analyze_findings"), up("code", "analyze_code"), canRefine);
  const report = buildReport({
    round,
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
  const output = { ...report, report_artifact_id: artifactId, report_markdown: report.markdown, round };
  if (round.stop_reason === null)
    return { kind: "reexecute", target: refine, feedback: roundFeedback(round), output };
  return { kind: "completed", output };
}

/**
 * One investigation round: hypotheses, deployed versions, impact and query coverage evaluated from stored evidence, the
 * stop rule applied, the next actions planned. Persisted as an immutable artifact per report generation (a restart of the
 * same generation reuses it: no extra round) and logged as a decision with the round telemetry.
 */
async function investigationRound(
  ctx: ExecutionContext,
  parsed: ParsedRequest,
  timelineOut: { timeline?: TimelineEvent[]; uncorrelated?: TimelineEvent[]; missing?: Array<{ objective: string; needed: string }>; identifiers?: Record<string, string[]> },
  rows: Awaited<ReturnType<typeof runSearches>>,
  findings: unknown,
  code: { code_locations?: Array<{ repo?: string }>; services?: Array<{ repo?: string }> } | undefined,
  canRefine: boolean,
): Promise<RoundState> {
  const prior = await q<{ data: RoundState }>(
    pool,
    "SELECT data FROM workflow_artifacts WHERE run_id = $1 AND kind = 'investigation_round' ORDER BY id",
    [ctx.run.id],
  );
  const last = prior.at(-1)?.data;
  if (last && last.generation === ctx.step.generation && last.step_id === ctx.step.id) return last;
  const timeline = timelineOut.timeline ?? [];
  const refsOf = (t: TimelineEvent) => [t.evidence_ref, ...(t.duplicates ?? [])];
  const knownRefs = new Set([...timeline, ...(timelineOut.uncorrelated ?? [])].flatMap(refsOf));
  const runtimeRefs = new Set(timeline.filter((t) => t.confidence !== "unknown").flatMap(refsOf));
  const repositories = new Set(
    [...(code?.code_locations ?? []), ...(code?.services ?? [])].map((c) => String(c?.repo ?? "")).filter(Boolean),
  );
  const coverage = searchCoverage(rows);
  const anchorMs = parsed.time.anchor ? Date.parse(parsed.time.anchor) : null;
  const gaps = coverageGaps(coverage, anchorMs);
  const hypotheses = evaluateHypotheses(findings, { knownRefs, runtimeRefs, repositories });
  const deployed = deployedVersions(findings, knownRefs);
  const impact = impactCounts(timeline, coverage);
  const blocked = gaps.includes("no_answered_search") || (!coverage.length && !splunkConnected());
  const verdict = rootCauseOutcome({ hypotheses, impact, deployed, blocked });
  const missing = timelineOut.missing ?? [];
  const done = new Set<string>(prior.flatMap((p) => (p.data.actions ?? []).map((a: NextAction) => a.fingerprint)));
  const actions = planNextActions({
    gaps,
    anchor: parsed.time.anchor,
    identifiers: timelineOut.identifiers ?? {},
    searchedText: rows.map((r) => r.query).join("\n"),
    missing,
    hypotheses,
    deployed,
    done,
  });
  const signature = progressSignature({ refs: [...runtimeRefs], hypotheses, missing: missing.map((m) => m.objective) });
  const queriesUsed = rows.filter((r) => r.mode !== "manual" && ["done", "failed", "running"].includes(r.status)).length;
  const round = prior.length + 1;
  const rule = stopReason({
    enabled: config.investigation.maxRounds > 0,
    round,
    maxRounds: config.investigation.maxRounds,
    queriesUsed,
    queryBudget: config.splunk.queryBudget,
    outcome: verdict.outcome,
    signature,
    previousSignature: last?.signature ?? null,
    actions,
  });
  const stop = rule ?? (canRefine ? null : "no_remaining_actions");
  const previousRefs = new Set<string>(last?.refs ?? []);
  const state: RoundState = {
    round,
    max_rounds: config.investigation.maxRounds,
    step_id: ctx.step.id,
    generation: ctx.step.generation,
    time: { earliest: parsed.time.earliest, latest: parsed.time.latest, timezone: parsed.time.timezone, anchor: parsed.time.anchor },
    services: parsed.services.map((x) => x.name),
    outcome: verdict.outcome,
    outcome_reasons: verdict.reasons,
    hypotheses: hypotheses.map((h) => ({
      ...h,
      statement: sanitizeText(h.statement),
      predicted_observations: h.predicted_observations.map(sanitizeText),
    })),
    deployed,
    impact,
    coverage: coverage.map(({ id, reason, rows: n }) => ({ id, reason, rows: n })),
    gaps,
    missing,
    actions: actions.map((a) => ({ ...a, detail: sanitizeText(a.detail) })),
    refs: [...runtimeRefs],
    new_evidence: [...runtimeRefs].filter((r) => !previousRefs.has(r)).length,
    queries_used: queriesUsed,
    query_budget: config.splunk.queryBudget,
    signature,
    stop_reason: stop,
  };
  await ctx.artifact("investigation_round", `round-${round}.json`, JSON.stringify(state), state);
  void noteDecision({
    runId: ctx.run.id,
    stepId: ctx.step.id,
    attemptId: ctx.attempt.id,
    generation: ctx.step.generation,
    kind: "investigation",
    action: stop === null ? "REPLAN" : "STOP",
    outcome: "applied",
    reason: stop === null ? `round ${round}: ${actions.length} next action(s)` : `round ${round}: stopped (${stop})`,
    details: {
      round,
      outcome: verdict.outcome,
      queries_used: queriesUsed,
      new_evidence: state.new_evidence,
      planned_actions: actions.length,
      skipped_duplicate_actions: done.size,
      hypotheses: hypotheses.map((h) => `${h.id}:${h.status}`),
    },
  });
  return state;
}

function roundFeedback(r: RoundState) {
  return [
    `Investigation round ${r.round + 1} of at most ${r.max_rounds}. Current root-cause outcome: ${r.outcome}${r.outcome_reasons.length ? ` (${r.outcome_reasons.join("; ")})` : ""}.`,
    `Hypotheses: ${r.hypotheses.map((h) => `${h.id} [${h.kind}] ${h.status}`).join("; ") || "none yet"}.`,
    r.gaps.length ? `Query coverage gaps: ${r.gaps.join(", ")}.` : "",
    "Do these next, in order, and nothing equivalent to an earlier search (stored searches are reused, not repeated):",
    ...r.actions.map((a, i) => `${i + 1}. ${a.kind}: ${a.detail}`),
    `Queries used ${r.queries_used}/${r.query_budget}. Label only events you saw; if an action cannot be done, say exactly why (no rows, permission, window, retention).`,
  ]
    .filter(Boolean)
    .join("\n");
}
