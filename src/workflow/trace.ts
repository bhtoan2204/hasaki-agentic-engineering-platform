import { pool, q, type Db } from "../db/pool.ts";
import { redactSecrets } from "../integrations/redact.ts";
import { redactContextValue } from "../context/redact.ts";
import { runEvents } from "./events.ts";

/**
 * Execution tracing on top of the existing workflow_events / workflow_step_attempts tables.
 * Nothing here opens a second logging system: debug logs are `trace` events with a level and a `data.trace` block.
 */
export const TRACE_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
export type TraceLevel = (typeof TRACE_LEVELS)[number];

export const TRACE_LIMITS = {
  /** Serialized size of one event's content / data. */
  payloadBytes: 8 * 1024,
  /** Rows returned by one logs request. */
  logPage: 500,
  /** DEBUG events older than this are purged; every other event is kept. */
  debugRetentionDays: 7,
  /** DEBUG rows deleted per retention statement, and statements per retention pass. */
  purgeBatch: 5000,
  purgeBatches: 100,
  /** Newest tool / tool_result events loaded into one trace tree. */
  treeEvents: 20000,
};

/** pg_try_advisory_xact_lock key: one instance purges DEBUG events at a time. */
const PURGE_LOCK = 727_057;

const rank = (l: string | null | undefined) =>
  Math.max(0, TRACE_LEVELS.indexOf((l ?? "INFO") as TraceLevel));

export function isTraceLevel(v: unknown): v is TraceLevel {
  return typeof v === "string" && (TRACE_LEVELS as readonly string[]).includes(v);
}

function minLevel(): TraceLevel {
  const v = process.env.TRACE_MIN_LEVEL?.toUpperCase();
  return isTraceLevel(v) ? v : "INFO";
}

function cap(s: string, max = TRACE_LIMITS.payloadBytes) {
  return s.length > max ? `${s.slice(0, max)}… [truncated ${s.length - max} chars]` : s;
}

function clip(v: unknown, max: number): unknown {
  if (typeof v === "string") return cap(v, max);
  if (Array.isArray(v)) return v.map((x) => clip(x, max));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x, max)]));
  return v;
}

const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;

const secretKey = (k: string) => redactSecrets(`"${k}":"probe-value"`).endsWith('***"');

// redactContextValue only masks exact key names; this restores the key+value patterns (github_token, db_password...).
function maskFields(v: unknown): unknown {
  if (typeof v === "string") return v.replace(GITHUB_TOKEN, "[redacted]");
  if (Array.isArray(v)) return v.map(maskFields);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        typeof x === "string" && secretKey(k) ? "[redacted]" : maskFields(x),
      ]),
    );
  return v;
}

export function redactTraceValue(value: unknown): unknown {
  if (value == null) return null;
  const max = TRACE_LIMITS.payloadBytes;
  const redacted = maskFields(
    redactContextValue(value instanceof Error ? { message: value.message } : value),
  );
  if (typeof redacted === "string") return cap(redacted, max);
  let json = JSON.stringify(redacted);
  if (json.length <= max) return redacted;
  let out: unknown = redacted;
  for (const limit of [2000, 200, 40]) {
    out = clip(redacted, limit);
    json = JSON.stringify(out);
    if (json.length <= max) return out;
  }
  const trace = (redacted as { trace?: unknown } | null)?.trace;
  return trace === undefined
    ? cap(json, max)
    : { trace: clip(trace, 200), truncated: cap(json, max - 1024) };
}

export interface TraceEventInput {
  runId: number;
  stepId?: number | null;
  attemptId?: number | null;
  level: TraceLevel;
  /** Machine-readable event type, e.g. job.claimed, step.transition, git.worktree.add, tool.call. */
  event: string;
  message: string;
  provider?: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  durationMs?: number | null;
  status?: string | null;
  data?: unknown;
}

/**
 * Best-effort: never throws and never joins a transaction (it writes through the pool), so a telemetry failure
 * cannot change workflow state or transaction semantics. Returns whether the event was stored.
 */
