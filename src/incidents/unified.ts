/**
 * Unified Incident Investigation — one workspace per production incident and owner, linking the runs of the existing
 * workflows (runtime RCA `production-incident-investigation`, `production-bug-hunt`, fix `bug-investigation`) and
 * reconciling what they persisted into one RCA. No new orchestrator: runs are started through the existing services
 * (startRun / startBugHunt / createFixTask / startFixFromInvestigation) behind their existing gates, and evidence is
 * read by reference from the runs' own records. Reconciliation is deterministic (reconcile.ts) — zero LLM calls.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pool, q, one, type Db } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import { audit, type Actor } from "../authz/access.ts";
import { startRun, EngineError } from "../workflow/engine.ts";
import { describeGroup, type GroupRow } from "../prodErrors/scan.ts";
import { startBugHunt, createFixTask, huntStatus, BUG_HUNT_WORKFLOW } from "../bugHunt/service.ts";
import { startFixFromInvestigation } from "../investigation/service.ts";
import { readableOf } from "../impact/analyze.ts";
import { checkoutOf, baseCommit } from "../impact/index.ts";
import { repositoryBaseBranch } from "../repos/service.ts";
import type { RoundState } from "../investigation/rounds.ts";
import {
  reconcile,
  inputsHash,
  causeKey,
  type EvidenceItem,
  type SourceRun,
  type CodeLocation,
  type Reconciliation,
} from "./reconcile.ts";

const exec = promisify(execFile);
export const RUNTIME_WORKFLOW = "production-incident-investigation";
export const FIX_WORKFLOW = "bug-investigation";
/** Version of the evidence-validity rules: a change invalidates every cached RCA (it is part of the inputs hash). */
export const VERIFICATION_CONTRACT = "unified-rca/v1";
const ACTIVE = ["PENDING", "RUNNING", "PAUSED", "WAITING"];
const MAX_FRESHNESS_CHECKS = 40;
const MAX_DIGEST_LINES = 8;
const FP = /^[0-9a-f]{20}$/;

const lockKey = (s: string) => createHash("sha256").update(s).digest().readBigInt64BE(0).toString();

async function groupOf(fp: string) {
  if (!FP.test(fp)) throw new HttpError(400, "invalid fingerprint");
  const g = await one<GroupRow>(pool, "SELECT *, day::text AS day FROM prod_error_groups WHERE fingerprint=$1", [fp]);
  if (!g) throw new HttpError(404, "incident not found");
  return g;
}

/** The (incident, owner) workspace, created on first use. */
async function workspace(db: Db, fp: string, ownerId: number) {
  const r = await one<{ id: number }>(
    db,
    `INSERT INTO incident_investigations (fingerprint, owner_id) VALUES ($1,$2)
     ON CONFLICT (fingerprint, owner_id) DO UPDATE SET updated_at = incident_investigations.updated_at RETURNING id`,
    [fp, ownerId],
  );
  return Number(r!.id);
}

async function link(db: Db, investigationId: number, runId: number, kind: "runtime" | "bug_hunt" | "fix", source: string) {
  await q(
    db,
    `INSERT INTO incident_investigation_runs (investigation_id, run_id, kind, link_source) VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING`,
    [investigationId, runId, kind, source],
  );
}

/**
 * Link the owner's runs that belong to this incident, discovered from the runs' own records: hunts (bug_hunts row),
 * runtime investigations started for the fingerprint, and fix runs started from either (or from the incident's work
 * item). Only runs OWNED by the workspace owner are ever linked.
 */
