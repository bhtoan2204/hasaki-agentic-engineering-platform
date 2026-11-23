import { pool, q, one, withTx, type Db } from "../db/pool.ts";
import { config } from "../config.ts";
import { ingest, loadIntakePolicies, policyFor } from "../workitems/intake.ts";
import { workItems } from "../workitems/service.ts";
import {
  correlate,
  DEFAULT_THRESHOLDS,
  detectFailures,
  detectSeries,
  severityRank,
  type Detection,
  type ErrorSeries,
  type FailureGroup,
  type FindingKind,
  type RadarThresholds,
} from "./detect.ts";

/**
 * Engineering Radar pass: read bounded series from the platform's own tables (data the authorized prod-error scans and
 * workflow runs already stored — no new production query), detect, correlate, upsert deduplicated findings, resolve the
 * quiet ones, feed the Intake Queue under its policy, notify on meaningful changes. Single-flight across instances
 * (advisory lock) and interval-gated; every pass is recorded in radar_scans; every finding change is audited.
 */

const LOCK = 727_101;
const RESOLVE_AFTER_HOURS = 24;
const MAX_EVIDENCE = 20;

type FindingRow = {
  id: number;
  fingerprint: string;
  kinds: string[];
  severity: string;
  status: string;
  occurrences: number;
  notified_severity: string | null;
  evidence: Array<{ ref: string; at: string }>;
  intake_item_id: number | null;
  work_item_id: number | null;
  last_signal_at: string | null;
  resolved_at: string | null;
};

async function auditRadar(db: Db, action: string, id: number, detail: unknown) {
  await q(
    db,
    "INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES(NULL,$1,'radar_finding',$2,$3)",
    [`radar.${action}`, String(id), JSON.stringify(detail)],
  );
}

/** A Db that counts round-trips (radar_scans.queries is measured, not estimated). */
export function counting(db: Db) {
  const counter = { n: 0 };
  const wrapped = {
    query: (...args: unknown[]) => {
      counter.n++;
      return (db.query as (...a: unknown[]) => unknown)(...args);
    },
  } as unknown as Db;
  return { db: wrapped, counter };
}

/**
 * Production error series of the newest successful scan's signatures, as HOURLY counts merged from every scan of the
 * last 8 days (prod_error_observations.hourly — comparable whatever preset or window a scan used; the same hour seen by
 * two scans keeps the larger, more complete count). Versions are remembered in radar_series_state (one statement).
 */