export async function traceLog(
  ev: TraceEventInput,
  db: Db = pool,
  threshold: TraceLevel = minLevel(),
): Promise<boolean> {
  try {
    if (rank(ev.level) < rank(threshold)) return false;
    const data = {
      trace: {
        event: ev.event,
        provider: ev.provider ?? null,
        span_id: ev.spanId ?? null,
        parent_span_id: ev.parentSpanId ?? null,
        duration_ms: ev.durationMs ?? null,
        status: ev.status ?? null,
      },
      details: redactTraceValue(ev.data ?? null),
    };
    await runEvents.add(
      db,
      ev.runId,
      "trace",
      cap(redactSecrets(ev.message)),
      ev.stepId ?? null,
      ev.attemptId ?? null,
      data,
      ev.level,
    );
    return true;
  } catch (e) {
    console.error(`trace: could not record ${ev.event} (run ${ev.runId}): ${(e as Error).message}`);
    return false;
  }
}

export interface LogFilter {
  stepId?: number;
  attemptId?: number;
  provider?: string;
  event?: string;
  level?: TraceLevel;
  from?: string;
  to?: string;
  afterId?: number;
  limit?: number;
}

/** Structured logs of a run, filtered and paged by id (incremental with `afterId`). Output is redacted again on read. */
export async function searchLogs(runId: number, f: LogFilter = {}, db: Db = pool) {
  const params: unknown[] = [runId, f.afterId ?? 0];
  const where = ["e.run_id = $1", "e.id > $2", "e.kind = 'trace'"];
  const add = (sql: string, v: unknown) => (params.push(v), where.push(sql.replace("?", `$${params.length}`)));
  if (f.stepId) add("e.step_id = ?", f.stepId);
  if (f.attemptId) add("e.attempt_id = ?", f.attemptId);
  if (f.provider) add("e.data->'trace'->>'provider' = ?", f.provider);
  if (f.event) add("e.data->'trace'->>'event' = ?", f.event);
  if (f.level) add("e.level = ?", f.level);
  if (f.from) add("e.created_at >= ?::timestamptz", f.from);
  if (f.to) add("e.created_at <= ?::timestamptz", f.to);
  params.push(Math.min(Math.max(1, f.limit ?? 200), TRACE_LIMITS.logPage));
  const rows = await q(
    db,
    `SELECT e.id, e.step_id, e.attempt_id, e.kind, e.level, e.content, e.data, e.created_at
       FROM workflow_events e WHERE ${where.join(" AND ")} ORDER BY e.id LIMIT $${params.length}`,
    params,
  );
  return rows.map(redactEventRow);
}

export function redactEventRow<T extends { content?: string; data?: unknown }>(row: T): T {
  return {
    ...row,
    content: cap(redactSecrets(String(row.content ?? ""))),
    data: row.data == null ? null : redactTraceValue(row.data),
  };
}

/** Retention: only DEBUG events expire, in bounded batches under a single-instance advisory lock. */
export async function purgeDebugEvents(days = TRACE_LIMITS.debugRetentionDays, db: Db = pool) {
  let total = 0;
  for (let i = 0; i < TRACE_LIMITS.purgeBatches; i++) {
    const r = await db.query(
      `DELETE FROM workflow_events WHERE id IN (
         SELECT id FROM workflow_events
          WHERE level = 'DEBUG' AND created_at < now() - make_interval(days => $1)
          ORDER BY created_at LIMIT $2)
         AND pg_try_advisory_xact_lock($3)`,
      [days, TRACE_LIMITS.purgeBatch, PURGE_LOCK],
    );
    total += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < TRACE_LIMITS.purgeBatch) break;
  }
  return total;
}

// ---- trace tree -------------------------------------------------------------------------------------------------

export interface TraceNode {
  id: string;
  type: "run" | "step" | "attempt" | "tool" | "handoff";
  label: string;
  status: string | null;
  startedAt: string | null;
  durationMs: number | null;
  /** Correlation identifiers; absent ones were not observed. */
  ids: { runId: number; stepId?: number; attemptId?: number; jobId?: number | null; toolUseId?: string };
  attrs: Record<string, unknown>;
  children: TraceNode[];
}

