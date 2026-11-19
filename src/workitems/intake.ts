import { createHash } from "node:crypto";
import { pool, q, one, withTx, json, type Db } from "../db/pool.ts";
import { notify } from "../notify.ts";
import { repositories, rankRepositories, isAmbiguous } from "../repos/service.ts";
import { allowedRepositoriesForRun } from "../repos/access.ts";
import { assessRisk, freezeAutonomy } from "../workflow/autonomy.ts";
import { isolationEnforced } from "../agent/isolation.ts";
import { startRun } from "../workflow/engine.ts";
import { activeRunForWorkItem } from "../workflow/runRepository.ts";
import { EngineError } from "../workflow/mutations.ts";
import { workItems } from "./service.ts";

/**
 * Policy-controlled intake (sources: Hasaki Work items, production error groups). Import stays import-only unless an
 * admin enables a policy: SHADOW triages and records what it would start, AUTOPILOT may start runs through the existing
 * engine and scheduler. Source text is untrusted data: it is ranked and risk-assessed (risk can only rise), never read
 * for authorization. Production incidents only get read-only investigation from intake; unattended coding needs the
 * autonomy AUTOPILOT policy (task 01) AND the enforced OS sandbox (task 04), otherwise it is deferred.
 */

export const INTAKE_SOURCES = ["hasaki_work", "prod_errors"] as const;
export type IntakeSource = (typeof INTAKE_SOURCES)[number];
export const INTAKE_MODES = ["OFF", "SHADOW", "AUTOPILOT"] as const;
export type IntakeMode = (typeof INTAKE_MODES)[number];
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
/** Workflows that change no code and no data: intake may run them without the coding prerequisites. */
export const READ_ONLY_WORKFLOWS = ["production-incident-investigation", "work-item-analysis"];
export const INCIDENT_KEY_VERSION = 2;

export interface IntakePolicy {
  id: number;
  source: IntakeSource;
  owner_id: number | null;
  mode: IntakeMode;
  paused: boolean;
  workflows: string[];
  repositories: string[];
  min_severity: Severity;
  max_active_runs: number;
  max_active_per_repo: number;
  max_runs_per_day: number;
  max_backlog: number;
  cooldown_minutes: number;
  stale_hours: number;
  revision: number;
}

// ---------------------------------------------------------------- incident identity

