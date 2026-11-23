/**
 * Production Bug Hunter — starting and reading hunts. A hunt is an ordinary `production-bug-hunt` workflow run owned by
 * the requesting user (their repository permissions, their provider settings, the existing run gates), linked to the
 * incident by a `bug_hunts` row. The incident's own work-item link and the scanner are untouched.
 */
import { createHash } from "node:crypto";
import { pool, q, one } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import { audit, type Actor } from "../authz/access.ts";
import { startRun, EngineError } from "../workflow/engine.ts";
import { describeGroup, type GroupRow } from "../prodErrors/scan.ts";
import { workItems } from "../workitems/service.ts";
import { config } from "../config.ts";

export const BUG_HUNT_WORKFLOW = "production-bug-hunt";
const MAX_REPOSITORIES = 3;
const ACTIVE = ["PENDING", "RUNNING", "PAUSED", "WAITING"];

export type HuntStatus =
  "queued" | "running" | "verifying" | "completed" | "partial" | "failed" | "canceled";

/** The hunt's status, derived from the workflow run (no second state machine). */
export function huntStatus(
  runStatus: string,
  steps: Array<{ key: string; status: string }>,
  report: { partial?: boolean } | null,
): HuntStatus {
  if (runStatus === "CANCELED") return "canceled";
  if (runStatus === "FAILED") return "failed";
  if (runStatus === "COMPLETED") return report?.partial || !report ? "partial" : "completed";
  const started = steps.some((s) => s.status !== "PENDING" && s.status !== "READY");
  if (!started) return "queued";
  const at = (k: string) => steps.find((s) => s.key === k)?.status;
  if (
    ["RUNNING", "READY", "WAITING_INPUT"].includes(at("verify") ?? "") ||
    ["RUNNING", "READY"].includes(at("reproduce") ?? "")
  )
    return "verifying";
  return "running";
}

const scopeKey = (repos: string[]) => [...repos].sort().join(",");
const lockKey = (s: string) => createHash("sha256").update(s).digest().readBigInt64BE(0).toString();

/**
 * Start a hunt for an incident, as `actor`, over repositories the actor may read (startRun enforces it). Concurrent
 * requests for the same incident, repositories and user get the one active hunt (session advisory lock + check).
 */