async function discover(investigationId: number, fp: string, ownerId: number) {
  await q(
    pool,
    `INSERT INTO incident_investigation_runs (investigation_id, run_id, kind, link_source)
     SELECT $1::bigint, h.run_id, 'bug_hunt', 'bug_hunts' FROM bug_hunts h JOIN workflow_runs r ON r.id = h.run_id
      WHERE h.fingerprint = $2::text AND h.requested_by = $3::bigint AND r.owner_id = $3::bigint
     UNION ALL
     SELECT $1::bigint, r.id, 'runtime', 'inputs.fingerprint' FROM workflow_runs r
      WHERE r.definition_key = $4 AND r.owner_id = $3 AND r.inputs->>'fingerprint' = $2
     ON CONFLICT DO NOTHING`,
    [investigationId, fp, ownerId, RUNTIME_WORKFLOW],
  );
  await q(
    pool,
    `INSERT INTO incident_investigation_runs (investigation_id, run_id, kind, link_source)
     SELECT $1::bigint, r.id, 'fix', CASE WHEN r.inputs ? 'bug_hunt_id' THEN 'inputs.bug_hunt_id'
                                  WHEN r.inputs ? 'investigation_run_id' THEN 'inputs.investigation_run_id'
                                  ELSE 'work_item' END
       FROM workflow_runs r
      WHERE r.definition_key = $4 AND r.owner_id = $3 AND (
            r.inputs->>'bug_hunt_id' IN (SELECT h.id::text FROM bug_hunts h WHERE h.fingerprint = $2 AND h.requested_by = $3)
         OR r.inputs->>'investigation_run_id' IN (SELECT l.run_id::text FROM incident_investigation_runs l WHERE l.investigation_id = $1 AND l.kind = 'runtime')
         OR r.work_item_id = (SELECT g.work_item_id FROM prod_error_groups g WHERE g.fingerprint = $2))
     ON CONFLICT DO NOTHING`,
    [investigationId, fp, ownerId, FIX_WORKFLOW],
  );
}

// ---------------------------------------------------------------- evidence (by reference) and validity

interface LinkedRun {
  run_id: number;
  kind: "runtime" | "bug_hunt" | "fix";
  link_source: string;
  linked_at: string;
  status: string;
  owner_id: number;
  definition_key: string;
  title: string;
  created_at: string;
  finished_at: string | null;
  inputs: Record<string, unknown> | null;
  work_item_id: number | null;
}

const parseLocation = (s: string | null | undefined): CodeLocation | null => {
  const m = /^([\w.-]+):([\w./-]+):(\d+)$/.exec(String(s ?? "").trim());
  return m ? { repository: m[1], file: m[2], line_start: Number(m[3]), line_end: Number(m[3]) } : null;
};

/** Bounded freshness: has the cited file changed between the evidence commit and the repository's current base? */
function freshness() {
  const cache = new Map<string, Promise<string | null>>();
  let checks = 0;
  const base = (repo: string) => {
    if (!cache.has(repo))
      cache.set(
        repo,
        (async () => {
          const path = await checkoutOf(repo);
          return path ? baseCommit(path, await repositoryBaseBranch(repo)) : null;
        })().catch(() => null),
      );
    return cache.get(repo)!;
  };
  return async (loc: CodeLocation, commit: string | null): Promise<{ stale: boolean; base: string | null; note?: string }> => {
    const head = await base(loc.repository);
    if (!commit || !head) return { stale: false, base: head, note: "freshness not checked (no commit or checkout)" };
    if (head.startsWith(commit) || commit.startsWith(head)) return { stale: false, base: head };
    if (++checks > MAX_FRESHNESS_CHECKS) return { stale: false, base: head, note: "freshness check budget exhausted" };
    const path = await checkoutOf(loc.repository);
    // exit 0: unchanged; 1: changed; anything else (unknown commit): cannot tell → not claimed fresh either way.
    const r = await exec("git", ["-C", path!, "diff", "--quiet", commit, head, "--", loc.file], { timeout: 10_000 }).then(
      () => 0,
      (e: { code?: number }) => (typeof e.code === "number" ? e.code : 2),
    );
    if (r === 1) return { stale: true, base: head };
    return r === 0 ? { stale: false, base: head } : { stale: false, base: head, note: "evidence commit not in the checkout" };
  };
}