/** Error codes that make two errors materially different (provider code, HTTP status); volatile ids are not codes. */
export function errorCodes(text: string): string[] {
  const codes = new Set<string>();
  for (const m of String(text ?? "").matchAll(
    /\b(?:code|err(?:or)?_?code|errcode|status(?:_code)?|reason)\b["']?\s*[:=]\s*["']?([A-Za-z]{0,6}[0-9]{2,6}|[A-Z][A-Z0-9_]{2,40})\b/gi,
  ))
    codes.add(m[1].toUpperCase());
  for (const m of String(text ?? "").matchAll(
    /\bHTTP\/?\s?[0-9.]*\s+([45][0-9]{2})\b|\b([45][0-9]{2})\s+(?:Bad|Unauthorized|Forbidden|Not Found|Internal|Service|Gateway|Conflict|Too Many)/gi,
  ))
    codes.add(m[1] ?? m[2]);
  return [...codes].sort().slice(0, 5);
}

/**
 * Versioned incident key: environment, service, level, caller, the normalized signature and the error codes. Request
 * ids, timestamps, uuids and hashes are already normalized out of the signature; materially different codes stay apart.
 * No PII or credentials go in (the signature is normalized and the codes are short identifiers).
 */
export function incidentKey(g: {
  namespace: string;
  service: string;
  level: string;
  caller?: string;
  signature: string;
  sample?: string;
  err?: string;
}) {
  const codes = errorCodes(`${g.signature}\n${g.err ?? ""}\n${g.sample ?? ""}`);
  return `v${INCIDENT_KEY_VERSION}:${createHash("sha256")
    .update(
      [g.namespace, g.service, g.level, g.caller ?? "", g.signature, codes.join(",")].join(
        "\u0000",
      ),
    )
    .digest("hex")
    .slice(0, 32)}`;
}

// ---------------------------------------------------------------- triage (pure)

export interface TriageInput {
  source: IntakeSource;
  policy: Pick<
    IntakePolicy,
    "workflows" | "repositories" | "min_severity" | "stale_hours" | "cooldown_minutes"
  >;
  severity: Severity | null;
  lastSeen: Date;
  title: string;
  description: string;
  /** Repositories the owner may use (effective grants), ranked against the item text by the deterministic ranker. */
  ranked: Array<{ repo: string; score: number; reasons: string[] }>;
  allowed: string[];
  activeRun: boolean;
  sourceClosed: boolean;
  assigned: boolean;
  /** Last intake run finished at, and the item was seen again after the cooldown (recurrence). */
  lastRunFinishedAt: Date | null;
  complexityHighRisk: boolean;
  capabilities: { isolation: boolean; autonomyAutopilot: boolean };
  now?: Date;
}

export interface TriageDecision {
  state: "eligible" | "deferred" | "rejected" | "superseded" | "resolved";
  reasons: string[];
  workflow: string | null;
  repo: string | null;
  read_only: boolean;
  risk: string;
}

const rank = (s: Severity | null) => (s ? SEVERITIES.indexOf(s) : -1);

export function triage(i: TriageInput): TriageDecision {
  const now = i.now ?? new Date();
  const risk = assessRisk({
    texts: [i.title, i.description],
    complexityClass: i.complexityHighRisk ? "HIGH_RISK" : null,
    classificationConfidence: "high",
  });
  const d = (
    state: TriageDecision["state"],
    reasons: string[],
    workflow: string | null = null,
    repo: string | null = null,
  ): TriageDecision => ({
    state,
    reasons,
    workflow,
    repo,
    read_only: !!workflow && READ_ONLY_WORKFLOWS.includes(workflow),
    risk: risk.level,
  });
  if (i.sourceClosed) return d("resolved", ["SOURCE_CLOSED"]);
  if (i.activeRun) return d("superseded", ["ACTIVE_RUN_EXISTS"]);
  if (
    i.lastRunFinishedAt &&
    !(i.lastSeen.getTime() > i.lastRunFinishedAt.getTime() + i.policy.cooldown_minutes * 60_000)
  )
    return d("superseded", ["ALREADY_HANDLED_NO_RECURRENCE"]);
  if (now.getTime() - i.lastSeen.getTime() > i.policy.stale_hours * 3_600_000)
    return d("rejected", ["STALE"]);
  if (i.source === "prod_errors" && rank(i.severity) < rank(i.policy.min_severity))
    return d("rejected", [`BELOW_SEVERITY_${i.policy.min_severity.toUpperCase()}`]);
  if (i.source === "hasaki_work") {
    if (!i.assigned) return d("deferred", ["NEEDS_TRIAGE: not assigned to the owner"]);
    if (i.description.replace(/\s+/g, " ").trim().length < 30)
      return d("deferred", ["NEEDS_TRIAGE: no clear acceptance criteria"]);
  }
  const permitted = i.policy.repositories.length
    ? i.allowed.filter((r) => i.policy.repositories.includes(r))
    : i.allowed;
  const candidates = i.ranked.filter((r) => permitted.includes(r.repo));
  if (!candidates.length || candidates[0].score <= 0)
    return d("deferred", ["REPOSITORY_UNKNOWN_OR_NOT_PERMITTED"]);
  if (isAmbiguous(candidates)) return d("deferred", ["REPOSITORY_AMBIGUOUS"]);
  const repo = candidates[0].repo;
  const workflow =
    i.source === "prod_errors"
      ? (i.policy.workflows.find((w) => READ_ONLY_WORKFLOWS.includes(w)) ?? null)
      : (i.policy.workflows[0] ?? null);
  if (!workflow) return d("deferred", ["NO_PERMITTED_WORKFLOW"], null, repo);
  if (READ_ONLY_WORKFLOWS.includes(workflow))
    return d("eligible", ["READ_ONLY_WITHIN_POLICY"], workflow, repo);
  if (risk.level !== "LOW")
    return d(
      "deferred",
      [`RISK_${risk.level}: a human decides`, ...risk.reasons.slice(0, 3)],
      workflow,
      repo,
    );
  if (!i.capabilities.isolation)
    return d("deferred", ["ISOLATION_NOT_ENFORCED: no unattended coding"], workflow, repo);
  if (!i.capabilities.autonomyAutopilot)
    return d("deferred", ["AUTONOMY_NOT_AUTOPILOT: no unattended coding"], workflow, repo);
  return d("eligible", ["CODING_WITHIN_POLICY"], workflow, repo);
}

/** Queue order: severity, recurrence, then age so nothing waits forever (aging), critical bounded on top. */
export function effectivePriority(
  i: { severity: Severity | null; occurrences: number; enqueuedAt: Date | null },
  now = new Date(),
) {
  const sev = { low: 100, medium: 300, high: 600, critical: 1000 }[i.severity ?? "low"];
  const recurrence = Math.min(200, Math.round(Math.log10(Math.max(1, i.occurrences)) * 100));
  const waitedMinutes = i.enqueuedAt
    ? Math.max(0, (now.getTime() - i.enqueuedAt.getTime()) / 60_000)
    : 0;
  // Aging is capped above critical + max recurrence (1200): critical work wins for at most ~40 hours of waiting.
  return sev + recurrence + Math.min(1300, Math.round(waitedMinutes / 2));
}

// ---------------------------------------------------------------- policies

export async function loadIntakePolicies(db: Db = pool) {
  return q<IntakePolicy>(db, "SELECT * FROM intake_policies ORDER BY source, owner_id NULLS FIRST");
}

/** The policy for a source and owner: the owner's own row, else the source-wide row. */
export function policyFor(policies: IntakePolicy[], source: IntakeSource, ownerId: number | null) {
  return (
    policies.find(
      (p) => p.source === source && ownerId != null && Number(p.owner_id) === ownerId,
    ) ??
    policies.find((p) => p.source === source && p.owner_id == null) ??
    null
  );
}

export async function saveIntakePolicy(
  input: Partial<IntakePolicy> & { source: IntakeSource },
  by: string,
) {
  const bad = (m: string) => new EngineError(m, 400);
  if (!INTAKE_SOURCES.includes(input.source)) throw bad("invalid source");
  const mode = input.mode ?? "SHADOW";
  if (!INTAKE_MODES.includes(mode)) throw bad("invalid mode");
  if (input.min_severity && !SEVERITIES.includes(input.min_severity))
    throw bad("invalid min_severity");
  if (input.source === "prod_errors" && mode === "AUTOPILOT" && input.owner_id == null)
    throw bad("a production-incident policy that starts runs needs a domain owner (owner_id)");
  const names = (await repositories.list()).map((r) => r.name);
  const repos = [...new Set((input.repositories ?? []).map(String))];
  if (repos.some((r) => !names.includes(r))) throw bad("unknown repository in repositories");
  const ints = [
    "max_active_runs",
    "max_active_per_repo",
    "max_runs_per_day",
    "max_backlog",
    "cooldown_minutes",
    "stale_hours",
  ] as const;
  for (const k of ints)
    if (input[k] != null && (!Number.isInteger(input[k]) || (input[k] as number) < 0))
      throw bad(`${k} must be a non-negative integer`);
  const [row] = await q<IntakePolicy>(
    pool,
    `INSERT INTO intake_policies (source, owner_id, mode, paused, workflows, repositories, min_severity, max_active_runs,
       max_active_per_repo, max_runs_per_day, max_backlog, cooldown_minutes, stale_hours, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'high'),COALESCE($8,2),COALESCE($9,1),COALESCE($10,5),COALESCE($11,50),COALESCE($12,240),COALESCE($13,72),$14)
     ON CONFLICT (source, COALESCE(owner_id, 0)) DO UPDATE SET mode = EXCLUDED.mode, paused = EXCLUDED.paused,
       workflows = EXCLUDED.workflows, repositories = EXCLUDED.repositories, min_severity = EXCLUDED.min_severity,
       max_active_runs = EXCLUDED.max_active_runs, max_active_per_repo = EXCLUDED.max_active_per_repo,
       max_runs_per_day = EXCLUDED.max_runs_per_day, max_backlog = EXCLUDED.max_backlog,
       cooldown_minutes = EXCLUDED.cooldown_minutes, stale_hours = EXCLUDED.stale_hours,
       updated_by = EXCLUDED.updated_by, revision = intake_policies.revision + 1, updated_at = now()
     RETURNING *`,
    [
      input.source,
      input.owner_id ?? null,
      mode,
      input.paused === true,
      [...new Set((input.workflows ?? []).map(String))],
      repos,
      input.min_severity ?? null,
      input.max_active_runs ?? null,
      input.max_active_per_repo ?? null,
      input.max_runs_per_day ?? null,
      input.max_backlog ?? null,
      input.cooldown_minutes ?? null,
      input.stale_hours ?? null,
      by,
    ],
  );
  return row;
}

// ---------------------------------------------------------------- ingest

export interface IntakeEnvelope {
  source: IntakeSource;
  sourceKey: string;
  ownerId: number;
  workItemId?: number | null;
  incidentFingerprint?: string | null;
  /** Hash input of what matters for triage (title, description, status...): a change re-triages a waiting item. */
  revisionOf: unknown;
  severity?: Severity | null;
  environment?: string | null;
  service?: string | null;
  permalink?: string | null;
  observedAt?: Date;
  sourceClosed?: boolean;
  /** Occurrences seen since the previous ingest (incidents); default 1. */
  occurrences?: number;
}

const revisionHash = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(v ?? null))
    .digest("hex")
    .slice(0, 16);