export async function loadErrorSeries(limit = config.radar.maxSeries, db: Db = pool) {
  const latest = await one<{ id: number; window_start: Date | null; started_at: Date }>(
    db,
    "SELECT id, window_start, started_at FROM prod_error_scans WHERE ok ORDER BY id DESC LIMIT 1",
  );
  if (!latest) return { series: [] as ErrorSeries[], latestScan: null };
  const covered = await q<{ day: string }>(
    db,
    `SELECT DISTINCT to_char(d, 'YYYY-MM-DD') AS day FROM prod_error_scans s,
       generate_series(date_trunc('day', COALESCE(s.window_start, s.started_at) AT TIME ZONE 'UTC'),
                       date_trunc('day', COALESCE(s.window_end, s.started_at) AT TIME ZONE 'UTC'), interval '1 day') d
      WHERE s.ok AND s.started_at > now() - interval '9 days'`,
  );
  const coveredDays = covered.map((c) => c.day);
  const rows = await q<{
    fingerprint: string;
    namespace: string;
    service: string;
    level: string;
    signature: string;
    first_seen_at: Date;
    image: string | null;
    version: string | null;
    previous_version: string | null;
    version_changed_at: Date | null;
    reopened_at: Date | null;
    hours: Array<{ hour: string; count: number }> | null;
  }>(
    db,
    `WITH active AS (
       SELECT o.fingerprint FROM prod_error_observations o WHERE o.scan_id = $1 ORDER BY o.event_count DESC LIMIT $2)
     SELECT g.fingerprint, g.namespace, g.service, g.level, g.signature, g.first_seen_at, g.detail->>'image' AS image,
            st.version, st.previous_version, st.version_changed_at,
            (SELECT max(e.created_at) FROM prod_error_lifecycle_events e WHERE e.fingerprint = g.fingerprint AND e.action = 'reopen') AS reopened_at,
            (SELECT json_agg(json_build_object('hour', h.hour, 'count', h.count) ORDER BY h.hour)
               FROM (SELECT (x->>'hour')::timestamptz AS hour, max((x->>'count')::bigint) AS count
                       FROM prod_error_observations o JOIN prod_error_scans s ON s.id = o.scan_id AND s.ok,
                            jsonb_array_elements(o.hourly) x
                      WHERE o.fingerprint = g.fingerprint AND s.started_at > now() - interval '9 days'
                      GROUP BY 1) h) AS hours
       FROM prod_error_groups g JOIN active a ON a.fingerprint = g.fingerprint
       LEFT JOIN radar_series_state st ON st.prod_fingerprint = g.fingerprint
      WHERE g.status <> 'ignored'`,
    [latest.id, limit],
  );
  const recentFrom = new Date(latest.window_start ?? latest.started_at);
  const series: ErrorSeries[] = rows.map((r) => {
    // A version change is remembered for a day so a spike shortly after a deployment is correlated with it.
    const changed =
      r.image && r.version && r.image !== r.version
        ? { version: r.image, previousVersion: r.version }
        : r.version_changed_at && Date.now() - new Date(r.version_changed_at).getTime() < 86_400_000
          ? { version: r.version, previousVersion: r.previous_version }
          : { version: r.image, previousVersion: null };
    return {
      fingerprint: r.fingerprint,
      service: r.service,
      environment: r.namespace,
      level: r.level,
      signature: r.signature,
      firstSeenAt: new Date(r.first_seen_at),
      points: (r.hours ?? []).map((h) => ({ at: new Date(h.hour), count: Number(h.count) })),
      recentFrom,
      latestScanId: Number(latest.id),
      coveredDays,
      reopenedAt: r.reopened_at ? new Date(r.reopened_at) : null,
      ...changed,
    };
  });
  const changedVersions = rows.filter((r) => r.image && r.image !== r.version);
  if (changedVersions.length)
    await q(
      db,
      `INSERT INTO radar_series_state(prod_fingerprint,version)
       SELECT * FROM unnest($1::text[], $2::text[])
       ON CONFLICT(prod_fingerprint) DO UPDATE SET previous_version=radar_series_state.version,version=EXCLUDED.version,
         version_changed_at=CASE WHEN radar_series_state.version IS NULL THEN radar_series_state.version_changed_at ELSE now() END,updated_at=now()`,
      [changedVersions.map((r) => r.fingerprint), changedVersions.map((r) => r.image!)],
    );
  return { series, latestScan: latest };
}