async function collect(ownerId: number, runs: LinkedRun[], readable: Set<string>) {
  const items: EvidenceItem[] = [];
  const sources: SourceRun[] = [];
  const fresh = freshness();
  const revisions: Record<string, string | null> = {};
  const check = async (i: EvidenceItem) => {
    if (i.location && !readable.has(i.location.repository)) {
      i.valid = false;
      i.invalid_reason = "repository not accessible to the workspace owner";
      return;
    }
    if (i.location) {
      const f = await fresh(i.location, i.commit);
      revisions[i.location.repository] = f.base;
      if (f.stale) i.stale = true;
    }
  };
  for (const r of runs) {
    // Defense in depth: a link to another user's run is never read (and is reported, not silently dropped).
    if (Number(r.owner_id) !== ownerId) {
      items.push({
        ref: `run:${r.run_id}`, source: r.kind === "bug_hunt" ? "bug_hunt" : "runtime", run_id: r.run_id, kind: "runtime_finding",
        statement: "", location: null, commit: null, refs: [], valid: false, invalid_reason: "run owned by another user",
      });
      continue;
    }
    if (r.kind === "bug_hunt") {
      const h = await one<{ id: number; report: { partial?: boolean } | null; revisions: Record<string, string> | null }>(
        pool, "SELECT id, report, revisions FROM bug_hunts WHERE run_id=$1 AND requested_by=$2", [r.run_id, ownerId]);
      const steps = await q<{ key: string; status: string }>(pool, "SELECT key, status FROM workflow_steps WHERE run_id=$1", [r.run_id]);
      const status = huntStatus(r.status, steps, h?.report ?? null);
      const rows = h
        ? await q<{ id: number; repository: string; commit: string; file_path: string; function: string; line_start: number; line_end: number;
            category: string; bug_verification_status: EvidenceItem["bug_verification"]; incident_causality_status: EvidenceItem["causality"];
            basis: string; finding: Record<string, unknown> }>(
            pool, "SELECT * FROM bug_hunt_findings WHERE hunt_id=$1 ORDER BY id", [h.id])
        : [];
      for (const f of rows) {
        const i: EvidenceItem = {
          ref: `bug_hunt:${h!.id}:finding:${f.id}`,
          source: "bug_hunt",
          run_id: r.run_id,
          kind: "code_defect",
          statement: `${f.category}: ${String(f.finding.hypothesis ?? f.finding.actual ?? "").slice(0, 300)}`,
          location: { repository: f.repository, file: f.file_path, line_start: f.line_start, line_end: f.line_end, function: f.function },
          commit: f.commit,
          bug_verification: f.bug_verification_status,
          causality: f.incident_causality_status,
          refs: [f.basis].filter(Boolean),
          target: { hunt_id: Number(h!.id), finding_id: Number(f.id) },
          valid: true,
        };
        await check(i);
        items.push(i);
      }
      sources.push({ run_id: r.run_id, kind: "bug_hunt", run_status: r.status, outcome: status, missing: [] });
    } else if (r.kind === "runtime") {
      const out = (
        await one<{ output: Record<string, unknown> | null }>(
          pool,
          `SELECT output FROM workflow_steps WHERE run_id=$1 AND config->>'action'='investigation_report' AND status='COMPLETED'
            ORDER BY position DESC LIMIT 1`,
          [r.run_id],
        )
      )?.output;
      const round = out?.round as RoundState | undefined;
      const deployed = new Map((round?.deployed ?? []).map((d) => [d.service, d.commit]));
      for (const h of round?.hypotheses ?? []) {
        const i: EvidenceItem = {
          ref: `run:${r.run_id}:hypothesis:${h.id}`,
          source: "runtime",
          run_id: r.run_id,
          kind: "runtime_hypothesis",
          statement: h.statement,
          location: parseLocation(h.code_location),
          commit: (h.service && deployed.get(h.service)) || null,
          hypothesis_status: h.status,
          hypothesis_kind: h.kind,
          run_outcome: round?.outcome,
          refs: [...h.supporting_refs, ...h.contradicting_refs.map((x) => `¬${x}`)],
          target: { run_id: r.run_id },
          valid: true,
        };
        await check(i);
        items.push(i);
      }
      for (const [n, f] of ((out?.findings ?? []) as Array<{ statement: string; classification: string; evidence_refs: string[]; code_location?: string }>)
        .slice(0, 30)
        .entries())
        items.push({
          ref: `run:${r.run_id}:finding:${n}`, source: "runtime", run_id: r.run_id, kind: "runtime_finding",
          statement: `[${f.classification}] ${f.statement}`, location: parseLocation(f.code_location), commit: null,
          refs: f.evidence_refs ?? [], valid: true,
        });
      const impact = round
        ? round.impact.objects.map((o) => `${o.field}: ${o.lower_bound ? "≥ " : ""}${o.distinct} (${round.impact.failure_events} failure log lines)`)
        : [];
      sources.push({
        run_id: r.run_id, kind: "runtime", run_status: r.status,
        outcome: round?.outcome ?? (out ? String(out.status ?? "") : null),
        missing: (round?.missing ?? []).map((m) => `${m.objective}: ${m.needed}`),
        impact,
      });
    } else {
      sources.push({ run_id: r.run_id, kind: "fix", run_status: r.status, outcome: null, missing: [] });
    }
  }
  return { items, sources, revisions };
}