/**
 * Idempotent ingest: one row per (source, owner, source key) however many times or concurrently it is seen. A new
 * revision re-triages a waiting item; a running item keeps running and is flagged; closed at the source while waiting →
 * resolved, while running → flagged for a human check (never overwritten). Nothing is ingested without a policy.
 */
export async function ingest(e: IntakeEnvelope, db: Db = pool) {
  const policy = policyFor(await loadIntakePolicies(db), e.source, e.ownerId);
  if (!policy || policy.mode === "OFF") return null;
  const revision = revisionHash(e.revisionOf);
  const [row] = await q<{ id: number; state: string; inserted: boolean }>(
    db,
    `INSERT INTO intake_items (source, source_key, key_version, owner_id, work_item_id, incident_fingerprint, revision, severity,
       environment, service, permalink, occurrences, first_seen, last_seen, source_closed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13, now()),COALESCE($13, now()),$14)
     ON CONFLICT (source, owner_id, source_key) DO UPDATE SET
       occurrences = intake_items.occurrences + EXCLUDED.occurrences,
       last_seen = GREATEST(intake_items.last_seen, EXCLUDED.last_seen),
       severity = COALESCE(EXCLUDED.severity, intake_items.severity),
       work_item_id = COALESCE(intake_items.work_item_id, EXCLUDED.work_item_id),
       source_closed = EXCLUDED.source_closed,
       state = CASE
         WHEN EXCLUDED.source_closed AND intake_items.state IN ('imported','triaged','eligible','queued','deferred') THEN 'resolved'
         WHEN intake_items.state IN ('triaged','eligible','queued','deferred','rejected','superseded','resolved')
              AND (intake_items.revision <> EXCLUDED.revision OR EXCLUDED.last_seen > intake_items.last_seen) THEN 'imported'
         ELSE intake_items.state END,
       revision = EXCLUDED.revision,
       decision = CASE WHEN intake_items.state IN ('running','starting') AND intake_items.revision <> EXCLUDED.revision
         THEN intake_items.decision || jsonb_build_object('stale_revision', true) ELSE intake_items.decision END,
       updated_at = now()
     RETURNING id, state, (xmax = 0) AS inserted`,
    [
      e.source,
      e.sourceKey,
      e.source === "prod_errors" ? INCIDENT_KEY_VERSION : 1,
      e.ownerId,
      e.workItemId ?? null,
      e.incidentFingerprint ?? null,
      revision,
      e.severity ?? null,
      e.environment ?? null,
      e.service ?? null,
      e.permalink ?? null,
      Math.max(1, e.occurrences ?? 1),
      e.observedAt ?? null,
      e.sourceClosed === true,
    ],
  );
  return row;
}

