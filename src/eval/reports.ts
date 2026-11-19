import { createHash } from "node:crypto";
import { pool, q, one, withTx, type Db } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import type { Actor } from "../authz/access.ts";

/**
 * Central storage for evaluation reports produced outside the benchmark framework (autonomy suite, performance
 * baseline, bench, benchmark/comparison exports). The header goes to `evaluation_reports`, per-case rows to the
 * existing `eval_results` table. Saving the same report twice — or importing a file the CLI already saved — is a no-op
 * (`content_hash` of the canonical report). JSON/Markdown files remain optional exports.
 *
 * Visibility: `private` (owner only) or `team` (every authenticated member of this platform instance, read-only).
 * Only the owner changes visibility; administrators may read everything with an explicit support scope.
 */
export type Visibility = "private" | "team";
export type ReportKind = "autonomy" | "performance" | "bench" | "benchmark";

export interface ResultRowInput {
  suite: string;
  scenario: string;
  candidate: string;
  profile?: string | null;
  status: string;
  correct?: boolean | null;
  regression?: boolean | null;
  verdict?: string | null;
  repairs?: number;
  human_gates?: number;
  wall_s?: number | null;
  cost_usd?: number | null;
  tokens?: number | null;
  data: Record<string, unknown>;
}

export interface NormalizedReport {
  kind: ReportKind;
  suite: string;
  suite_version: string | null;
  manifest_hash: string | null;
  commit_sha: string | null;
  provider: string | null;
  model: string | null;
  configuration: Record<string, unknown>;
  metrics: Record<string, unknown>;
  gate: Record<string, unknown> | null;
  provenance: Record<string, unknown>;
  generated_at: string | null;
  rows: ResultRowInput[];
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;
export const reportHash = (raw: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(raw)))
    .digest("hex");

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Recognize a report file produced by one of the platform's evaluation commands (pure). */
export function normalizeReport(raw: unknown, opts: { suite?: string } = {}): NormalizedReport {
  const r = obj(raw);
  // npm run eval:autonomy → autonomy-<commit>.json
  if (Array.isArray(r.results) && typeof r.suite === "string" && r.suite.startsWith("autonomy-")) {
    const results = r.results.map(obj);
    return {
      kind: "autonomy",
      suite: r.suite,
      suite_version: str(r.metrics_version) ?? str(r.suite),
      manifest_hash: str(r.manifest_hash),
      commit_sha: str(r.commit),
      provider: null,
      model: null,
      configuration: { variants: results.map((x) => obj(x.variant)) },
      metrics: Object.fromEntries(results.map((x) => [String(obj(x.variant).name), x.metrics])),
      gate: {
        passed: results.every((x) => obj(x.gate).passed === true),
        variants: Object.fromEntries(results.map((x) => [String(obj(x.variant).name), x.gate])),
      },
      provenance: { evidence_kind: r.evidence_kind ?? null },
      generated_at: str(r.generated_at),
      rows: results.flatMap((x) =>
        (Array.isArray(x.episodes) ? x.episodes : []).map((e) => {
          const ep = obj(e);
          return {
            suite: String(r.suite),
            scenario: String(ep.case_id ?? ep.episode_id),
            candidate: String(obj(x.variant).name),
            status: String(ep.status ?? "unknown"),
            correct: typeof ep.oracle === "boolean" ? ep.oracle : null,
            human_gates: Array.isArray(ep.human_events) ? ep.human_events.length : 0,
            data: ep,
          };
        }),
      ),
    };
  }
  // src/cli/benchPerformance.ts → performance report
  if (r.samples && r.baseline && r.candidate && r.paired) {
    const conditions = obj(r.conditions);
    return {
      kind: "performance",
      suite: str(r.suite) ?? "platform-performance",
      suite_version: r.fixture_version == null ? null : String(r.fixture_version),
      manifest_hash: str(conditions.harness_hash),
      commit_sha: str(obj(r.candidate).revision),
      provider: null,
      model: null,
      configuration: conditions,
      metrics: obj(r.paired),
      gate: null,
      provenance: {
        evidence_kind: r.evidence_kind ?? null,
        baseline: obj(r.baseline),
        candidate: obj(r.candidate),
        limits: r.limits ?? [],
      },
      generated_at: str(r.generated_at),
      rows: [],
    };
  }
  // npm run eval (benchmark framework) → report.json
  if (obj(r.suite).key && Array.isArray(r.executions)) {
    const s = obj(r.suite);
    const comparison = obj(r.comparison);
    return {
      kind: "benchmark",
      suite: String(s.key),
      suite_version: s.version == null ? null : String(s.version),
      manifest_hash: str(s.hash),
      commit_sha: null,
      provider: null,
      model: null,
      configuration: {
        executions: r.executions.map((e) => ({
          id: obj(e).id,
          configuration: obj(e).configuration,
        })),
      },
      metrics: {
        verdict: obj(comparison.report).verdict ?? null,
        report: comparison.report ?? null,
      },
      gate: null,
      provenance: { note: r.provenance ?? null },
      generated_at: str(r.generated_at),
      rows: [],
    };
  }
  // npm run bench → bench-results.json (a list of scenario rows)
  if (Array.isArray(raw) && raw.every((x) => obj(x).scenario)) {
    const suite = opts.suite ?? "bench-v2";
    const rows = raw.map(obj).filter((x) => "status" in x);
    return {
      kind: "bench",
      suite,
      suite_version: suite,
      manifest_hash: null,
      commit_sha: null,
      provider: null,
      model: null,
      configuration: {},
      metrics: {
        results: rows.length,
        correct: rows.filter((x) => x.correct === true).length,
      },
      gate: null,
      provenance: { source: "bench-results.json" },
      generated_at: null,
      rows: rows.map((x) => ({
        suite,
        scenario: String(x.scenario),
        candidate: String(x.candidate ?? "platform"),
        profile: x.candidate ? null : str(x.profile),
        status: String(x.status),
        correct: typeof x.correct === "boolean" ? x.correct : null,
        regression: typeof x.regression === "boolean" ? x.regression : null,
        verdict: str(x.verdict),
        repairs: num(x.repairs) ?? 0,
        human_gates: num(x.human_gates) ?? 0,
        wall_s: num(x.wall_s),
        cost_usd: num(x.cost_usd_est),
        tokens: Number(x.input_tokens ?? 0) + Number(x.output_tokens ?? 0) || null,
        data: x,
      })),
    };
  }
  throw new HttpError(
    400,
    "unrecognized evaluation report (autonomy, performance, benchmark or bench results expected)",
  );
}