/** Which cause each existing fix run addresses (from its own inputs), so a second fix is never started for it. */
async function fixCauses(investigationId: number, fixRuns: LinkedRun[], items: EvidenceItem[]) {
  const recorded = new Map(
    (await q<{ run_id: number | null; cause_key: string }>(pool, "SELECT run_id, cause_key FROM incident_fix_tasks WHERE investigation_id=$1", [investigationId]))
      .filter((r) => r.run_id != null)
      .map((r) => [Number(r.run_id), r.cause_key]),
  );
  return fixRuns.map((r) => {
    let key = recorded.get(r.run_id) ?? null;
    const finding = r.inputs?.bug_hunt_finding_id;
    if (!key && finding != null) {
      const i = items.find((x) => x.target?.finding_id === Number(finding));
      if (i) key = causeKey(i.location, i.statement);
    }
    return { run_id: r.run_id, cause_key: key };
  });
}

// ---------------------------------------------------------------- metrics

async function metricsOf(runIds: number[]) {
  if (!runIds.length) return { runs: {} as Record<number, RunMetrics>, total: emptyMetrics() };
  const rows = await q<RunMetrics & { run_id: number }>(
    pool,
    `SELECT t.run_id,
            count(*) FILTER (WHERE t.provider IS NOT NULL)::int AS llm_attempts,
            COALESCE(sum((a.metrics->>'turns')::double precision), 0)::double precision AS turns,
            COALESCE(sum(t.input_tokens), 0)::double precision AS input_tokens,
            COALESCE(sum(t.output_tokens), 0)::double precision AS output_tokens,
            COALESCE(sum(t.cache_read_tokens), 0)::double precision AS cache_read_tokens,
            sum(t.reported_cost_usd)::double precision AS cost_usd,
            CASE WHEN bool_and(t.cost_availability = 'reported') FILTER (WHERE t.provider IS NOT NULL) IS NOT FALSE
                 AND count(t.reported_cost_usd) > 0 THEN 'reported'
                 WHEN count(t.reported_cost_usd) > 0 THEN 'partial' ELSE 'unavailable' END AS cost_availability,
            COALESCE(sum(t.wall_duration_ms), 0)::double precision AS attempt_ms
       FROM execution_attempt_telemetry t JOIN workflow_step_attempts a ON a.id = t.attempt_id
      WHERE t.run_id = ANY($1) GROUP BY t.run_id`,
    [runIds],
  );
  const lat = await q<{ id: number; ms: number | null }>(
    pool,
    "SELECT id, (extract(epoch FROM (COALESCE(finished_at, now()) - created_at)) * 1000)::double precision AS ms FROM workflow_runs WHERE id = ANY($1)",
    [runIds],
  );
  const runs: Record<number, RunMetrics> = {};
  for (const id of runIds) {
    const m = rows.find((r) => Number(r.run_id) === id);
    runs[id] = { ...(m ? { ...m, run_id: undefined } : emptyMetrics()), latency_ms: lat.find((l) => Number(l.id) === id)?.ms ?? null };
    delete (runs[id] as { run_id?: unknown }).run_id;
  }
  const all = Object.values(runs);
  const total = all.reduce<RunMetrics>(
    (a, m) => ({
      llm_attempts: a.llm_attempts + m.llm_attempts,
      turns: a.turns + m.turns,
      input_tokens: a.input_tokens + m.input_tokens,
      output_tokens: a.output_tokens + m.output_tokens,
      cache_read_tokens: a.cache_read_tokens + m.cache_read_tokens,
      cost_usd: m.cost_usd == null ? a.cost_usd : (a.cost_usd ?? 0) + m.cost_usd,
      cost_availability: a.cost_availability === m.cost_availability ? a.cost_availability : "partial",
      attempt_ms: a.attempt_ms + m.attempt_ms,
      latency_ms: Math.max(a.latency_ms ?? 0, m.latency_ms ?? 0),
    }),
    { ...emptyMetrics(), cost_availability: all[0]?.cost_availability ?? "unavailable" },
  );
  return { runs, total };
}
interface RunMetrics {
  llm_attempts: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number | null;
  cost_availability: string;
  attempt_ms: number;
  latency_ms?: number | null;
}
const emptyMetrics = (): RunMetrics => ({
  llm_attempts: 0, turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: null,
  cost_availability: "unavailable", attempt_ms: 0, latency_ms: null,
});