/** Same workflow step failing with the same normalized error across runs, and repeated CI failures per repository. */
export async function loadFailureGroups(db: Db = pool): Promise<FailureGroup[]> {
  const steps = await q<{
    key: string;
    label: string;
    signature: string;
    runs: number[];
    last_at: Date;
  }>(
    db,
    `SELECT r.definition_key || ':' || s.key AS key, r.definition_key || ' / ' || s.key AS label,
            left(regexp_replace(regexp_replace(COALESCE(s.error, ''), '[0-9a-f]{8,}', '#', 'gi'), '[0-9]+', '#', 'g'), 160) AS signature,
            array_agg(DISTINCT r.id) AS runs, max(s.updated_at) AS last_at
       FROM workflow_steps s JOIN workflow_runs r ON r.id = s.run_id
      WHERE s.status = 'FAILED' AND s.updated_at > now() - interval '7 days' AND COALESCE(s.error, '') <> ''
        AND NOT EXISTS (SELECT 1 FROM evaluation_runs e WHERE e.workflow_run_id = r.id)
      GROUP BY 1, 2, 3 HAVING count(DISTINCT r.id) >= 2 ORDER BY count(DISTINCT r.id) DESC LIMIT 50`,
  );
  const ci = await q<{ repo: string; runs: number[]; last_at: Date }>(
    db,
    `SELECT repo, array_agg(DISTINCT id) AS runs, max(updated_at) AS last_at FROM pull_requests
      WHERE lifecycle = 'CI_FAILED' AND updated_at > now() - interval '7 days' GROUP BY repo LIMIT 50`,
  );
  return [
    ...steps.map((s) => ({
      scope: "workflow" as const,
      key: s.key,
      label: s.label,
      signature: s.signature,
      runs: s.runs.map(Number),
      lastAt: new Date(s.last_at),
    })),
    ...ci.map((c) => ({
      scope: "ci" as const,
      key: c.repo,
      label: c.repo,
      signature: "CI_FAILED",
      runs: c.runs.map(Number),
      lastAt: new Date(c.last_at),
    })),
  ];
}

function findingText(f: Detection & { kinds: FindingKind[] }) {
  return {
    title: `[Radar] ${f.service}: ${f.kinds.join(", ")} — ${f.signature}`.slice(0, 160),
    description: [
      `Engineering Radar finding ${f.fingerprint} (${f.kinds.join(", ")}), severity ${f.severity}, confidence ${f.confidence}.`,
      `Service: ${f.service} · environment: ${f.environment}`,
      `Signature: ${f.signature.slice(0, 300)}`,
      `Statistics: ${JSON.stringify(f.stats).slice(0, 400)}`,
      `Evidence: ${f.evidence
        .map((e) => `${e.ref} @ ${e.at}${e.value != null ? ` = ${e.value}` : ""}`)
        .join("; ")
        .slice(0, 800)}`,
      `Proposed workflow: ${f.proposedWorkflow ?? "none (human triage)"}`,
      `Recommended next action: ${f.nextAction}`,
      "Detected deterministically from platform records; the root cause is NOT established.",
    ].join("\n"),
  };
}

export interface RadarReport {
  scanId: number;
  series: number;
  detected: number;
  created: number;
  updated: number;
  resolved: number;
  ingested: number;
  queries: number;
  durationMs: number;
}