// ---------------------------------------------------------------- triage + dispatch

/** Bookkeeping kept on an intake item (triage result, shadow proposal, run counters, change flags). */
interface IntakeDecision {
  history?: unknown[];
  runs?: number;
  shadow_at?: string;
  [key: string]: unknown;
}

interface ItemRow {
  id: number;
  source: IntakeSource;
  source_key: string;
  owner_id: number;
  work_item_id: number | null;
  incident_fingerprint: string | null;
  state: string;
  revision: string;
  severity: Severity | null;
  service: string | null;
  environment: string | null;
  workflow: string | null;
  repo_candidate: string | null;
  priority: number;
  occurrences: number;
  last_seen: Date;
  enqueued_at: Date | null;
  next_eligible_at: Date | null;
  decision: IntakeDecision;
  run_id: number | null;
  last_run_finished_at: Date | null;
  source_closed: boolean;
}

async function itemText(it: ItemRow) {
  if (it.work_item_id) {
    const wi = await workItems.get(it.work_item_id);
    if (wi)
      return {
        title: wi.title,
        description: wi.description,
        project: wi.project,
        status: wi.status,
      };
  }
  if (it.incident_fingerprint) {
    const g = await one<{ service: string; signature: string; namespace: string }>(
      pool,
      "SELECT service, signature, namespace FROM prod_error_groups WHERE fingerprint = $1",
      [it.incident_fingerprint],
    );
    if (g)
      return {
        title: `[Prod] ${g.service}: ${g.signature}`,
        description: `${g.namespace} ${g.service} ${g.signature}`,
        project: "",
        status: "open",
      };
  }
  return { title: "", description: "", project: "", status: "open" };
}