/** Save a report and its rows once per owner; a repeat returns the stored report (`created: false`). */
export async function saveReport(
  raw: unknown,
  o: { ownerId: number; visibility?: Visibility; source: "cli" | "import" | "api"; suite?: string },
  db?: Db,
) {
  const r = normalizeReport(raw, { suite: o.suite });
  const hash = reportHash(raw);
  const visibility = o.visibility ?? "private";
  const run = <T>(fn: (c: Db) => Promise<T>) => (db ? fn(db) : withTx(fn));
  return run(async (c) => {
    const row = await one<{ id: number }>(
      c,
      `INSERT INTO evaluation_reports (owner_id, visibility, kind, suite, suite_version, manifest_hash, commit_sha, provider, model,
                                       configuration, metrics, gate, provenance, content_hash, source, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (owner_id, content_hash) DO NOTHING RETURNING id`,
      [
        o.ownerId,
        visibility,
        r.kind,
        r.suite,
        r.suite_version,
        r.manifest_hash,
        r.commit_sha,
        r.provider,
        r.model,
        JSON.stringify(r.configuration),
        JSON.stringify(r.metrics),
        r.gate ? JSON.stringify(r.gate) : null,
        JSON.stringify(r.provenance),
        hash,
        o.source,
        r.generated_at,
      ],
    );
    if (!row) {
      const existing = await one<{ id: number }>(
        c,
        "SELECT id FROM evaluation_reports WHERE owner_id = $1 AND content_hash = $2",
        [o.ownerId, hash],
      );
      return { id: existing!.id, created: false, kind: r.kind, rows: 0 };
    }
    for (const x of r.rows)
      await q(
        c,
        `INSERT INTO eval_results (suite, scenario, candidate, profile, status, correct, regression, verdict, repairs, human_gates,
                                   wall_s, cost_usd, tokens, data, owner_id, visibility, report_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          x.suite,
          x.scenario,
          x.candidate,
          x.profile ?? null,
          x.status,
          x.correct ?? null,
          x.regression ?? null,
          x.verdict ?? null,
          x.repairs ?? 0,
          x.human_gates ?? 0,
          x.wall_s ?? null,
          x.cost_usd ?? null,
          x.tokens ?? null,
          JSON.stringify(x.data),
          o.ownerId,
          visibility,
          row.id,
        ],
      );
    return { id: row.id, created: true, kind: r.kind, rows: r.rows.length };
  });
}

/** Who may read: the owner, every member for team-shared reports, administrators with an explicit support scope. */
const readable = `(r.owner_id = $1 OR r.visibility = 'team' OR $2::boolean)`;

export function listReports(actor: Actor, o: { kind?: string | null; all?: boolean } = {}) {
  return q(
    pool,
    `SELECT r.id, r.kind, r.suite, r.suite_version, r.manifest_hash, r.commit_sha, r.provider, r.model, r.visibility,
            r.source, r.generated_at, r.created_at, r.gate, r.owner_id, u.username AS owner, (r.owner_id = $1) AS mine,
            (SELECT count(*)::int FROM eval_results e WHERE e.report_id = r.id) AS results
       FROM evaluation_reports r JOIN users u ON u.id = r.owner_id
      WHERE ${readable} AND ($3::text IS NULL OR r.kind = $3)
      ORDER BY r.created_at DESC LIMIT 200`,
    [actor.id, !!o.all && actor.role === "admin", o.kind ?? null],
  );
}

export async function getReport(actor: Actor, id: number, all = false) {
  const r = await one(
    pool,
    `SELECT r.*, u.username AS owner, (r.owner_id = $1) AS mine FROM evaluation_reports r JOIN users u ON u.id = r.owner_id
      WHERE r.id = $3 AND ${readable}`,
    [actor.id, all && actor.role === "admin", id],
  );
  if (!r) throw new HttpError(404, "evaluation report not found");
  const results = await q(
    pool,
    "SELECT id, suite, scenario, candidate, profile, status, correct, regression, verdict, human_gates, wall_s, cost_usd, tokens, data FROM eval_results WHERE report_id = $1 ORDER BY id",
    [id],
  );
  return { ...r, results };
}

export async function setReportVisibility(actor: Actor, id: number, visibility: Visibility) {
  if (!["private", "team"].includes(visibility))
    throw new HttpError(400, "visibility must be private or team");
  return withTx(async (c) => {
    const r = await one(
      c,
      "UPDATE evaluation_reports SET visibility = $3 WHERE id = $1 AND owner_id = $2 RETURNING id, visibility",
      [id, actor.id, visibility],
    );
    if (!r) throw new HttpError(404, "evaluation report not found");
    await q(c, "UPDATE eval_results SET visibility = $2 WHERE report_id = $1", [id, visibility]);
    return r;
  });
}

/** Benchmark-framework evaluation runs share the same visibility model (owner-only change, results follow). */
export async function setEvaluationVisibility(actor: Actor, id: number, visibility: Visibility) {
  if (!["private", "team"].includes(visibility))
    throw new HttpError(400, "visibility must be private or team");
  return withTx(async (c) => {
    const r = await one(
      c,
      "UPDATE evaluation_runs SET visibility = $3 WHERE id = $1 AND owner_id = $2 RETURNING id, visibility",
      [id, actor.id, visibility],
    );
    if (!r) throw new HttpError(404, "Evaluation not found");
    await q(
      c,
      "UPDATE eval_results SET visibility = $2 WHERE case_run_id IN (SELECT id FROM evaluation_case_runs WHERE evaluation_id = $1)",
      [id, visibility],
    );
    return r;
  });
}

/** CLI owner (`--owner`): an active platform user. */
export async function ownerByUsername(username: string) {
  const u = await one<{ id: number }>(pool, "SELECT id FROM users WHERE username = $1 AND active", [
    username,
  ]);
  if (!u) throw new Error(`no active user ${username}`);
  return u.id;
}