export interface TraceInput {
  run: { id: number; status: string; created_at: string; finished_at?: string | null };
  steps: Array<{
    id: number;
    key: string;
    type: string;
    status: string;
    live_job_status?: string | null;
    live_job_available_at?: string | null;
    live_job_lease_expires_at?: string | null;
  }>;
  attempts: Array<{
    id: number;
    step_id: number;
    number: number;
    generation: number;
    status: string;
    job_id: number | null;
    started_at: string;
    finished_at: string | null;
    error?: unknown;
    provider?: string | null;
    model?: string | null;
    wall_duration_ms?: number | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
    failure_category?: string | null;
    workspace_conflict?: boolean | null;
  }>;
  /** `tool` events, their `tool_result` partners and `tool.prepare_branch` trace events, ordered by id. */
  events: Array<{ id: number; attempt_id: number | null; kind: string; content: string; data: Record<string, unknown> | null; created_at: string }>;
  handoffs: Array<{ source_attempt_id: number; target_attempt_id: number | null; reason: string; status: string }>;
}

const ms = (a: string | null | undefined, b: string | null | undefined) =>
  a && b ? Math.max(0, new Date(b).getTime() - new Date(a).getTime()) : null;

/**
 * Pure: Run → Step → Attempt → Tool call (subagent calls nest under data.parent). Only observed rows become nodes;
 * a tool call without a result stays open (null duration/status) rather than being guessed.
 */
export function assembleTrace(input: TraceInput): TraceNode {
  const root: TraceNode = {
    id: `run:${input.run.id}`,
    type: "run",
    label: `Run #${input.run.id}`,
    status: input.run.status,
    startedAt: input.run.created_at,
    durationMs: ms(input.run.created_at, input.run.finished_at),
    ids: { runId: input.run.id },
    attrs: {},
    children: [],
  };
  const runId = input.run.id;
  const handoffBySource = new Map(input.handoffs.map((h) => [h.source_attempt_id, h]));
  for (const step of input.steps) {
    const stepNode: TraceNode = {
      id: `step:${step.id}`,
      type: "step",
      label: step.key,
      status: step.status,
      startedAt: null,
      durationMs: null,
      ids: { runId, stepId: step.id },
      attrs: {
        stepType: step.type,
        liveJob: step.live_job_status
          ? {
              status: step.live_job_status,
              availableAt: step.live_job_available_at ?? null,
              leaseExpiresAt: step.live_job_lease_expires_at ?? null,
            }
          : null,
      },
      children: [],
    };
    const attempts = input.attempts.filter((a) => a.step_id === step.id).sort((a, b) => a.number - b.number);
    let prev: number | null = null;
    for (const a of attempts) {
      const node: TraceNode = {
        id: `attempt:${a.id}`,
        type: "attempt",
        label: `Attempt ${a.number}`,
        status: a.status,
        startedAt: a.started_at,
        durationMs: a.wall_duration_ms ?? ms(a.started_at, a.finished_at),
        ids: { runId, stepId: step.id, attemptId: a.id, jobId: a.job_id },
        attrs: {
          generation: a.generation,
          provider: a.provider ?? null,
          model: a.model ?? null,
          inputTokens: a.input_tokens ?? null,
          outputTokens: a.output_tokens ?? null,
          failureCategory: a.failure_category ?? null,
          retryOfAttemptId: prev,
          error: a.error == null ? null : redactTraceValue(a.error),
        },
        children: [],
      };
      prev = a.id;
      const calls = new Map<string, TraceNode>();
      const conflicts: string[] = [];
      const events = input.events.filter((e) => e.attempt_id === a.id);
      for (const e of events) {
        if (e.kind === "tool" && e.data?.id) {
          const t: TraceNode = {
            id: `tool:${e.data.id}`,
            type: "tool",
            label: String(e.data.name ?? e.content.split(" ")[0] ?? "tool"),
            status: null,
            startedAt: e.created_at,
            durationMs: null,
            ids: { runId, stepId: step.id, attemptId: a.id, toolUseId: String(e.data.id) },
            attrs: { eventId: e.id, parentToolUseId: e.data.parent ?? null, input: redactTraceValue(e.data.input) },
            children: [],
          };
          calls.set(String(e.data.id), t);
        } else if (e.kind === "tool_result" && e.data?.tool_use_id) {
          const t = calls.get(String(e.data.tool_use_id));
          if (t) {
            t.durationMs = ms(t.startedAt, e.created_at);
            t.status = e.data.is_error ? "ERROR" : "OK";
            t.attrs.resultEventId = e.id;
            t.attrs.result = cap(redactSecrets(e.content), 1000);
          }
        } else if (
          e.kind === "trace" &&
          (e.data?.details as { conflict?: unknown } | null)?.conflict === true
        ) {
          conflicts.push(`event:${e.id}`);
        }
      }
      if (a.workspace_conflict) node.attrs.workspaceConflict = true;
      if (conflicts.length) node.attrs.worktreeConflicts = conflicts;
      for (const t of calls.values()) {
        const parent = t.attrs.parentToolUseId ? calls.get(String(t.attrs.parentToolUseId)) : undefined;
        (parent ?? node).children.push(t);
      }
      const h = handoffBySource.get(a.id);
      if (h)
        node.children.push({
          id: `handoff:${a.id}`,
          type: "handoff",
          label: `Provider handoff (${h.reason})`,
          status: h.status,
          startedAt: null,
          durationMs: null,
          ids: { runId, stepId: step.id, attemptId: a.id },
          attrs: { targetAttemptId: h.target_attempt_id },
          children: [],
        });
      stepNode.children.push(node);
    }
    stepNode.startedAt = attempts[0]?.started_at ?? null;
    stepNode.durationMs = attempts.reduce<number | null>(
      (sum, n) => (n.wall_duration_ms == null && ms(n.started_at, n.finished_at) == null ? sum : (sum ?? 0) + (n.wall_duration_ms ?? ms(n.started_at, n.finished_at) ?? 0)),
      null,
    );
    root.children.push(stepNode);
  }
  return root;
}