/** Decide one item from platform state only (grants, registry, runs, policy, capabilities). */
export async function triageItem(it: ItemRow, policy: IntakePolicy, now = new Date()) {
  const text = await itemText(it);
  const allowed = await allowedRepositoriesForRun(it.owner_id, text.project, "read").catch(
    () => [] as string[],
  );
  const ranked = rankRepositories(
    (await repositories.list()).filter((r) => allowed.includes(r.name)),
    { text: `${text.title}\n${text.description}\n${it.service ?? ""}`, project: text.project },
  );
  const assigned =
    it.source !== "hasaki_work" ||
    !!(await one(
      pool,
      "SELECT 1 FROM inbox WHERE owner_id = $1 AND code = (SELECT code FROM work_items WHERE id = $2)",
      [it.owner_id, it.work_item_id],
    ));
  const active = it.work_item_id
    ? !!(await one(
        pool,
        "SELECT 1 FROM workflow_runs WHERE work_item_id = $1 AND status NOT IN ('COMPLETED','FAILED','CANCELED')",
        [it.work_item_id],
      ))
    : false;
  const autonomy = await freezeAutonomy(pool, "AUTOPILOT", it.owner_id);
  return triage({
    source: it.source,
    policy,
    severity: it.severity,
    lastSeen: new Date(it.last_seen),
    title: text.title,
    description: text.description,
    ranked,
    allowed,
    activeRun: active,
    sourceClosed: it.source_closed || ["done", "archived"].includes(text.status),
    assigned,
    lastRunFinishedAt: it.last_run_finished_at ? new Date(it.last_run_finished_at) : null,
    complexityHighRisk: false,
    capabilities: {
      isolation: await isolationEnforced(),
      autonomyAutopilot: autonomy.mode === "AUTOPILOT" && !autonomy.shadow,
    },
    now,
  });
}

const history = (prev: IntakeDecision, entry: Record<string, unknown>) =>
  [...((prev?.history as unknown[]) ?? []), entry].slice(-20);

/** A source closed or changed while its run is active: a human checks it (once); intake never overwrites the run. */
async function flagRunningChanges() {
  const rows = await q<{ id: number; run_id: number; source_closed: boolean }>(
    pool,
    `UPDATE intake_items SET decision = decision || '{"change_notified": true}'::jsonb, updated_at = now()
      WHERE state = 'running' AND (source_closed OR (decision->>'stale_revision') = 'true')
        AND (decision->>'change_notified') IS DISTINCT FROM 'true'
      RETURNING id, run_id, source_closed`,
  );
  for (const r of rows)
    await notify(
      `⚠️ Intake item #${r.id}: the source was ${r.source_closed ? "closed" : "updated"} while run #${r.run_id} is active — check whether to stop or re-plan it`,
      `/runs/${r.run_id}`,
    ).catch(() => {});
}

async function finishRunningItems() {
  const rows = await q<{ id: number; status: string; finished_at: Date | null; run_id: number }>(
    pool,
    `SELECT i.id, r.status, r.finished_at, i.run_id FROM intake_items i JOIN workflow_runs r ON r.id = i.run_id
      WHERE i.state = 'running' AND r.status IN ('COMPLETED','FAILED','CANCELED')`,
  );
  for (const r of rows)
    await q(
      pool,
      `UPDATE intake_items SET state = 'triaged', last_run_finished_at = COALESCE($2, now()), reason = $3,
         decision = decision || jsonb_build_object('last_run', $4::jsonb), updated_at = now() WHERE id = $1 AND state = 'running'`,
      [
        r.id,
        r.finished_at,
        `run #${r.run_id} ${r.status}`,
        json({ run_id: r.run_id, status: r.status }),
      ],
    );
}

export interface DispatchReport {
  triaged: number;
  started: number[];
  shadow: number[];
  deferred: number;
  capped: number;
}

