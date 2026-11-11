import { pool, q, one } from "../db/pool.ts";
import { startRun, EngineError } from "../workflow/engine.ts";
import { config } from "../config.ts";
import { runSearches, splunkConnected } from "../integrations/splunk.ts";
import { scoreTriggers, type WorkflowTriggers } from "./request.ts";
import { searchSummaries } from "./steps.ts";

/** API helpers for the investigation UI. Callers authorize the run first (requireRun). */

/**
 * Everything the investigation panel shows for one run: search audit with sanitized events (for expandable
 * evidence), and the outputs of the deterministic steps. Raw pasted text and credentials are never stored, so
 * cannot be returned.
 */
export async function investigationDetail(runId: number) {
  const rows = await runSearches(runId);
  const steps = await q<{ key: string; status: string; output: any; config: any }>(
    pool,
    "SELECT key, status, output, config FROM workflow_steps WHERE run_id = $1 ORDER BY position",
    [runId],
  );
  const byAction = (action: string, final?: boolean) =>
    steps
      .filter(
        (s) =>
          s.config?.action === action &&
          (final === undefined || (s.config?.final === true) === final),
      )
      .find((s) => s.status === "COMPLETED")?.output ?? null;
  const summaries = searchSummaries(rows);
  return {
    timezone: config.splunk.timezone,
    environment: config.splunk.environment,
    splunk_connected: splunkConnected(),
    parsed: byAction("investigation_parse"),
    correlation:
      byAction("investigation_correlate", true) ?? byAction("investigation_correlate", false),
    latency: byAction("investigation_latency"),
    report: byAction("investigation_report"),
    follow_ups: await followUpsOf(runId),
    searches: rows.map((r, i) => ({
      ...summaries[i],
      truncated: r.truncated,
      auth: r.auth,
      created_at: r.created_at,
      finished_at: r.finished_at,
      messages: r.messages,
      events: (r.events ?? []).map((e) => ({
        ref: e.ref,
        time: e.time,
        service: e.service,
        index: e.index,
        source: e.source,
        sourcetype: e.sourcetype,
        ids: e.ids,
        message: e.message,
        raw: e.raw,
      })),
    })),
  };
}