/** Loads the rows of a run (reusing execution_attempt_telemetry for duration/tokens) and builds the tree. */
export async function loadTraceInput(runId: number, db: Db = pool): Promise<TraceInput> {
  const [runs, steps, attempts, events, handoffs] = await Promise.all([
    q(db, "SELECT id, status, created_at, finished_at FROM workflow_runs WHERE id = $1", [runId]),
    q(
      db,
      `SELECT s.id, s.key, s.type, s.status, j.status AS live_job_status, j.available_at AS live_job_available_at,
              j.lease_expires_at AS live_job_lease_expires_at
         FROM workflow_steps s LEFT JOIN workflow_jobs j ON j.step_id = s.id AND j.status IN ('queued', 'running')
        WHERE s.run_id = $1 ORDER BY s.position, s.id`,
      [runId],
    ),
    q(
      db,
      `SELECT a.id, a.step_id, a.number, a.generation, a.status, a.job_id, a.started_at, a.finished_at, a.error,
              t.provider, t.model, t.wall_duration_ms, t.input_tokens, t.output_tokens, t.normalized_failure_category AS failure_category,
              (a.metrics->>'workspace_conflict')::boolean AS workspace_conflict
         FROM workflow_step_attempts a LEFT JOIN execution_attempt_telemetry t ON t.attempt_id = a.id
        WHERE a.run_id = $1 ORDER BY a.id`,
      [runId],
    ),
    q(
      db,
      `SELECT * FROM (
         SELECT id, attempt_id, kind, left(content, 2000) AS content, data, created_at FROM workflow_events
          WHERE run_id = $1
            AND (kind IN ('tool', 'tool_result')
                 OR (kind = 'trace' AND data->'trace'->>'event' = 'tool.prepare_branch'))
          ORDER BY id DESC LIMIT $2) e
        ORDER BY id`,
      [runId, TRACE_LIMITS.treeEvents],
    ),
    q(db, "SELECT source_attempt_id, target_attempt_id, reason, status FROM provider_handoffs WHERE run_id = $1", [runId]),
  ]);
  if (!runs[0]) throw new Error(`run ${runId} not found`);
  return { run: runs[0], steps, attempts, events, handoffs };
}

export async function buildTrace(runId: number, db: Db = pool) {
  return assembleTrace(await loadTraceInput(runId, db));
}