// ---------------------------------------------------------------- the workbench read model

/** Resolve whose workspace is read: the actor's own; another owner's only for an admin in support mode (audited). */
async function ownerFor(actor: Actor, fp: string, opts: { support?: boolean; ownerId?: number }) {
  if (opts.ownerId == null || opts.ownerId === actor.id) return actor.id;
  if (!(opts.support && actor.role === "admin")) throw new HttpError(404, "not found");
  await audit(actor.id, "support.access", "incident_investigation", `${fp}:${opts.ownerId}`);
  return opts.ownerId;
}

export async function getWorkbench(fp: string, actor: Actor, opts: { support?: boolean; ownerId?: number } = {}) {
  const g = await groupOf(fp);
  const ownerId = await ownerFor(actor, fp, opts);
  const investigationId = await workspace(pool, fp, ownerId);
  await discover(investigationId, fp, ownerId);
  const runs = await q<LinkedRun>(
    pool,
    `SELECT l.run_id, l.kind, l.link_source, l.linked_at, r.status, r.owner_id, r.definition_key, r.title, r.created_at,
            r.finished_at, r.inputs, r.work_item_id
       FROM incident_investigation_runs l JOIN workflow_runs r ON r.id = l.run_id
      WHERE l.investigation_id = $1 ORDER BY l.run_id`,
    [investigationId],
  );
  for (const r of runs) r.run_id = Number(r.run_id);
  const readable = new Set(await readableOf(ownerId));
  const { items, sources, revisions } = await collect(ownerId, runs, readable);
  const fixes = await fixCauses(investigationId, runs.filter((r) => r.kind === "fix"), items);
  for (const s of sources) if (s.kind === "fix") s.cause_key = fixes.find((f) => f.run_id === s.run_id)?.cause_key ?? null;
  const rec = reconcile(items, sources);
  // Cache validity: the verification contract, the access scope (owner; per-item validity under the owner's current
  // permissions) and, per evidence item, its source ref, commit, verdicts and freshness against the current revision,
  // plus run states. Unrelated commits or permission changes that alter no item's validity do not mint a version.
  const hash = createHash("sha256")
    .update(JSON.stringify([VERIFICATION_CONTRACT, ownerId, inputsHash(items, sources)]))
    .digest("hex");
  const version = await materialize(investigationId, hash, rec, sources, revisions);
  const versions = await q<{ version: number; status: string; created_at: string }>(
    pool,
    "SELECT version, status, created_at FROM incident_rca_versions WHERE investigation_id=$1 ORDER BY version DESC LIMIT 20",
    [investigationId],
  );
  const metrics = await metricsOf(runs.map((r) => r.run_id));
  const confirmedVersions = versions.filter((v) => v.status === "CONFIRMED").length;
  const latestRun = (k: LinkedRun["kind"]) => runs.filter((r) => r.kind === k).at(-1);
  const progress = async (r: LinkedRun | undefined) => {
    if (!r) return null;
    const steps = await q<{ key: string; name: string; status: string }>(
      pool, "SELECT key, name, status FROM workflow_steps WHERE run_id=$1 ORDER BY position", [r.run_id]);
    return {
      run_id: r.run_id,
      status: r.status,
      active: ACTIVE.includes(r.status),
      created_at: r.created_at,
      finished_at: r.finished_at,
      steps_done: steps.filter((s) => ["COMPLETED", "SKIPPED"].includes(s.status)).length,
      steps_total: steps.length,
      current: steps.find((s) => s.status === "RUNNING")?.name ?? null,
      outcome: sources.find((s) => s.run_id === r.run_id)?.outcome ?? null,
      metrics: metrics.runs[r.run_id] ?? null,
    };
  };
  const hunt = latestRun("bug_hunt");
  return {
    fingerprint: fp,
    investigation_id: investigationId,
    owner_id: ownerId,
    incident: { service: g.service, signature: g.signature, severity: g.severity, last_at: g.last_at },
    rca: version
      ? { ...rec, version: version.version as number | null, created_at: version.created_at as string | null }
      : { ...rec, version: null as number | null, created_at: null as string | null },
    runtime: await progress(latestRun("runtime")),
    bug_hunt: hunt
      ? { ...(await progress(hunt)), hunt_id: (await one<{ id: number }>(pool, "SELECT id FROM bug_hunts WHERE run_id=$1", [hunt.run_id]))?.id ?? null }
      : null,
    runs: runs.map((r) => ({
      run_id: r.run_id, kind: r.kind, status: r.status, title: r.title, link_source: r.link_source,
      cause_key: sources.find((s) => s.run_id === r.run_id)?.cause_key ?? null,
      created_at: r.created_at, finished_at: r.finished_at, metrics: metrics.runs[r.run_id] ?? null,
    })),
    evidence: items.map((i) => ({
      ref: i.ref, source: i.source, run_id: i.run_id, kind: i.kind, statement: i.statement.slice(0, 400), location: i.location,
      commit: i.commit, bug_verification: i.bug_verification ?? null, causality: i.causality ?? null,
      hypothesis_status: i.hypothesis_status ?? null, valid: i.valid, invalid_reason: i.invalid_reason ?? null, stale: !!i.stale,
    })),
    fix_tasks: await q(
      pool,
      `SELECT t.cause_key, t.run_id, t.work_item_id, w.code, r.status, t.created_at FROM incident_fix_tasks t
         LEFT JOIN workflow_runs r ON r.id = t.run_id LEFT JOIN work_items w ON w.id = t.work_item_id
        WHERE t.investigation_id = $1 ORDER BY t.id`,
      [investigationId],
    ),
    versions,
    metrics: {
      ...metrics.total,
      verified_rcas: confirmedVersions,
      cost_per_verified_rca:
        confirmedVersions && metrics.total.cost_usd != null ? metrics.total.cost_usd / confirmedVersions : null,
      reconciliation_llm_calls: 0,
    },
  };
}