export async function startBugHunt(
  fingerprint: string,
  actor: Actor,
  body: { repositories?: unknown; provider?: unknown; context?: string; prior_evidence?: string[] },
) {
  if (!/^[0-9a-f]{20}$/.test(fingerprint)) throw new HttpError(400, "invalid fingerprint");
  const repos = Array.isArray(body.repositories) ? [...new Set(body.repositories.map(String))] : [];
  if (!repos.length) throw new HttpError(400, "select at least one repository");
  if (repos.length > MAX_REPOSITORIES)
    throw new HttpError(400, `a bug hunt covers at most ${MAX_REPOSITORIES} repositories`);
  const g = await one<GroupRow>(
    pool,
    "SELECT *, day::text AS day FROM prod_error_groups WHERE fingerprint = $1",
    [fingerprint],
  );
  if (!g) throw new HttpError(404, "incident not found");
  const key = scopeKey(repos);
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock($1::bigint)", [
      lockKey(`bug_hunt:${actor.id}:${fingerprint}:${key}`),
    ]);
    const active = await one<{ id: number; run_id: number }>(
      c,
      `SELECT h.id, h.run_id FROM bug_hunts h JOIN workflow_runs r ON r.id = h.run_id
        WHERE h.fingerprint=$1 AND h.scope_key=$2 AND h.requested_by=$3 AND r.status = ANY($4) ORDER BY h.id DESC LIMIT 1`,
      [fingerprint, key, actor.id, ACTIVE],
    );
    if (active)
      return { created: false, hunt_id: Number(active.id), run_id: Number(active.run_id) };
    let run;
    try {
      run = await startRun({
        definitionKey: BUG_HUNT_WORKFLOW,
        title: `[Bug Hunt] ${g.service}: ${g.signature}`.slice(0, 160),
        // `context`: bounded, already-validated prior evidence of the same incident (unified workbench), as hints.
        inputs: {
          fingerprint,
          request: describeGroup(g) + (body.context ?? ""),
          ...(body.prior_evidence?.length ? { prior_evidence: body.prior_evidence } : {}),
        },
        repositories: repos,
        agentProvider: body.provider ? String(body.provider) : undefined,
        ownerId: actor.id,
      });
    } catch (e) {
      if (e instanceof EngineError) throw new HttpError(e.status ?? 400, e.message);
      throw e;
    }
    const hunt = await one<{ id: number }>(
      c,
      `INSERT INTO bug_hunts (fingerprint, run_id, requested_by, repositories, scope_key) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [fingerprint, run.id, actor.id, repos, key],
    );
    await audit(actor.id, "prod_errors.bug_hunt.start", "prod_error_group", fingerprint, {
      run_id: run.id,
      repositories: repos,
    });
    return { created: true, hunt_id: Number(hunt!.id), run_id: Number(run.id) };
  } finally {
    await c.query("SELECT pg_advisory_unlock_all()").catch(() => {});
    c.release();
  }
}

interface HuntRow {
  id: number;
  fingerprint: string;
  run_id: number;
  requested_by: number | null;
  repositories: string[];
  revisions: Record<string, string> | null;
  report: Record<string, unknown> | null;
  created_at: string;
  finished_at: string | null;
  run_status: string;
  agent_provider: string | null;
}

const HUNT_SQL = `SELECT h.*, r.status AS run_status, r.agent_provider FROM bug_hunts h JOIN workflow_runs r ON r.id = h.run_id`;

async function shape(h: HuntRow, full: boolean) {
  const steps = await q<{
    id: number;
    key: string;
    name: string;
    status: string;
    started_at: string | null;
    finished_at: string | null;
    error: unknown;
    attempt_count: number | null;
    max_attempts: number | null;
    current_attempt_id: number | null;
    output: Record<string, unknown> | null;
  }>(
    pool,
    `SELECT s.id, s.key, s.name, s.status, s.started_at, s.finished_at, s.attempt_count, s.max_attempts,
            s.current_attempt_id, CASE WHEN s.status = 'SKIPPED' THEN s.output END AS output,
            (SELECT a.error FROM workflow_step_attempts a WHERE a.id = s.current_attempt_id) AS error
       FROM workflow_steps s WHERE s.run_id=$1 ORDER BY s.position`,
    [h.run_id],
  );
  const findings = await q<{ finding: Record<string, unknown>; id: number }>(
    pool,
    "SELECT id, finding FROM bug_hunt_findings WHERE hunt_id=$1 ORDER BY id",
    [h.id],
  );
  const counts = { CONFIRMED: 0, SUSPECTED: 0, REJECTED: 0, BLOCKED: 0 } as Record<string, number>;
  for (const f of findings) counts[String(f.finding.bug_verification_status)]++;
  const status = huntStatus(h.run_status, steps, h.report as { partial?: boolean } | null);
  const base = {
    id: Number(h.id),
    fingerprint: h.fingerprint,
    run_id: Number(h.run_id),
    run_status: h.run_status,
    status,
    repositories: h.repositories,
    revisions: h.revisions,
    provider: h.agent_provider,
    created_at: h.created_at,
    finished_at: h.finished_at,
    counts,
    root_cause_confirmed: findings.some((f) => f.finding.incident_causality_status === "CONFIRMED"),
    stages: steps.map((s) => ({
      id: Number(s.id),
      key: s.key,
      name: s.name,
      status: s.status,
      started_at: s.started_at,
      finished_at: s.finished_at,
      attempt: s.attempt_count == null ? null : Number(s.attempt_count),
      max_attempts: s.max_attempts == null ? null : Number(s.max_attempts),
      // Why a stage stopped: its last attempt's error, or why it was skipped. Never synthesized.
      error:
        s.status === "FAILED" && s.error
          ? String((s.error as { message?: string })?.message ?? s.error).slice(0, 500)
          : null,
      skipped_reason: s.status === "SKIPPED" ? String(s.output?.reason ?? "") || null : null,
    })),
  };
  if (!full) return base;
  // What the running stage last recorded (a platform log line or the name of a tool call), with its time.
  const running = steps.find((s) => s.status === "RUNNING" && s.current_attempt_id);
  const activity = running
    ? await one<{ kind: string; content: string; tool: string | null; created_at: string }>(
        pool,
        `SELECT kind, left(content, 240) AS content, data->>'name' AS tool, created_at FROM workflow_events
          WHERE attempt_id=$1 AND kind IN ('system','tool') ORDER BY id DESC LIMIT 1`,
        [running.current_attempt_id],
      )
    : null;
  const triage = !h.report
    ? steps.find((s) => s.key === "triage" && s.status === "COMPLETED")
    : undefined;
  const triageOut = triage
    ? await one<{ output: Record<string, unknown> | null }>(
        pool,
        "SELECT output FROM workflow_steps WHERE id=$1",
        [triage.id],
      )
    : null;
  // Before the report exists (running, or the run failed before it), the hunter's raw candidates are shown as what they
  // are: unverified hypotheses.
  const hunt = await one<{ output: Record<string, unknown> | null }>(
    pool,
    "SELECT output FROM workflow_steps WHERE run_id=$1 AND key='hunt' AND status='COMPLETED'",
    [h.run_id],
  );
  return {
    ...base,
    server_time: new Date().toISOString(),
    activity: activity
      ? {
          stage: running!.key,
          kind: activity.kind,
          text: activity.kind === "tool" && activity.tool ? activity.tool : activity.content,
          at: activity.created_at,
        }
      : null,
    // Between triage and the report: which claims are being verified (platform-built, no hunter reasoning).
    verifying: triageOut?.output
      ? {
          claims: ((triageOut.output.to_verify ?? []) as Array<Record<string, unknown>>).map(
            (c) => ({
              id: c.id,
              file_path: c.file_path,
              function: c.function,
              line_start: c.line_start,
              category: c.category,
              claim: c.claim,
            }),
          ),
          deferred: ((triageOut.output.deferred ?? []) as unknown[]).length,
          rejected: ((triageOut.output.rejected ?? []) as unknown[]).length,
        }
      : null,
    report: h.report,
    findings: findings.map((f) => ({ finding_id: Number(f.id), ...f.finding })),
    unverified_candidates:
      !h.report && Array.isArray(hunt?.output?.candidates) ? hunt!.output!.candidates : [],
    errors: steps
      .filter((s) => s.status === "FAILED" && s.error)
      .map((s) => ({
        step: s.key,
        error: String((s.error as { message?: string })?.message ?? s.error).slice(0, 500),
      })),
    follow_ups: await q(
      pool,
      `SELECT r.id AS run_id, r.status, w.id AS work_item_id, w.code, (r.inputs->>'bug_hunt_finding_id')::bigint AS finding_id
         FROM workflow_runs r LEFT JOIN work_items w ON w.id = r.work_item_id
        WHERE r.inputs->>'bug_hunt_id' = $1 ORDER BY r.id DESC`,
      [String(h.id)],
    ),
  };
}

/**
 * The requester's latest hunt for each of several incidents, in one query (the incident list shows it in row headers
 * without one request per row).
 */
export async function bugHuntSummaries(fingerprints: string[], actor: Actor) {
  const fps = [...new Set(fingerprints)].filter((f) => /^[0-9a-f]{20}$/.test(f)).slice(0, 500);
  if (!fps.length) return { hunts: {} };
  const rows = await q<{
    fingerprint: string;
    id: number;
    run_id: number;
    run_status: string;
    report: { partial?: boolean } | null;
    steps: Array<{ key: string; status: string }>;
    confirmed: number;
  }>(
    pool,
    `SELECT DISTINCT ON (h.fingerprint) h.fingerprint, h.id, h.run_id, r.status AS run_status, h.report,
            COALESCE((SELECT json_agg(json_build_object('key', s.key, 'status', s.status) ORDER BY s.position)
                        FROM workflow_steps s WHERE s.run_id = h.run_id), '[]') AS steps,
            (SELECT count(*)::int FROM bug_hunt_findings f WHERE f.hunt_id = h.id AND f.bug_verification_status = 'CONFIRMED') AS confirmed
       FROM bug_hunts h JOIN workflow_runs r ON r.id = h.run_id
      WHERE h.fingerprint = ANY($1) AND h.requested_by = $2
      ORDER BY h.fingerprint, h.id DESC`,
    [fps, actor.id],
  );
  return {
    hunts: Object.fromEntries(
      rows.map((r) => [
        r.fingerprint,
        {
          id: Number(r.id),
          run_id: Number(r.run_id),
          status: huntStatus(r.run_status, r.steps, r.report),
          confirmed: r.confirmed,
        },
      ]),
    ),
  };
}

/** The actor's hunts for an incident (admins in support mode see everyone's), newest first. */
export async function listBugHunts(fingerprint: string, actor: Actor, support: boolean) {
  if (!/^[0-9a-f]{20}$/.test(fingerprint)) throw new HttpError(400, "invalid fingerprint");
  const rows = await q<HuntRow>(
    pool,
    `${HUNT_SQL} WHERE h.fingerprint=$1 AND (h.requested_by=$2 OR $3) ORDER BY h.id DESC LIMIT 20`,
    [fingerprint, actor.id, support && actor.role === "admin"],
  );
  return { hunts: await Promise.all(rows.map((h) => shape(h, false))) };
}

async function huntFor(actor: Actor, id: number, support: boolean) {
  const h = await one<HuntRow>(pool, `${HUNT_SQL} WHERE h.id=$1`, [id]);
  if (!h) throw new HttpError(404, "not found");
  if (Number(h.requested_by) !== actor.id) {
    if (!(support && actor.role === "admin")) throw new HttpError(404, "not found");
    await audit(actor.id, "support.access", "bug_hunt", String(id));
  }
  return h;
}

export async function bugHuntDetail(id: number, actor: Actor, support: boolean) {
  return shape(await huntFor(actor, id, support), true);
}

/**
 * Follow-up fix task for one finding: a work item describing the verified defect, handed to the existing Bug
 * Investigation workflow (root cause → fix proposal → human approval → fix → tests → review → PR, all behind their
 * gates). Only CONFIRMED or SUSPECTED findings; idempotent per finding.
 */
export async function createFixTask(huntId: number, findingId: number, actor: Actor) {
  const h = await huntFor(actor, huntId, false);
  const row = await one<{ finding: Record<string, unknown> }>(
    pool,
    "SELECT finding FROM bug_hunt_findings WHERE id=$1 AND hunt_id=$2",
    [findingId, huntId],
  );
  if (!row) throw new HttpError(404, "finding not found");
  const f = row.finding as Record<string, string | number | string[]>;
  if (!["CONFIRMED", "SUSPECTED"].includes(String(f.bug_verification_status)))
    throw new HttpError(400, "only confirmed or suspected findings can become a fix task");
  const existing = await one<{ id: number; work_item_id: number | null }>(
    pool,
    "SELECT id, work_item_id FROM workflow_runs WHERE inputs->>'bug_hunt_finding_id' = $1 AND status <> 'CANCELED' ORDER BY id DESC LIMIT 1",
    [String(findingId)],
  );
  if (existing)
    return { created: false, run_id: Number(existing.id), work_item_id: existing.work_item_id };
  const g = await one<{ namespace: string; service: string }>(
    pool,
    "SELECT namespace, service FROM prod_error_groups WHERE fingerprint=$1",
    [h.fingerprint],
  );
  const project =
    config.prodErrors.namespaces.find((n) => n.namespace === g?.namespace)?.project ?? "";
  const status = String(f.bug_verification_status);
  const item = await workItems.createManual({
    title: `[Bug Hunt] ${f.repository}: ${f.function} — ${String(f.category)}`.slice(0, 160),
    description: [
      `Defect ${status === "CONFIRMED" ? "CONFIRMED by independent verification" : "SUSPECTED (not proven)"} — bug hunt #${huntId} (run #${h.run_id}) for incident ${h.fingerprint}.`,
      `Incident causality: ${f.incident_causality_status}.`,
      "",
      `Location: ${f.repository}@${String(f.commit).slice(0, 12)} ${f.file_path}:${f.line_start}-${f.line_end} (${f.function})`,
      `Hypothesis: ${f.hypothesis}`,
      `Trigger: ${f.trigger}`,
      `Expected: ${f.expected}`,
      `Actual: ${f.actual}`,
      `Verification basis: ${f.basis}`,
    ].join("\n"),
    project,
    ownerId: actor.id,
  });
  const run = await startRun({
    definitionKey: "bug-investigation",
    workItemId: item.id,
    repositories: [String(f.repository)],
    inputs: { bug_hunt_id: huntId, bug_hunt_finding_id: findingId },
    ownerId: actor.id,
  });
  await audit(actor.id, "prod_errors.bug_hunt.fix_task", "bug_hunt", String(huntId), {
    finding_id: findingId,
    run_id: run.id,
  });
  return { created: true, run_id: Number(run.id), work_item_id: item.id, code: item.code };
}