/**
 * One dispatch pass (called from the scheduler's reconcile loop; concurrent passes are safe): re-triage due items,
 * then start eligible ones in priority order within the policy caps. Starting is idempotent at the database
 * (workflow_runs.inputs.intake_key is unique): two dispatchers or a restart can never start the same item twice.
 */
export async function dispatchIntake(now = new Date()): Promise<DispatchReport> {
  const report: DispatchReport = { triaged: 0, started: [], shadow: [], deferred: 0, capped: 0 };
  const policies = await loadIntakePolicies();
  if (!policies.some((p) => p.mode !== "OFF")) return report;
  await finishRunningItems();
  await flagRunningChanges();
  // Re-triage waiting items (bounded per pass).
  const due = await q<ItemRow>(
    pool,
    `SELECT * FROM intake_items WHERE state IN ('imported','triaged','deferred','starting')
       AND (next_eligible_at IS NULL OR next_eligible_at <= $1) ORDER BY updated_at LIMIT 200`,
    [now],
  );
  for (const it of due) {
    const policy = policyFor(policies, it.source, it.owner_id);
    if (!policy || policy.mode === "OFF") continue;
    if (it.state === "starting") {
      // A crash between claim and start: adopt the run if it exists, else back to triage.
      const run = await one<{ id: number }>(
        pool,
        "SELECT id FROM workflow_runs WHERE inputs->>'intake_item_id' = $1 ORDER BY id DESC LIMIT 1",
        [String(it.id)],
      );
      await q(
        pool,
        `UPDATE intake_items SET state = $2, run_id = COALESCE($3, run_id), updated_at = now() WHERE id = $1 AND state = 'starting'`,
        [it.id, run ? "running" : "imported", run?.id ?? null],
      );
      continue;
    }
    const d = await triageItem(it, policy, now);
    report.triaged++;
    if (d.state === "deferred") report.deferred++;
    await q(
      pool,
      `UPDATE intake_items SET state = $2, reason = $3, workflow = $4, repo_candidate = $5, policy_revision = $6,
         next_eligible_at = $7, enqueued_at = CASE WHEN $2 = 'eligible' THEN COALESCE(enqueued_at, now()) ELSE enqueued_at END,
         decision = decision || jsonb_build_object('triage', $8::jsonb, 'history', $9::jsonb), updated_at = now()
       WHERE id = $1 AND revision = $10`,
      [
        it.id,
        d.state,
        d.reasons.join("; "),
        d.workflow,
        d.repo,
        policy.revision,
        d.state === "deferred" ? new Date(now.getTime() + 30 * 60_000) : null,
        json(d),
        json(
          history(it.decision, {
            at: now.toISOString(),
            state: d.state,
            reasons: d.reasons,
            policy_revision: policy.revision,
          }),
        ),
        it.revision,
      ],
    );
  }
  // Start eligible items, best first, within caps.
  const eligible = await q<ItemRow>(
    pool,
    "SELECT * FROM intake_items WHERE state = 'eligible' LIMIT 500",
  );
  eligible.sort(
    (a, b) =>
      effectivePriority(
        { severity: b.severity, occurrences: b.occurrences, enqueuedAt: b.enqueued_at },
        now,
      ) -
      effectivePriority(
        { severity: a.severity, occurrences: a.occurrences, enqueuedAt: a.enqueued_at },
        now,
      ),
  );
  for (const it of eligible) {
    const policy = policyFor(policies, it.source, it.owner_id);
    if (!policy || policy.mode === "OFF") continue;
    if (policy.mode === "SHADOW" || policy.paused) {
      if (!it.decision?.shadow_at) {
        await q(
          pool,
          "UPDATE intake_items SET decision = decision || jsonb_build_object('shadow_at', $2::text, 'would_start', $3::jsonb), updated_at = now() WHERE id = $1",
          [
            it.id,
            now.toISOString(),
            json({ workflow: it.workflow, repo: it.repo_candidate, paused: policy.paused }),
          ],
        );
        report.shadow.push(it.id);
      }
      continue;
    }
    const capped = await capReason(policy, it);
    if (capped) {
      report.capped++;
      await q(
        pool,
        "UPDATE intake_items SET reason = $2, updated_at = now() WHERE id = $1 AND state = 'eligible'",
        [it.id, capped],
      );
      continue;
    }
    const run = await startEligible(it, policy, now);
    if (run) report.started.push(run);
  }
  return report;
}