/** Persist a new immutable RCA version only when its inputs changed (and something has finished to conclude from). */
async function materialize(
  investigationId: number,
  hash: string,
  rec: Reconciliation,
  sources: SourceRun[],
  revisions: Record<string, string | null>,
) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT id FROM incident_investigations WHERE id=$1 FOR UPDATE", [investigationId]);
    const same = await one<{ version: number; status: string; created_at: string }>(
      c, "SELECT version, status, created_at FROM incident_rca_versions WHERE investigation_id=$1 AND inputs_hash=$2", [investigationId, hash]);
    const terminal = sources.some((s) => s.kind !== "fix" && !ACTIVE.includes(s.run_status));
    if (same || !terminal) {
      await c.query("COMMIT");
      return same ?? null;
    }
    const v = await one<{ version: number; status: string; created_at: string }>(
      c,
      `INSERT INTO incident_rca_versions (investigation_id, version, status, inputs_hash, report)
       VALUES ($1, COALESCE((SELECT max(version) FROM incident_rca_versions WHERE investigation_id=$1), 0) + 1, $2, $3, $4)
       RETURNING version, status, created_at`,
      [investigationId, rec.status, hash, JSON.stringify({ contract: VERIFICATION_CONTRACT, revisions, runs: sources, ...rec })],
    );
    await c.query("UPDATE incident_investigations SET updated_at = now() WHERE id=$1", [investigationId]);
    await c.query("COMMIT");
    return v;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function rcaVersion(fp: string, actor: Actor, version: number, opts: { support?: boolean; ownerId?: number } = {}) {
  const ownerId = await ownerFor(actor, fp, opts);
  const v = await one(
    pool,
    `SELECT v.version, v.status, v.report, v.created_at FROM incident_rca_versions v
       JOIN incident_investigations i ON i.id = v.investigation_id
      WHERE i.fingerprint=$1 AND i.owner_id=$2 AND v.version=$3`,
    [fp, ownerId, version],
  );
  if (!v) throw new HttpError(404, "not found");
  return v;
}

// ---------------------------------------------------------------- actions (user-initiated only)

/**
 * Bounded digest of the OTHER workflow's validated evidence, passed by reference to a new run as an unverified hint
 * (ids it can re-read), never as a transcript. Invalid, stale or other-user evidence is excluded.
 */
