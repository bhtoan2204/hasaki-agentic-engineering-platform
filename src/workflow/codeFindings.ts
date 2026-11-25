import type pg from "pg";
import { json, one, pool, q, withTx, type Db } from "../db/pool.ts";
import { findingFingerprint } from "../radar/detect.ts";

/** A finding as a codebase-assessment run's assess output lists it (FINDINGS_CONTRACT in templates.ts). */
export interface RawFinding {
  id?: unknown;
  kind?: unknown;
  severity?: unknown;
  title?: unknown;
  repo?: unknown;
  related_repos?: unknown;
  file?: unknown;
  line?: unknown;
  symbol?: unknown;
  issue?: unknown;
  evidence?: unknown;
  implementable?: unknown;
  why_not?: unknown;
  code_evidence?: unknown;
}

export interface ScanFinding {
  key: string;
  fingerprint: string;
  repo: string;
  related_repos: string[];
  kind: string;
  severity: string;
  title: string;
  issue: string;
  file: string;
  line: number | null;
  symbol: string;
  evidence: string;
  implementable: boolean;
  why_not: string;
  code_evidence: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, repo: string) =>
  new RegExp(`(^|[^\\w.-])${escaped(repo)}([^\\w-]|$)`).test(text);
const normalizedFile = (file: string) => file.replace(/^\.\//, "").replace(/^\/+/, "");

/**
 * The repository a finding's code is in: the agent's `repo`, else the selected repository its evidence names
 * (`repo@commit` or plain), else the only selected one. Assessments before `repo` was asked for carry none.
 */
export function repoOf(f: RawFinding, selected: string[]): string {
  const own = str(f.repo);
  if (own) return own;
  const text = `${str(f.evidence)} ${str(f.issue)} ${str(f.file)}`;
  return selected.find((r) => mentions(text, r)) ?? (selected.length === 1 ? selected[0] : "");
}

/** The other selected repositories the finding names or the agent listed as affected by the same defect. */
export function relatedReposOf(f: RawFinding, own: string, selected: string[]): string[] {
  const listed = Array.isArray(f.related_repos) ? f.related_repos.map(str) : [];
  const text = `${str(f.issue)} ${str(f.evidence)} ${str(f.why_not)}`;
  const named = selected.filter((r) => mentions(text, r));
  return [...new Set([...listed, ...named])].filter((r) => r && r !== own).sort();
}

/** The agent's short title, else the issue's first sentence, cut to a list-sized line. */
export function titleOf(f: RawFinding): string {
  const t = str(f.title) || str(f.issue).split(/(?<=[.!?])\s|\n/)[0] || str(f.issue);
  return t.length > 120 ? `${t.slice(0, 117).trimEnd()}…` : t;
}

/**
 * One scan's findings with their cross-scan identity. The fingerprint is what stays the same when a later scan
 * reports the same defect (repository, category, file, enclosing symbol), never the wording or the line, which drift.
 * Findings of one scan that share that identity are told apart by their order along the file (as slop fingerprints).
 */
export function scanFindings(raw: unknown, selected: string[]): ScanFinding[] {
  const list = (Array.isArray(raw) ? raw : []).filter(
    (f): f is RawFinding => !!f && typeof f === "object",
  );
  const shaped = list.map((f, i) => {
    const repo = repoOf(f, selected);
    const line = Number(f.line);
    return {
      key: str(f.id) || `F${i + 1}`,
      repo,
      related_repos: relatedReposOf(f, repo, selected),
      kind: str(f.kind).toUpperCase() || "CODE_QUALITY",
      severity: ["high", "medium", "low"].includes(str(f.severity)) ? str(f.severity) : "medium",
      title: titleOf(f),
      issue: str(f.issue),
      file: normalizedFile(str(f.file)),
      line: Number.isInteger(line) && line > 0 ? line : null,
      symbol: str(f.symbol),
      evidence: str(f.evidence),
      implementable: f.implementable === true,
      why_not: str(f.why_not),
      code_evidence: f.code_evidence ?? null,
    };
  });
  const identity = (f: (typeof shaped)[number]) =>
    [f.repo.toLowerCase(), f.kind, f.file, f.symbol].join("|");
  const ordinal = new Map<string, number>();
  const ordered = [...shaped].sort(
    (a, b) => identity(a).localeCompare(identity(b)) || (a.line ?? 0) - (b.line ?? 0),
  );
  const fp = new Map<(typeof shaped)[number], string>();
  for (const f of ordered) {
    const id = identity(f);
    const n = ordinal.get(id) ?? 0;
    ordinal.set(id, n + 1);
    fp.set(
      f,
      findingFingerprint(["code", f.repo.toLowerCase(), f.kind, f.file, f.symbol, String(n)]),
    );
  }
  return shaped.map((f) => ({ ...f, fingerprint: fp.get(f)! }));
}

/**
 * Record one completed assessment: each finding updates the owner's finding with the same fingerprint (or creates
 * it) and adds a sighting with that scan's evidence. A finding a person resolved is reopened when a scan that
 * started after the resolution reports it again; a dismissed one stays dismissed. Findings this scan does not report
 * are left as they are.
 */
export async function ingestScan(
  c: pg.PoolClient,
  scan: { id: number; owner_id: number; seen_at: string; selected: string[]; findings: unknown },
) {
  const findings = scanFindings(scan.findings, scan.selected);
  for (const f of findings) {
    const row = await one<{ id: number }>(
      c,
      `INSERT INTO code_findings AS cf (owner_id, fingerprint, repo, related_repos, kind, severity, title, issue, file, line,
              symbol, evidence, implementable, why_not, code_evidence, first_seen_at, last_seen_at, first_scan_run_id, last_scan_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,$17)
       ON CONFLICT (owner_id, fingerprint) DO UPDATE SET
         occurrences = cf.occurrences + 1,
         related_repos = ARRAY(SELECT DISTINCT r FROM unnest(cf.related_repos || EXCLUDED.related_repos) r ORDER BY r),
         first_seen_at = LEAST(cf.first_seen_at, EXCLUDED.first_seen_at),
         first_scan_run_id = CASE WHEN EXCLUDED.first_seen_at < cf.first_seen_at THEN EXCLUDED.first_scan_run_id ELSE cf.first_scan_run_id END,
         -- The newest scan's description wins; an older scan ingested late only adds its sighting.
         severity = CASE WHEN EXCLUDED.last_seen_at >= cf.last_seen_at THEN EXCLUDED.severity ELSE cf.severity END,
         title = CASE WHEN EXCLUDED.last_seen_at >= cf.last_seen_at THEN EXCLUDED.title ELSE cf.title END,
         issue = CASE WHEN EXCLUDED.last_seen_at >= cf.last_seen_at THEN EXCLUDED.issue ELSE cf.issue END,
         line = CASE WHEN EXCLUDED.last_seen_at >= cf.last_seen_at THEN EXCLUDED.line ELSE cf.line END,
         evidence = CASE WHEN EXCLUDED.last_seen_at >= cf.last_seen_at THEN EXCLUDED.evidence ELSE cf.evidence END,
         implementable = CASE WHEN EXCLUDED.last_seen_at >= cf.last_seen_at THEN EXCLUDED.implementable ELSE cf.implementable END,
         why_not = CASE WHEN EXCLUDED.last_seen_at >= cf.last_seen_at THEN EXCLUDED.why_not ELSE cf.why_not END,
         code_evidence = CASE WHEN EXCLUDED.last_seen_at >= cf.last_seen_at THEN EXCLUDED.code_evidence ELSE cf.code_evidence END,
         last_scan_run_id = CASE WHEN EXCLUDED.last_seen_at >= cf.last_seen_at THEN EXCLUDED.last_scan_run_id ELSE cf.last_scan_run_id END,
         last_seen_at = GREATEST(cf.last_seen_at, EXCLUDED.last_seen_at),
         -- Reported again by a scan that started after a person resolved it: reopened.
         status = CASE WHEN (cf.status = 'resolved' AND EXCLUDED.last_seen_at > cf.resolved_at) THEN 'open' ELSE cf.status END,
         reopened_at = CASE WHEN (cf.status = 'resolved' AND EXCLUDED.last_seen_at > cf.resolved_at) THEN EXCLUDED.last_seen_at ELSE cf.reopened_at END,
         reopened_count = cf.reopened_count + CASE WHEN (cf.status = 'resolved' AND EXCLUDED.last_seen_at > cf.resolved_at) THEN 1 ELSE 0 END,
         status_note = CASE WHEN (cf.status = 'resolved' AND EXCLUDED.last_seen_at > cf.resolved_at) THEN 'reported again by scan #' || EXCLUDED.last_scan_run_id ELSE cf.status_note END,
         updated_at = now()
       RETURNING cf.id`,
      [
        scan.owner_id,
        f.fingerprint,
        f.repo,
        f.related_repos,
        f.kind,
        f.severity,
        f.title,
        f.issue,
        f.file,
        f.line,
        f.symbol,
        f.evidence,
        f.implementable,
        f.why_not,
        json(f.code_evidence),
        scan.seen_at,
        scan.id,
      ],
    );
    await q(
      c,
      `INSERT INTO code_finding_sightings (finding_id, scan_run_id, finding_key, seen_at, severity, issue, evidence, line, code_evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [
        row!.id,
        scan.id,
        f.key,
        scan.seen_at,
        f.severity,
        f.issue,
        f.evidence,
        f.line,
        json(f.code_evidence),
      ],
    );
  }
  await q(c, "INSERT INTO code_finding_scans (scan_run_id, findings) VALUES ($1, $2)", [
    scan.id,
    findings.length,
  ]);
  return findings.length;
}

/**
 * Ingest every completed assessment not ingested yet, oldest first: existing assessments on first use, new ones as
 * they complete. Idempotent and safe to call concurrently (one transaction per scan under a per-owner lock).
 */
export async function ingestPendingScans(ownerId?: number, db: pg.Pool = pool) {
  const pending = await q<{
    id: number;
    owner_id: number;
    seen_at: string;
    selected: string[];
    findings: unknown;
  }>(
    db,
    `SELECT r.id, r.owner_id, r.created_at AS seen_at, r.selected_repositories AS selected, a.output->'findings' AS findings
       FROM workflow_runs r JOIN workflow_steps a ON a.run_id = r.id AND a.key = 'assess' AND a.status = 'COMPLETED'
      WHERE r.definition_key = 'codebase-assessment' AND r.owner_id IS NOT NULL
        AND ($1::bigint IS NULL OR r.owner_id = $1)
        AND NOT EXISTS (SELECT 1 FROM code_finding_scans s WHERE s.scan_run_id = r.id)
      ORDER BY r.created_at, r.id LIMIT 200`,
    [ownerId ?? null],
  );
  let ingested = 0;
  for (const scan of pending)
    await withTx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('code_findings'), $1::int)", [
        Number(scan.owner_id) % 2_147_483_647,
      ]);
      if (await one(c, "SELECT 1 FROM code_finding_scans WHERE scan_run_id = $1", [scan.id]))
        return;
      await ingestScan(c, scan);
      ingested++;
    }, db);
  return ingested;
}

/**
 * Fix runs (codebase-improvement) started for a finding: by its fingerprint, or, for runs started before findings
 * were managed, by the scan and in-scan id they were started from.
 */
const FIX_RUNS = `SELECT r.id, r.status, r.created_at, r.finished_at, r.inputs->>'decision' AS decision
    FROM workflow_runs r
   WHERE r.definition_key = 'codebase-improvement' AND r.owner_id = f.owner_id
     AND (r.inputs->'finding'->>'fingerprint' = f.fingerprint
          OR EXISTS (SELECT 1 FROM code_finding_sightings s
                      WHERE s.finding_id = f.id AND s.scan_run_id::text = r.inputs->'finding'->>'scan_run_id'
                        AND s.finding_key = r.inputs->'finding'->>'id'))`;

const TERMINAL = `('COMPLETED','FAILED','CANCELED')`;

/**
 * What a person sees and filters on: the lifecycle a person set (resolved, dismissed) first, then a fix run in
 * flight or one that changed the code, then why the finding cannot simply be fixed, else it needs a look.
 */
const DISPLAY_STATUS = `CASE WHEN f.status = 'dismissed' THEN 'dismissed'
    WHEN f.status = 'resolved' THEN 'resolved'
    WHEN fx.status IS NOT NULL AND fx.status NOT IN ${TERMINAL} THEN 'in_progress'
    WHEN fx.status = 'COMPLETED' AND fx.changed THEN 'fixed'
    WHEN f.code_evidence->>'status' = 'missing' THEN 'unverified'
    WHEN NOT f.implementable THEN 'report_only'
    ELSE 'needs_look' END`;

export const DISPLAY_STATUSES = [
  "needs_look",
  "in_progress",
  "fixed",
  "report_only",
  "unverified",
  "resolved",
  "dismissed",
] as const;

const FINDING_BASE = `
  SELECT f.*, fx.id AS fix_run_id, fx.status AS fix_status, ${DISPLAY_STATUS} AS display_status
    FROM code_findings f
    LEFT JOIN LATERAL (
      SELECT x.id, x.status,
             EXISTS (SELECT 1 FROM workflow_steps s WHERE s.run_id = x.id AND s.key = 'implement' AND s.status = 'COMPLETED') AS changed
        FROM (${FIX_RUNS}) x ORDER BY x.id DESC LIMIT 1) fx ON true`;

export interface FindingFilter {
  ownerId?: number;
  all?: boolean;
  project?: string;
  repo?: string;
  severity?: string;
  kind?: string;
  status?: string;
  q?: string;
  scan?: number;
  page?: number;
  pageSize?: number;
}

/** One page of the owner's findings (support: everyone's) across every scan, filtered, most actionable first. */
export async function listFindings(filter: FindingFilter, db: Db = pool) {
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const size = Math.min(100, Math.max(1, Math.floor(filter.pageSize ?? 25)));
  const scope = `(CASE WHEN $1::bool THEN true WHEN $2::bigint IS NOT NULL THEN f.owner_id = $2 ELSE false END)`;
  const params = [!!filter.all, filter.ownerId ?? null];
  const where = [
    `($3::text = '' OR EXISTS (SELECT 1 FROM repositories rp WHERE lower(rp.name) = ANY(ARRAY(SELECT lower(x) FROM unnest(f.related_repos || f.repo) x))
                         AND EXISTS (SELECT 1 FROM unnest(rp.projects) p WHERE lower(p) = lower($3))))`,
    `($4::text = '' OR f.repo = $4 OR $4 = ANY(f.related_repos))`,
    `($5::text = '' OR f.severity = $5)`,
    `($6::text = '' OR f.kind = $6)`,
    `($7::text = '' OR display_status = $7)`,
    `($8::text = '' OR concat_ws(' ', f.title, f.issue, f.file, f.repo, f.symbol, f.evidence) ILIKE '%' || $8 || '%')`,
    `($9::bigint IS NULL OR EXISTS (SELECT 1 FROM code_finding_sightings s WHERE s.finding_id = f.id AND s.scan_run_id = $9))`,
  ].join(" AND ");
  const args = [
    ...params,
    filter.project ?? "",
    filter.repo ?? "",
    filter.severity ?? "",
    filter.kind ?? "",
    filter.status ?? "",
    (filter.q ?? "").replace(/[\\%_]/g, (m) => `\\${m}`),
    filter.scan ?? null,
  ];
  const rows = await q<Record<string, unknown> & { total: string }>(
    db,
    `WITH scoped AS (${FINDING_BASE} WHERE ${scope}),
          matched AS (SELECT * FROM scoped f WHERE ${where})
     SELECT m.id, m.fingerprint, m.repo, m.related_repos, m.kind, m.severity, m.title, m.file, m.line, m.symbol,
            m.implementable, m.code_evidence, m.status, m.display_status, m.occurrences, m.reopened_count,
            m.first_seen_at, m.last_seen_at, m.last_scan_run_id, m.fix_run_id, m.fix_status,
            count(*) OVER () AS total
       FROM matched m
      ORDER BY CASE WHEN m.display_status IN ('resolved','dismissed') THEN 1 ELSE 0 END,
               array_position(ARRAY['high','medium','low'], m.severity), m.last_seen_at DESC, m.id DESC
      LIMIT ${size} OFFSET ${(page - 1) * size}`,
    args,
  );
  const facets = await one<{
    repos: string[] | null;
    kinds: string[] | null;
    statuses: Record<string, number> | null;
  }>(
    db,
    `WITH scoped AS (${FINDING_BASE} WHERE ${scope})
     SELECT (SELECT array_agg(DISTINCT r ORDER BY r) FROM scoped, unnest(scoped.related_repos || scoped.repo) r WHERE r <> '') AS repos,
            (SELECT array_agg(DISTINCT kind ORDER BY kind) FROM scoped) AS kinds,
            (SELECT json_object_agg(display_status, n) FROM (SELECT display_status, count(*) AS n FROM scoped GROUP BY 1) s) AS statuses`,
    params,
  );
  return {
    items: rows.map(({ total: _total, ...r }) => r),
    total: Number(rows[0]?.total ?? 0),
    page,
    page_size: size,
    facets: {
      repos: facets?.repos ?? [],
      kinds: facets?.kinds ?? [],
      statuses: facets?.statuses ?? {},
    },
  };
}

/** A finding with every scan that reported it and every fix run started for it. Null when not the actor's. */
export async function findingDetail(
  id: number,
  filter: { ownerId?: number; all?: boolean },
  db: Db = pool,
) {
  const finding = await one<Record<string, unknown> & { owner_id: number }>(
    db,
    `${FINDING_BASE} WHERE f.id = $1 AND ($2::bool OR f.owner_id = $3)`,
    [id, !!filter.all, filter.ownerId ?? null],
  );
  if (!finding) return null;
  const [sightings, fixes] = await Promise.all([
    q(
      db,
      `SELECT s.scan_run_id, s.finding_key, s.seen_at, s.severity, s.issue, s.evidence, s.line, s.code_evidence,
              r.selected_repositories, r.inputs->>'focus' AS focus
         FROM code_finding_sightings s JOIN workflow_runs r ON r.id = s.scan_run_id
        WHERE s.finding_id = $1 ORDER BY s.seen_at DESC, s.scan_run_id DESC`,
      [id],
    ),
    q(
      db,
      `SELECT x.*, (SELECT json_agg(json_build_object('key', s.key, 'status', s.status) ORDER BY s.position)
                      FROM workflow_steps s WHERE s.run_id = x.id) AS steps
         FROM code_findings f, LATERAL (${FIX_RUNS}) x WHERE f.id = $1 ORDER BY x.id DESC`,
      [id],
    ),
  ]);
  return { ...finding, sightings, fixes };
}

export type FindingStatus = "open" | "resolved" | "dismissed";

/**
 * The owner's lifecycle decision (support access reads, never decides). Resolving records when, so a later scan that
 * reports it again reopens it.
 */
export async function setFindingStatus(
  id: number,
  actor: { id: number },
  status: FindingStatus,
  note: string,
  db: Db = pool,
) {
  return one<{ id: number; status: string }>(
    db,
    `UPDATE code_findings f SET status = $2, status_note = $3, status_changed_by = $4, status_changed_at = now(),
            resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END, updated_at = now()
      WHERE f.id = $1 AND f.owner_id = $4 RETURNING f.id, f.status`,
    [id, status, note, actor.id],
  );
}