/** One radar pass. Returns null when another instance holds the lock. */
export async function radarScan(
  opts: { thresholds?: RadarThresholds; now?: Date } = {},
): Promise<RadarReport | null> {
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const now = opts.now ?? new Date();
  const lockClient = await pool.connect();
  try {
    const got = (await lockClient.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK])).rows[0]
      .ok;
    if (!got) return null;
    const t0 = Date.now();
    const scan = (await one<{ id: number }>(
      pool,
      "INSERT INTO radar_scans DEFAULT VALUES RETURNING id",
    ))!;
    // Every statement of the pass goes through a counting handle: radar_scans.queries is measured.
    const reads = counting(pool);
    const counters = [reads.counter];
    try {
      const { series } = await loadErrorSeries(config.radar.maxSeries, reads.db);
      const failures = await loadFailureGroups(reads.db);
      const detections = [
        ...series.flatMap((s) => detectSeries(s, t, now)),
        ...detectFailures(failures, t),
      ];
      const findings = correlate(detections);
      const r = { created: 0, updated: 0, resolved: 0, ingested: 0 };
      const changed: Array<{
        row: FindingRow;
        finding: (typeof findings)[number];
        isNew: boolean;
        escalated: boolean;
      }> = [];
      for (const f of findings) {
        const res = await withTx(async (tx) => {
          const c = counting(tx);
          counters.push(c.counter);
          const db = c.db;
          const prev = await one<FindingRow>(
            db,
            "SELECT * FROM radar_findings WHERE fingerprint=$1 FOR UPDATE",
            [f.fingerprint],
          );
          if (prev?.status === "suppressed") return null;
          // The same evidence (same newest signal) seen again is not a new occurrence: restarts and repeated passes
          // over unchanged data leave the finding as it is.
          const sameSignal =
            prev?.last_signal_at && new Date(prev.last_signal_at).getTime() >= f.signalAt.getTime();
          if (prev && sameSignal && prev.status === "open") return null;
          const evidence = [
            ...(prev?.evidence ?? []).filter((e) => !f.evidence.some((n) => n.ref === e.ref)),
            ...f.evidence,
          ].slice(-MAX_EVIDENCE);
          const severity =
            prev && severityRank(prev.severity) > severityRank(f.severity) && prev.status === "open"
              ? prev.severity
              : f.severity;
          const row = (await one<FindingRow>(
            db,
            `INSERT INTO radar_findings(fingerprint,kinds,service,environment,signature,severity,confidence,stats,evidence,related,
               prod_fingerprint,proposed_workflow,next_action,last_signal_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             ON CONFLICT(fingerprint) DO UPDATE SET kinds=(SELECT array_agg(DISTINCT k) FROM unnest(radar_findings.kinds || EXCLUDED.kinds) k),
               severity=$6,confidence=EXCLUDED.confidence,stats=EXCLUDED.stats,evidence=EXCLUDED.evidence,related=EXCLUDED.related,
               next_action=EXCLUDED.next_action,last_signal_at=EXCLUDED.last_signal_at,last_detected_at=now(),
               occurrences=radar_findings.occurrences+1,
               status='open',resolved_at=NULL,updated_at=now()
             RETURNING *`,
            [
              f.fingerprint,
              f.kinds,
              f.service,
              f.environment,
              f.signature.slice(0, 500),
              severity,
              f.confidence,
              JSON.stringify(f.stats),
              JSON.stringify(evidence),
              JSON.stringify(f.related),
              f.prodFingerprint ?? null,
              f.proposedWorkflow,
              f.nextAction,
              f.signalAt,
            ],
          ))!;
          const isNew = !prev;
          const reopened = prev?.status === "resolved";
          // A finding that flaps (resolved, then back within days) is not news again.
          const longQuiet =
            reopened &&
            (!prev!.resolved_at ||
              Date.now() - new Date(prev!.resolved_at).getTime() > 3 * 86_400_000);
          await auditRadar(
            db,
            isNew ? "finding.created" : reopened ? "finding.reopened" : "finding.updated",
            row.id,
            {
              kinds: f.kinds,
              severity,
              stats: f.stats,
            },
          );
          return {
            row,
            isNew: isNew || !!longQuiet,
            escalated:
              !!prev && severityRank(severity) > severityRank(prev.notified_severity ?? "low"),
          };
        });
        if (!res) continue;
        if (res.isNew) r.created++;
        else r.updated++;
        changed.push({ ...res, finding: f });
      }
      // Quiet findings resolve on their own; a recurrence reopens them (and counts as recurring next time).
      const quiet = await q<{ id: number }>(
        reads.db,
        `UPDATE radar_findings SET status='resolved',resolved_at=now(),updated_at=now()
          WHERE status='open' AND last_detected_at < now() - make_interval(hours => $1) RETURNING id`,
        [RESOLVE_AFTER_HOURS],
      );
      if (quiet.length)
        await q(
          reads.db,
          `INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail)
           SELECT NULL,'radar.finding.resolved','radar_finding',id::text,$2 FROM unnest($1::bigint[]) id`,
          [quiet.map((x) => x.id), JSON.stringify({ quiet_hours: RESOLVE_AFTER_HOURS })],
        );
      r.resolved = quiet.length;
      r.ingested = await ingestFindings(changed, reads.db);
      await notifyFindings(changed, reads.db);
      const queries = counters.reduce((a, c) => a + c.n, 0);
      const report: RadarReport = {
        scanId: scan.id,
        series: series.length + failures.length,
        detected: detections.length,
        ...r,
        queries,
        durationMs: Date.now() - t0,
      };
      await q(
        pool,
        `UPDATE radar_scans SET finished_at=now(),series=$2,queries=$3,detected=$4,created=$5,updated=$6,resolved=$7,ingested=$8,duration_ms=$9 WHERE id=$1`,
        [
          scan.id,
          report.series,
          report.queries,
          report.detected,
          r.created,
          r.updated,
          r.resolved,
          r.ingested,
          report.durationMs,
        ],
      );
      return report;
    } catch (e) {
      await q(pool, "UPDATE radar_scans SET finished_at=now(),error=$2 WHERE id=$1", [
        scan.id,
        (e as Error).message.slice(0, 500),
      ]);
      throw e;
    }
  } finally {
    // A session lock that could not be released must not return to the pool with the connection.
    const unlockError = await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK]).then(
      () => undefined,
      (e: Error) => e,
    );
    lockClient.release(unlockError);
  }
}