function digest(wb: Awaited<ReturnType<typeof getWorkbench>>, source: "bug_hunt" | "runtime") {
  const pick = wb.evidence
    .filter((e) => e.source === source && e.valid && !e.stale && e.kind !== "runtime_finding")
    .filter((e) => (source === "bug_hunt" ? ["CONFIRMED", "SUSPECTED"].includes(e.bug_verification ?? "") : e.hypothesis_status === "SUPPORTED"))
    .slice(0, MAX_DIGEST_LINES);
  if (!pick.length) return { text: "", refs: [] as string[] };
  const lines = pick.map((e) => {
    const loc = e.location ? `${e.location.repository}:${e.location.file}:${e.location.line_start ?? ""}` : "no code location";
    const verdict = source === "bug_hunt" ? `defect ${e.bug_verification}, causality ${e.causality}` : `hypothesis ${e.hypothesis_status}`;
    return `- [${e.ref}] ${loc} — ${verdict}: ${e.statement.slice(0, 200)}`;
  });
  return {
    text: [
      "",
      `Prior evidence from the ${source === "bug_hunt" ? "Bug Hunt" : "Runtime RCA"} of this incident (UNVERIFIED hints for this run — re-check each against your own evidence; do not cite them as proof):`,
      ...lines,
    ].join("\n"),
    refs: pick.map((e) => e.ref),
  };
}

export async function startRuntime(fp: string, actor: Actor, body: { force?: unknown; provider?: unknown } = {}) {
  const g = await groupOf(fp);
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock($1::bigint)", [lockKey(`incident_runtime:${actor.id}:${fp}`)]);
    const investigationId = await workspace(c, fp, actor.id);
    const prior = await one<{ id: number; status: string }>(
      c,
      `SELECT id, status FROM workflow_runs WHERE definition_key=$1 AND owner_id=$2 AND inputs->>'fingerprint'=$3
        AND status <> ALL($4) ORDER BY (status = ANY($5)) DESC, id DESC LIMIT 1`,
      [RUNTIME_WORKFLOW, actor.id, fp, ["FAILED", "CANCELED"], ACTIVE],
    );
    if (prior && ACTIVE.includes(prior.status)) {
      await link(c, investigationId, Number(prior.id), "runtime", "workbench");
      return { created: false, run_id: Number(prior.id) };
    }
    // A completed RCA is reused, never re-run implicitly: a re-run is an explicit, separate (paid) choice.
    if (prior && body.force !== true)
      throw new HttpError(409, `runtime RCA run #${prior.id} already completed for this incident; re-run explicitly to refresh it`);
    const wb = await getWorkbench(fp, actor);
    const d = digest(wb, "bug_hunt");
    let run;
    try {
      run = await startRun({
        definitionKey: RUNTIME_WORKFLOW,
        title: `[Runtime RCA] ${g.service}: ${g.signature}`.slice(0, 160),
        inputs: { request: describeGroup(g) + d.text, environment: "production", fingerprint: fp, prior_evidence: d.refs },
        agentProvider: body.provider ? String(body.provider) : undefined,
        ownerId: actor.id,
      });
    } catch (e) {
      if (e instanceof EngineError) throw new HttpError(e.status ?? 400, e.message);
      throw e;
    }
    await link(c, investigationId, Number(run.id), "runtime", "workbench");
    await audit(actor.id, "prod_errors.incident.runtime.start", "prod_error_group", fp, { run_id: run.id, prior_evidence: d.refs });
    return { created: true, run_id: Number(run.id) };
  } finally {
    await c.query("SELECT pg_advisory_unlock_all()").catch(() => {});
    c.release();
  }
}

export async function startHunt(fp: string, actor: Actor, body: { repositories?: unknown; provider?: unknown; force?: unknown }) {
  await groupOf(fp);
  const repos = Array.isArray(body.repositories) ? [...new Set(body.repositories.map(String))].sort() : [];
  const done = repos.length
    ? await one<{ id: number; run_id: number }>(
        pool,
        `SELECT h.id, h.run_id FROM bug_hunts h JOIN workflow_runs r ON r.id = h.run_id
          WHERE h.fingerprint=$1 AND h.requested_by=$2 AND h.scope_key=$3 AND r.status='COMPLETED' ORDER BY h.id DESC LIMIT 1`,
        [fp, actor.id, repos.join(",")],
      )
    : null;
  if (done && body.force !== true)
    throw new HttpError(409, `bug hunt #${done.id} already completed for these repositories; re-run explicitly to refresh it`);
  const wb = await getWorkbench(fp, actor);
  const d = digest(wb, "runtime");
  const r = await startBugHunt(fp, actor, { repositories: body.repositories, provider: body.provider, context: d.text, prior_evidence: d.refs });
  const investigationId = await workspace(pool, fp, actor.id);
  await link(pool, investigationId, r.run_id, "bug_hunt", "workbench");
  return r;
}