/** Caps of the item's policy, counted from the database (restart-safe): active runs, per repo, per day, backlog. */
async function capReason(p: IntakePolicy, it: ItemRow) {
  const scope = p.owner_id == null ? "" : " AND owner_id = $2";
  const params = p.owner_id == null ? [p.source] : [p.source, p.owner_id];
  const [{ active, today }] = await q<{ active: number; today: number }>(
    pool,
    `SELECT count(*) FILTER (WHERE state IN ('starting','running'))::int AS active,
            count(*) FILTER (WHERE (decision->>'started_at')::timestamptz > now() - interval '1 day')::int AS today
       FROM intake_items WHERE source = $1${scope}`,
    params,
  );
  if (active >= p.max_active_runs) return `CAP_ACTIVE_RUNS ${active}/${p.max_active_runs}`;
  if (today >= p.max_runs_per_day) return `CAP_RUNS_PER_DAY ${today}/${p.max_runs_per_day}`;
  if (it.repo_candidate) {
    const [{ n }] = await q<{ n: number }>(
      pool,
      "SELECT count(*)::int AS n FROM intake_items WHERE state IN ('starting','running') AND repo_candidate = $1",
      [it.repo_candidate],
    );
    if (n >= p.max_active_per_repo)
      return `CAP_REPOSITORY ${it.repo_candidate} ${n}/${p.max_active_per_repo}`;
  }
  return null;
}

async function workItemForIncident(it: ItemRow) {
  if (it.work_item_id) return it.work_item_id;
  const g = await one<{
    fingerprint: string;
    service: string;
    signature: string;
    namespace: string;
    work_item_id: number | null;
  }>(
    pool,
    "SELECT fingerprint, service, signature, namespace, work_item_id FROM prod_error_groups WHERE fingerprint = $1",
    [it.incident_fingerprint],
  );
  if (!g) return null;
  const code = `INC-${g.fingerprint.slice(0, 12)}`;
  const wi =
    (await workItems.byCode(code, it.owner_id)) ??
    (await workItems.createManual({
      code,
      title: `[Prod] ${g.service}: ${g.signature}`.slice(0, 160),
      description: `Production incident ${g.namespace}/${g.service} (fingerprint ${g.fingerprint}); read-only investigation started by intake.`,
      ownerId: it.owner_id,
    }));
  await q(
    pool,
    "UPDATE prod_error_groups SET work_item_id = COALESCE(work_item_id, $2) WHERE fingerprint = $1",
    [g.fingerprint, wi.id],
  );
  await q(pool, "UPDATE intake_items SET work_item_id = $2 WHERE id = $1", [it.id, wi.id]);
  return wi.id;
}

async function startEligible(it: ItemRow, p: IntakePolicy, now: Date) {
  const claimed = await one<{ id: number }>(
    pool,
    "UPDATE intake_items SET state = 'starting', updated_at = now() WHERE id = $1 AND state = 'eligible' AND revision = $2 RETURNING id",
    [it.id, it.revision],
  );
  if (!claimed) return null;
  if (it.work_item_id && (await activeRunForWorkItem(it.work_item_id))) {
    await q(
      pool,
      "UPDATE intake_items SET state = 'superseded', reason = 'ACTIVE_RUN_EXISTS', updated_at = now() WHERE id = $1",
      [it.id],
    );
    return null;
  }
  const runs = Number(it.decision?.runs ?? 0);
  const key = `intake:${it.id}:${it.revision}:p${p.revision}:${it.workflow}:${runs}`;
  try {
    const workItemId = await workItemForIncident(it);
    const run = await startRun({
      definitionKey: String(it.workflow),
      workItemId,
      ownerId: it.owner_id,
      repositories: it.repo_candidate ? [it.repo_candidate] : undefined,
      inputs: {
        intake_key: key,
        intake_item_id: String(it.id),
        ...(it.source === "prod_errors" ? { environment: "production" } : {}),
      },
    });
    await q(
      pool,
      `UPDATE intake_items SET state = 'running', run_id = $2, reason = $3,
         decision = decision || jsonb_build_object('runs', $4::int, 'started_at', $5::text, 'intake_key', $6::text), updated_at = now()
       WHERE id = $1`,
      [it.id, run.id, `started ${it.workflow} (run #${run.id})`, runs + 1, now.toISOString(), key],
    );
    await notify(
      `🤖 Intake: ${it.workflow} started for ${it.source} item #${it.id} (run #${run.id})`,
      `/runs/${run.id}`,
    ).catch(() => {});
    return Number(run.id);
  } catch (e) {
    const msg = (e as Error).message;
    const duplicate = /intake_key|duplicate key/i.test(msg);
    const existing = duplicate
      ? await one<{ id: number }>(
          pool,
          "SELECT id FROM workflow_runs WHERE inputs->>'intake_key' = $1",
          [key],
        )
      : null;
    await q(
      pool,
      `UPDATE intake_items SET state = $2, run_id = COALESCE($3, run_id), reason = $4, next_eligible_at = $5, updated_at = now() WHERE id = $1`,
      [
        it.id,
        existing ? "running" : "deferred",
        existing?.id ?? null,
        existing ? `adopted run #${existing.id}` : `start failed: ${msg.slice(0, 300)}`,
        existing ? null : new Date(now.getTime() + 30 * 60_000),
      ],
    );
    return null;
  }
}