/**
 * Feed new/escalated findings into the Intake Queue (source "radar") under its policy: OFF/no policy = observe only,
 * SHADOW = proposed work items, AUTOPILOT = intake may start an allowlisted READ-ONLY investigation (triage never picks a
 * coding workflow for radar). Bounded per pass so a noisy hour cannot cause an investigation storm.
 */
async function ingestFindings(
  changed: Array<{
    row: FindingRow;
    finding: Detection & { kinds: FindingKind[] };
    isNew: boolean;
    escalated: boolean;
  }>,
  db: Db = pool,
) {
  const policies_ = await loadIntakePolicies(db);
  // Every owner-scoped radar policy that is not OFF gets its own candidates (a source-wide row has no owner to own
  // work items: it only provides defaults through policyFor).
  const policies = policies_;
  const owners = [
    ...new Set(
      policies
        .filter((p) => p.source === "radar" && p.owner_id != null)
        .map((p) => Number(p.owner_id))
        .filter((o) => policyFor(policies, "radar", o)?.mode !== "OFF"),
    ),
  ];
  if (!owners.length) return 0;
  let n = 0;
  // Every finding with a new signal: ingest() creates or updates the candidate (one per source key) and re-triages it.
  const ranked = [...changed].sort(
    (a, b) => severityRank(b.row.severity) - severityRank(a.row.severity),
  );
  for (const ownerId of owners)
    for (const c of ranked.slice(0, config.radar.maxIngestPerScan)) {
      const policy = policyFor(policies, "radar", ownerId)!;
      const text = findingText(c.finding);
      const code = `RADAR-${c.row.fingerprint.slice(0, 12)}`;
      const wi =
        (await workItems.byCode(code, ownerId)) ??
        (await workItems.createManual({
          code,
          title: text.title,
          description: text.description,
          ownerId,
        }));
      if (wi.description !== text.description)
        await (
          await import("../workitems/repository.ts")
        ).workItemRepository.update(wi.id, { description: text.description });
      const item = await ingest(
        {
          source: "radar",
          sourceKey: c.row.fingerprint,
          ownerId,
          workItemId: wi.id,
          incidentFingerprint: c.finding.prodFingerprint ?? null,
          revisionOf: [c.row.severity, c.row.kinds.slice().sort(), c.row.status],
          severity: c.row.severity as never,
          environment: c.finding.environment,
          service: c.finding.service,
          observedAt: c.finding.signalAt,
          occurrences: 1,
        },
        db,
      );
      await q(
        db,
        "UPDATE radar_findings SET work_item_id=$2,intake_item_id=COALESCE($3,intake_item_id) WHERE id=$1",
        [c.row.id, wi.id, item?.id ?? null],
      );
      await auditRadar(db, "finding.ingested", c.row.id, {
        intake_item_id: item?.id ?? null,
        work_item: code,
        policy_mode: policy.mode,
      });
      n++;
    }
  return n;
}