/** Both workflows, only because the user asked for both (never automatic). */
export async function startBoth(fp: string, actor: Actor, body: { repositories?: unknown; provider?: unknown; force?: unknown }) {
  const runtime = await startRuntime(fp, actor, body).catch((e) => ({ error: (e as Error).message, status: (e as HttpError).status ?? 500 }));
  const hunt = await startHunt(fp, actor, body).catch((e) => ({ error: (e as Error).message, status: (e as HttpError).status ?? 500 }));
  return { runtime, bug_hunt: hunt };
}

/**
 * Create the fix task for a reconciled cause, after explicit user confirmation. One fix task per cause per workspace
 * (unique reservation first, so concurrent clicks and both workflows' findings converge on one task). Routed to the
 * existing fix flows; the incident investigation itself stays read-only.
 */
export async function createFix(fp: string, actor: Actor, body: { cause_key?: unknown; confirm?: unknown }) {
  if (body.confirm !== true) throw new HttpError(400, "creating a fix task needs explicit confirmation");
  const key = String(body.cause_key ?? "");
  const wb = await getWorkbench(fp, actor);
  const cause = wb.rca.causes.find((c) => c.key === key);
  if (!cause) throw new HttpError(404, "cause not found");
  if (!cause.code_fixable || !cause.fix_target)
    throw new HttpError(400, "this cause is not an eligible code defect (no verified code location): no code fix task");
  if (cause.level === "unknown" && cause.defect !== "CONFIRMED")
    throw new HttpError(400, "neither the defect nor its causality is established: verify before creating a fix task");
  // A fix already started for this cause (from the hunt UI, the investigation panel or here) is reused.
  const existingFix = wb.runs.find((r) => r.kind === "fix" && r.cause_key === key && !["FAILED", "CANCELED"].includes(r.status));
  const investigationId = wb.investigation_id;
  const reserved = await one<{ id: number }>(
    pool,
    `INSERT INTO incident_fix_tasks (investigation_id, cause_key, source, created_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (investigation_id, cause_key) DO NOTHING RETURNING id`,
    [investigationId, key, JSON.stringify({ target: cause.fix_target, supporting: cause.supporting, rca_version: wb.rca.version }), actor.id],
  );
  if (!reserved) {
    const t = await one<{ run_id: number | null; work_item_id: number | null }>(
      pool, "SELECT run_id, work_item_id FROM incident_fix_tasks WHERE investigation_id=$1 AND cause_key=$2", [investigationId, key]);
    return { created: false, run_id: t?.run_id == null ? null : Number(t.run_id), work_item_id: t?.work_item_id ?? null };
  }
  if (existingFix) {
    await q(pool, "UPDATE incident_fix_tasks SET run_id=$2 WHERE id=$1", [reserved.id, existingFix.run_id]);
    return { created: false, run_id: existingFix.run_id, work_item_id: null };
  }
  try {
    const t = cause.fix_target;
    const r =
      t.finding_id != null && t.hunt_id != null
        ? await createFixTask(t.hunt_id, t.finding_id, actor)
        : await startFixFromInvestigation(Number(t.run_id)).then((x) => ({
            run_id: Number(x.run_id), work_item_id: null as number | null, created: !x.existing,
          }));
    await q(pool, "UPDATE incident_fix_tasks SET run_id=$2, work_item_id=$3 WHERE id=$1", [reserved.id, r.run_id, r.work_item_id ?? null]);
    await link(pool, investigationId, Number(r.run_id), "fix", "workbench");
    await audit(actor.id, "prod_errors.incident.fix_task", "prod_error_group", fp, { cause_key: key, run_id: r.run_id });
    return { created: r.created, run_id: Number(r.run_id), work_item_id: r.work_item_id ?? null };
  } catch (e) {
    await q(pool, "DELETE FROM incident_fix_tasks WHERE id=$1", [reserved.id]);
    if (e instanceof EngineError) throw new HttpError(e.status ?? 400, e.message);
    throw e;
  }
}

export { BUG_HUNT_WORKFLOW };