/** Items visible to the actor: their own, or every item for an admin. Source payloads are not returned. */
export function listIntakeItems(opts: {
  ownerId?: number;
  all?: boolean;
  state?: string;
  source?: string;
}) {
  return q(
    pool,
    `SELECT id, source, owner_id, work_item_id, incident_fingerprint, state, severity, environment, service, repo_candidate,
            workflow, occurrences, first_seen, last_seen, next_eligible_at, reason, decision->'triage' AS triage,
            decision->'would_start' AS would_start, decision->'stale_revision' AS stale_revision, run_id, permalink, updated_at
       FROM intake_items
      WHERE ($1::bigint IS NULL OR owner_id = $1) AND ($2::text IS NULL OR state = $2) AND ($3::text IS NULL OR source = $3)
      ORDER BY updated_at DESC LIMIT 300`,
    [opts.all ? null : (opts.ownerId ?? -1), opts.state ?? null, opts.source ?? null],
  );
}

/** Re-triage now (an owner's retry), never a forced start. */
export async function retriageItem(id: number, ownerId: number | null) {
  const row = await one<{ id: number }>(
    pool,
    `UPDATE intake_items SET state = 'imported', next_eligible_at = NULL, updated_at = now()
      WHERE id = $1 AND ($2::bigint IS NULL OR owner_id = $2) AND state IN ('deferred','rejected','superseded','triaged') RETURNING id`,
    [id, ownerId],
  );
  return !!row;
}

// ---------------------------------------------------------------- source adapters

/** Production incidents of one scan → intake (one envelope per group, bounded; rows were grouped by the scan). */
export async function ingestProdErrorGroups(limit = 200) {
  const policies = await loadIntakePolicies();
  const policy = policies.find((p) => p.source === "prod_errors" && p.mode !== "OFF");
  if (!policy?.owner_id) return 0;
  const groups = await q<{
    fingerprint: string;
    namespace: string;
    service: string;
    level: string;
    caller: string;
    signature: string;
    sample: string;
    detail: { err?: string } | null;
    severity: Severity;
    today_count: number;
    last_at: Date | null;
    status: string;
  }>(
    pool,
    `SELECT fingerprint, namespace, service, level, caller, signature, sample, detail, severity, today_count, last_at, status
       FROM prod_error_groups WHERE day = (SELECT max(day) FROM prod_error_groups) ORDER BY score DESC LIMIT $1`,
    [limit],
  );
  let n = 0;
  await withTx(async (c) => {
    for (const g of groups) {
      const r = await ingest(
        {
          source: "prod_errors",
          sourceKey: incidentKey({ ...g, err: g.detail?.err }),
          ownerId: Number(policy.owner_id),
          incidentFingerprint: g.fingerprint,
          revisionOf: [g.signature, g.severity, g.status],
          severity: g.severity,
          environment: g.namespace,
          service: g.service,
          observedAt: g.last_at ?? undefined,
          sourceClosed: g.status === "ignored",
          occurrences: 1,
        },
        c,
      );
      if (r) n++;
    }
  });
  return n;
}

/** A Hasaki Work item (imported or refreshed) → intake for its owner, when a policy exists. */
export async function ingestWorkItem(item: {
  id: number;
  code: string;
  owner_id: number | null;
  title: string;
  description: string;
  status: string;
  source: string;
}) {
  if (item.source !== "hasaki_work" || item.owner_id == null) return null;
  return ingest({
    source: "hasaki_work",
    sourceKey: item.code,
    ownerId: Number(item.owner_id),
    workItemId: item.id,
    revisionOf: [item.title, item.description, item.status],
    sourceClosed: ["done", "archived"].includes(item.status),
  });
}