/** Rank workflow definitions whose spec declares `triggers` against a free-text request. */
export function routeWorkflow(
  text: string,
  defs: Array<{
    key: string;
    name: string;
    triggers?: WorkflowTriggers | null;
    category?: string | null;
  }>,
) {
  const matches = defs
    .filter((d) => d.triggers?.phrases?.length)
    .map((d) => ({
      key: d.key,
      name: d.name,
      category: d.category ?? null,
      ...scoreTriggers(text, d.triggers!),
    }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);
  return { workflow: matches[0]?.key ?? null, matches };
}

// ---------------------------------------------------------------- follow-up: fix the cause

export const FIX_WORKFLOW = "bug-investigation";

/** Runs started from this investigation to fix what it found (newest first). */
export function followUpsOf(runId: number) {
  return q<{
    id: number;
    definition_key: string;
    status: string;
    title: string;
    created_at: string;
  }>(
    pool,
    "SELECT id, definition_key, status, title, created_at FROM workflow_runs WHERE inputs->>'investigation_run_id' = $1 ORDER BY id DESC",
    [String(runId)],
  );
}

const cap = (s: unknown, n: number) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/**
 * Hand the investigation over to the existing Bug Investigation workflow (root cause → fix proposal → human approval
 * → implementation → tests → review → PR, every state change behind its existing gates). The investigation itself stays
 * read-only. The new run carries a bounded, already-sanitized summary of the evidence as `inputs.investigation` and is
 * linked by `inputs.investigation_run_id`, which also lets its agents re-read the cited log events (splunk_get_event)
 * instead of trusting the summary. Same owner, work item, language and agent provider. Idempotent while a follow-up
 * is still active.
 */
export async function startFixFromInvestigation(runId: number) {
  const run = await one<any>(pool, "SELECT * FROM workflow_runs WHERE id = $1", [runId]);
  if (!run) throw new EngineError("run not found", 404);
  if (run.definition_key !== "production-incident-investigation")
    throw new EngineError("not a production investigation run", 400);
  const steps = await q<{ key: string; status: string; output: any; config: any }>(
    pool,
    "SELECT key, status, output, config FROM workflow_steps WHERE run_id = $1",
    [runId],
  );
  const out = (action: string, final?: boolean) =>
    steps.find(
      (s) =>
        s.status === "COMPLETED" &&
        s.config?.action === action &&
        (final === undefined || (s.config?.final === true) === final),
    )?.output;
  const report = out("investigation_report");
  if (!report)
    throw new EngineError(
      "the investigation has no report yet: finish it before starting a fix",
      409,
    );
  const active = (await followUpsOf(runId)).find((r) => !["FAILED", "CANCELED"].includes(r.status));
  if (active) return { run_id: active.id, existing: true };
  const findingsStep =
    steps.find(
      (s) =>
        s.status === "COMPLETED" &&
        Array.isArray(s.output?.findings) &&
        Array.isArray(s.output?.answers),
    )?.output ?? {};
  const codeStep =
    steps.find((s) => s.status === "COMPLETED" && Array.isArray(s.output?.code_locations))
      ?.output ?? {};
  const timeline =
    (out("investigation_correlate", true) ?? out("investigation_correlate", false))?.timeline ?? [];
  const latencies = out("investigation_latency")?.latencies ?? [];
  const parsed = out("investigation_parse") ?? {};
  const investigation = {
    run_id: runId,
    status: report.status,
    request: cap(parsed.request ?? run.inputs?.request, 2000),
    time_window: parsed.time
      ? {
          earliest: parsed.time.earliest,
          latest: parsed.time.latest,
          timezone: parsed.time.timezone,
        }
      : null,
    business_summary: cap(report.business_summary, 2000),
    findings: (report.findings ?? []).slice(0, 30).map((f: any) => ({
      statement: cap(f.statement, 600),
      classification: f.classification,
      evidence_refs: f.evidence_refs,
      code_location: f.code_location ?? null,
    })),
    hypotheses: (report.hypotheses ?? []).slice(0, 15).map((h: any) => ({
      hypothesis: cap(h.hypothesis, 600),
      supporting_refs: h.supporting_refs,
    })),
    missing_evidence: (findingsStep.missing_evidence ?? [])
      .slice(0, 15)
      .map((x: unknown) => cap(x, 400)),
    next_steps: (findingsStep.next_steps ?? []).slice(0, 15).map((x: unknown) => cap(x, 400)),
    latencies: latencies.slice(0, 20).map((l: any) => ({
      key: l.key,
      label: l.label,
      latency: l.latency_text,
      confidence: l.confidence,
      from: l.from,
      to: l.to,
      notes: l.notes,
    })),
    timeline: timeline.slice(0, 80).map((t: any) => ({
      timestamp: t.timestamp,
      event_type: t.event_type,
      service: t.service,
      confidence: t.confidence,
      evidence_ref: t.evidence_ref,
      ids: t.ids,
      excerpt: cap(t.excerpt, 300),
    })),
    code_locations: (codeStep.code_locations ?? []).slice(0, 30),
    note: "Sanitized summary of a read-only production investigation. Facts carry evidence_refs (S<search>:<n>); re-read them with splunk_get_event before treating them as observed facts. Hypotheses are not facts.",
  };
  const title = cap(`Fix: ${run.title}`, 250);
  const created = await startRun({
    definitionKey: FIX_WORKFLOW,
    workItemId: run.work_item_id ?? null,
    inputs: {
      investigation_run_id: runId,
      investigation,
      ...(run.inputs?.project ? { project: run.inputs.project } : {}),
    },
    repositories: run.selected_repositories?.length ? run.selected_repositories : undefined,
    title,
    outputLocale: run.output_locale ?? undefined,
    agentProvider: run.agent_provider ?? undefined,
    ownerId: Number(run.owner_id),
  });
  return { run_id: created.id, existing: false };
}