/** Meaningful changes only (new, reopened, escalated severity of medium+), aggregated by the Telegram buffer. */
const MAX_NOTIFICATIONS_PER_PASS = 10;
/**
 * Meaningful changes only (new, long-quiet reopened, escalated; medium+), to the owners of radar policies through the
 * Telegram aggregation buffer — never to the shared webhook (signatures come from production logs). At most
 * MAX_NOTIFICATIONS_PER_PASS per pass, most severe first; the rest stay visible in the findings list.
 */
async function notifyFindings(
  changed: Array<{
    row: FindingRow;
    finding: Detection & { kinds: FindingKind[] };
    isNew: boolean;
    escalated: boolean;
  }>,
  db: Db = pool,
) {
  const worth = changed
    .filter(
      (c) => (c.isNew || c.escalated) && severityRank(c.row.severity) >= severityRank("medium"),
    )
    .sort((a, b) => severityRank(b.row.severity) - severityRank(a.row.severity))
    .slice(0, MAX_NOTIFICATIONS_PER_PASS);
  if (!worth.length) return;
  const policies = await loadIntakePolicies(db);
  const recipients = [
    ...new Set(
      policies
        .filter((p) => p.source === "radar" && p.owner_id != null && p.mode !== "OFF")
        .map((p) => Number(p.owner_id)),
    ),
  ];
  const { enqueueNotification } = await import("../telegram/sync.ts");
  for (const c of worth) {
    const text = `📡 Radar: ${c.finding.kinds.join(", ")} · ${c.finding.service} (${c.finding.environment}) · ${c.row.severity}/${c.finding.confidence}\n${c.finding.signature.slice(0, 160)}\n→ ${c.finding.nextAction}`;
    for (const recipient of recipients)
      await enqueueNotification(db, recipient, {
        kind: "intake",
        severity: severityRank(c.row.severity) >= severityRank("high") ? "critical" : "important",
        dedupe: `radar:${c.row.fingerprint}:${c.row.severity}`,
        text,
      }).catch(() => {});
    await q(db, "UPDATE radar_findings SET notified_severity=$2 WHERE id=$1", [
      c.row.id,
      c.row.severity,
    ]);
  }
}

let lastTick = 0;
/** Reconcile-tick entry: interval-gated, no-op when disabled. */
export async function radarTick() {
  if (!config.radar.enabled || Date.now() - lastTick < config.radar.intervalSeconds * 1000) return;
  lastTick = Date.now();
  await radarScan();
}

export async function listFindings(opts: { status?: string; limit?: number } = {}) {
  return q(
    pool,
    `SELECT id,fingerprint,kinds,service,environment,signature,severity,confidence,status,stats,evidence,related,proposed_workflow,
            next_action,occurrences,first_detected_at,last_detected_at,last_signal_at,resolved_at,work_item_id,intake_item_id
       FROM radar_findings WHERE ($1::text IS NULL OR status=$1) ORDER BY last_detected_at DESC LIMIT $2`,
    [
      opts.status ?? null,
      Math.min(200, Math.max(1, Number.isFinite(opts.limit) ? Number(opts.limit) : 50)),
    ],
  );
}

export async function setFindingStatus(
  id: number,
  status: "open" | "resolved" | "suppressed",
  actorId: number,
) {
  const row = await one(
    pool,
    "UPDATE radar_findings SET status=$2,resolved_at=CASE WHEN $2='open' THEN NULL ELSE now() END,updated_at=now() WHERE id=$1 RETURNING id",
    [id, status],
  );
  if (row)
    await q(
      pool,
      "INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES($1,$2,'radar_finding',$3,'{}')",
      [actorId, `radar.finding.${status}`, String(id)],
    );
  return { ok: !!row };
}
