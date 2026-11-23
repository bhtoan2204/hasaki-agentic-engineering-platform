import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pool, q, one, withTx, type Db } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import { listAccessibleRepositories } from "../repos/access.ts";
import type { FixProofReport } from "../agent/proofOfFix.ts";

/**
 * Causal Engineering Memory: what the platform learned from an outcome it verified itself, as a structured record —
 * incident → symptoms → root cause (with evidence refs) → change → verification → outcome — plus the approaches that
 * FAILED, kept as cautionary (negative) knowledge. Status comes from the Proof-of-Fix verdict, never from a model:
 *   VERIFIED → verified · PARTIAL → proposed · INCONCLUSIVE → hypothesis · FAILED → rejected (negative).
 * Records are owner-private and versioned; a contradiction demotes the earlier record instead of overwriting it; a
 * code change in the validity boundary marks it outdated. Sharing goes through the existing knowledge proposal review.
 */

const exec = promisify(execFile);
export const CAUSAL_STATUSES = [
  "verified",
  "proposed",
  "hypothesis",
  "rejected",
  "outdated",
] as const;
export type CausalStatus = (typeof CAUSAL_STATUSES)[number];
const RANK: Record<string, number> = {
  outdated: 0,
  rejected: 0,
  hypothesis: 1,
  proposed: 2,
  verified: 3,
};

export interface CausalRow {
  id: number;
  owner_id: number;
  memory_key: string;
  version: number;
  status: CausalStatus;
  negative: boolean;
  confidence: string;
  title: string;
  incident: string;
  symptoms: string[];
  root_cause: string;
  root_cause_evidence: unknown[];
  fix_approach: string;
  failed_approaches: Array<{ approach: string; why: string; run_id?: number }>;
  regression_tests: string[];
  verification: Record<string, unknown>;
  outcome: string;
  services: string[];
  repositories: string[];
  files: string[];
  symbols: string[];
  error_signatures: string[];
  commits: Record<string, string>;
  validity: Record<string, unknown>;
  provenance: Record<string, unknown>;
  run_id: number | null;
  knowledge_key: string | null;
  knowledge_proposal_id: number | null;
  invalidation_reason: string | null;
  updated_at: string;
}

const tokens = (s: string) =>
  new Set(
    String(s ?? "")
      .toLowerCase()
      .replace(/[0-9a-f]{8,}/g, " ")
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "when",
  "was",
  "not",
  "are",
  "has",
  "but",
  "into",
]);
export const jaccard = (a: string, b: string) => {
  const x = tokens(a),
    y = tokens(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const t of x) if (y.has(t)) n++;
  return n / (x.size + y.size - n);
};
export const normalizeSignature = (s: string) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[0-9a-f]{8,}|\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);

/** The distillation of a Proof-of-Fix report (plus run context) into a causal record. Pure. */
export function causalFromProof(input: {
  report: FixProofReport;
  repositories: string[];
  testedHeads: Record<string, string>;
  errorSignatures: string[];
  services: string[];
  runId: number;
  fixProofId: number | null;
  pullRequests?: Array<{ url: string; repo: string }>;
}) {
  const r = input.report;
  const status: CausalStatus =
    r.verdict === "VERIFIED"
      ? "verified"
      : r.verdict === "PARTIAL"
        ? "proposed"
        : r.verdict === "INCONCLUSIVE"
          ? "hypothesis"
          : "rejected";
  // Files are kept per repository ("repo:path") when the evidence says which repository: invalidation then checks
  // each repository only for its own files.
  const files = [
    ...new Set([
      ...r.root_cause.supporting.flatMap((e) =>
        e.location ? [`${e.repository ? `${e.repository}:` : ""}${e.location.split(":")[0]}`] : [],
      ),
      ...r.change.symptom_signals.map((s) => `${s.repo ? `${s.repo}:` : ""}${s.file}`),
    ]),
  ].slice(0, 40);
  const repositories = [...new Set([...input.repositories, ...r.change.repositories])].sort();
  const signatures = [
    ...new Set(input.errorSignatures.map(normalizeSignature).filter(Boolean)),
  ].slice(0, 10);
  const anchor = signatures[0] ?? normalizeSignature(r.root_cause.hypothesis || r.incident.title);
  const failed: CausalRow["failed_approaches"] = [];
  if (r.verdict === "FAILED")
    failed.push({
      approach:
        `${r.change.remediation_kind ?? "change"}: ${r.change.causal_link || r.root_cause.hypothesis}`.slice(
          0,
          400,
        ),
      why: r.reasons.join("; ").slice(0, 400),
      run_id: input.runId,
    });
  for (const s of r.change.symptom_signals.filter((x) => !x.justified))
    failed.push({
      approach: `${s.kind} in ${s.file}:${s.line}`,
      why: `symptom-only change without justification: ${s.detail}`.slice(0, 300),
      run_id: input.runId,
    });
  return {
    memory_key: createHash("sha256")
      .update(`${repositories.join(",")}|${anchor}`)
      .digest("hex")
      .slice(0, 32),
    status,
    negative: r.verdict === "FAILED",
    confidence: r.verdict === "VERIFIED" ? "high" : r.verdict === "PARTIAL" ? "medium" : "low",
    title: (r.incident.title || r.root_cause.hypothesis || "Engineering outcome").slice(0, 200),
    incident: r.incident.request.slice(0, 1000),
    symptoms: signatures,
    root_cause: r.root_cause.hypothesis.slice(0, 1000),
    root_cause_evidence: [
      ...r.root_cause.supporting,
      ...r.root_cause.contradicting.map((c) => ({ ...c, contradicts: true })),
    ].slice(0, 20),
    fix_approach: r.verdict === "FAILED" ? "" : (r.change.causal_link || "").slice(0, 600),
    failed_approaches: failed.slice(0, 20),
    regression_tests: r.reproduction.test ? [r.reproduction.test] : [],
    verification: {
      verdict: r.verdict,
      reproduction: r.reproduction.status,
      implementation_tests: r.verification.implementation_tests,
      regression_tests: r.verification.regression_tests,
      review: r.verification.review.verdict,
      missing: r.missing.slice(0, 10),
    },
    outcome:
      r.verdict === "VERIFIED"
        ? "fixed and verified"
        : r.verdict === "FAILED"
          ? "approach failed"
          : r.reasons.join("; ").slice(0, 300),
    services: [...new Set(input.services)].slice(0, 10),
    repositories,
    files,
    symbols: [] as string[],
    error_signatures: signatures,
    pull_requests: input.pullRequests ?? [],
    commits: input.testedHeads,
    validity: {
      repositories,
      files,
      commits: input.testedHeads,
      captured_at: new Date().toISOString(),
    },
    provenance: {
      source: "proof_of_fix",
      run_id: input.runId,
      fix_proof_id: input.fixProofId,
      proof_version: r.version,
    },
    run_id: input.runId,
    fix_proof_id: input.fixProofId,
  };
}

type Captured = ReturnType<typeof causalFromProof>;

async function snapshot(db: Db, row: CausalRow, change: string, actorId: number | null) {
  await q(
    db,
    "INSERT INTO causal_memory_versions(memory_id,version,snapshot,change,actor_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [row.id, row.version, JSON.stringify(row), change, actorId],
  );
}

const COLUMNS = [
  "status",
  "negative",
  "confidence",
  "title",
  "incident",
  "symptoms",
  "root_cause",
  "root_cause_evidence",
  "fix_approach",
  "failed_approaches",
  "regression_tests",
  "verification",
  "outcome",
  "services",
  "repositories",
  "files",
  "symbols",
  "error_signatures",
  "pull_requests",
  "commits",
  "validity",
  "provenance",
  "run_id",
  "fix_proof_id",
] as const;
const JSON_COLS = new Set([
  "symptoms",
  "root_cause_evidence",
  "failed_approaches",
  "regression_tests",
  "verification",
  "pull_requests",
  "commits",
  "validity",
  "provenance",
]);
const val = (c: string, v: unknown) => (JSON_COLS.has(c) ? JSON.stringify(v) : v);

/**
 * Insert or update the owner's record for this key. Stronger evidence updates it (version + 1); weaker evidence only
 * adds failed approaches; a VERIFIED outcome whose root cause contradicts a VERIFIED record demotes both to "proposed"
 * (a human decides) and links them. Every change is a version; nothing is overwritten without history.
 */
export async function upsertCausal(ownerId: number, m: Captured, db?: Db) {
  const run = async (c: Db) => {
    // Race-free first capture: a concurrent first insert of the same key loses the conflict and updates instead.
    const created = await one<CausalRow>(
      c,
      `INSERT INTO causal_memories(owner_id,memory_key,${COLUMNS.join(",")}) VALUES($1,$2,${COLUMNS.map((_, i) => `$${i + 3}`).join(",")})
       ON CONFLICT (owner_id, memory_key, negative) DO NOTHING RETURNING *`,
      [ownerId, m.memory_key, ...COLUMNS.map((k) => val(k, m[k]))],
    );
    if (created) {
      await snapshot(c, created, "created", null);
      return { row: created, change: "created" as const };
    }
    const prev = (await one<CausalRow>(
      c,
      "SELECT * FROM causal_memories WHERE owner_id=$1 AND memory_key=$2 AND negative=$3 FOR UPDATE",
      [ownerId, m.memory_key, m.negative],
    ))!;
    const failed = [
      ...prev.failed_approaches,
      ...m.failed_approaches.filter(
        (f) => !prev.failed_approaches.some((p) => p.approach === f.approach),
      ),
    ].slice(-30);
    // A contradiction is a different explanation with no shared evidence location — a paraphrase of the same cause
    // (same cited code) is corroboration, not conflict.
    const locs = (ev: unknown[]) =>
      new Set(ev.map((e) => String((e as { location?: unknown })?.location ?? "")).filter(Boolean));
    const prevLocs = locs(prev.root_cause_evidence);
    const sharedEvidence = [...locs(m.root_cause_evidence)].some((l) => prevLocs.has(l));
    const contradiction =
      prev.status === "verified" &&
      m.status === "verified" &&
      !!prev.root_cause &&
      !!m.root_cause &&
      !sharedEvidence &&
      jaccard(prev.root_cause, m.root_cause) < 0.2;
    // An open contradiction is a human decision: later runs add evidence but never resolve it by overwriting.
    const unresolved = !!(prev.provenance as { contradiction?: { unresolved?: boolean } })
      ?.contradiction?.unresolved;
    let next: Partial<Record<(typeof COLUMNS)[number], unknown>> & {
      version: number;
      status?: string;
    };
    let change: string;
    if (contradiction) {
      change = "contradicted";
      next = {
        version: prev.version + 1,
        status: "proposed",
        confidence: "low",
        provenance: {
          ...prev.provenance,
          contradiction: {
            unresolved: true,
            earlier: prev.root_cause,
            later: m.root_cause,
            later_run: m.run_id,
            at: new Date().toISOString(),
          },
        },
        failed_approaches: failed,
      };
    } else if (!unresolved && (RANK[m.status] >= RANK[prev.status] || prev.status === "outdated")) {
      change = prev.status === m.status ? "corroborated" : `upgraded ${prev.status} → ${m.status}`;
      next = {
        ...m,
        version: prev.version + 1,
        failed_approaches: failed,
        regression_tests: [...new Set([...prev.regression_tests, ...m.regression_tests])],
        root_cause_evidence: [...m.root_cause_evidence, ...prev.root_cause_evidence].slice(0, 30),
      };
    } else {
      change = `weaker evidence (${m.status}) recorded; status ${prev.status} kept`;
      next = { version: prev.version + 1, failed_approaches: failed };
    }
    const keys = Object.keys(next).filter(
      (k) => k !== "version" && (COLUMNS as readonly string[]).includes(k),
    ) as Array<(typeof COLUMNS)[number]>;
    const row = (await one<CausalRow>(
      c,
      `UPDATE causal_memories SET version=$2,${keys.map((k, i) => `${k}=$${i + 3}`).join(",")}${keys.length ? "," : ""}invalidated_at=CASE WHEN $${keys.length + 3}::text='outdated' THEN invalidated_at ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *`,
      [prev.id, next.version, ...keys.map((k) => val(k, next[k])), next.status ?? prev.status],
    ))!;
    await snapshot(c, row, change, null);
    if (change === "contradicted")
      await retractProposal(c, row, "contradicted by a later verified outcome");
    return { row, change };
  };
  return db ? run(db) : withTx(run);
}

/**
 * A record that stopped being authoritative must not keep its knowledge proposal open: a pending proposal becomes
 * obsolete (an already approved item follows the knowledge review flow — it is reported, not silently changed).
 */
async function retractProposal(db: Db, row: CausalRow, why: string) {
  if (!row.knowledge_proposal_id) return;
  await q(db, "UPDATE knowledge_proposals SET status='obsolete' WHERE id=$1 AND status='pending'", [
    row.knowledge_proposal_id,
  ]);
  await q(db, "UPDATE causal_memories SET provenance = provenance || $2 WHERE id=$1", [
    row.id,
    JSON.stringify({ proposal_retracted: why }),
  ]);
}

/**
 * The validity commit of each repository: the merge base of the tested head with the base branch, so an unmerged fix
 * branch is not "changed" relative to its own commit. Unknown (no checkout / sha) → omitted (never invalidated).
 */
async function validityCommits(heads: Record<string, string>) {
  const { checkoutOf } = await import("../impact/index.ts");
  const { repositoryBaseBranch } = await import("../repos/service.ts");
  const out: Record<string, string> = {};
  for (const [repo, sha] of Object.entries(heads)) {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) continue;
    const path = await checkoutOf(repo).catch(() => null);
    if (!path) continue;
    const base = await repositoryBaseBranch(repo);
    for (const ref of [`origin/${base}`, base]) {
      const mb = await exec("git", ["-C", path, "merge-base", sha, ref], { timeout: 10_000 })
        .then((r) => r.stdout.trim())
        .catch(() => "");
      if (/^[0-9a-f]{40}$/.test(mb)) {
        out[repo] = mb;
        break;
      }
    }
  }
  return out;
}

/** Record the outcome of a proof_of_fix step (best effort: never fails the step) and propose verified knowledge. */
export async function captureFromProof(input: {
  ownerId: number;
  runId: number;
  fixProofId: number | null;
  report: FixProofReport;
  upstream: Record<string, { output: unknown }>;
  implementFrom?: string;
}) {
  const run = await one<{ selected_repositories: string[]; inputs: Record<string, unknown> }>(
    pool,
    "SELECT selected_repositories, inputs FROM workflow_runs WHERE id=$1",
    [input.runId],
  );
  const intake = run?.inputs?.intake_item_id
    ? await one<{ signature: string | null; service: string | null }>(
        pool,
        `SELECT g.signature, COALESCE(g.service, i.service) AS service FROM intake_items i
           LEFT JOIN prod_error_groups g ON g.fingerprint = i.incident_fingerprint WHERE i.id = $1`,
        [Number(run.inputs.intake_item_id)],
      )
    : null;
  const impl = (input.implementFrom ? input.upstream[input.implementFrom]?.output : null) as {
    tested_heads?: Record<string, string>;
  } | null;
  const prs = await q<{ url: string; repo: string }>(
    pool,
    "SELECT url, repo FROM pull_requests WHERE run_id=$1 AND created",
    [input.runId],
  );
  const m = causalFromProof({
    report: input.report,
    repositories: run?.selected_repositories ?? [],
    testedHeads: impl?.tested_heads ?? {},
    errorSignatures: [intake?.signature ?? "", input.report.incident.title].filter(Boolean),
    services: intake?.service ? [intake.service] : [],
    runId: input.runId,
    fixProofId: input.fixProofId,
    pullRequests: prs,
  });
  m.validity = { ...m.validity, commits: await validityCommits(m.commits) };
  const res = await upsertCausal(input.ownerId, m);
  if (res.row.status === "verified" && !res.row.negative && !res.row.knowledge_proposal_id)
    await proposeKnowledge(res.row).catch(async (e) => {
      await q(pool, "UPDATE causal_memories SET provenance = provenance || $2 WHERE id=$1", [
        res.row.id,
        JSON.stringify({ proposal_error: (e as Error).message.slice(0, 300) }),
      ]);
    });
  return res;
}

export function renderCausal(
  m: Pick<
    CausalRow,
    | "title"
    | "root_cause"
    | "fix_approach"
    | "regression_tests"
    | "failed_approaches"
    | "repositories"
    | "verification"
    | "status"
  >,
) {
  return [
    `Incident: ${m.title}`,
    m.root_cause ? `Root cause: ${m.root_cause}` : "",
    m.fix_approach ? `Fix: ${m.fix_approach}` : "",
    m.regression_tests.length ? `Regression tests: ${m.regression_tests.join(", ")}` : "",
    ...m.failed_approaches.slice(0, 3).map((f) => `Did NOT work: ${f.approach} — ${f.why}`),
    `Verification: ${String(m.verification.verdict ?? m.status)}; repositories: ${m.repositories.join(", ") || "—"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** A verified, non-negative record becomes a PRIVATE knowledge proposal; publication follows the existing review. */
async function proposeKnowledge(row: CausalRow) {
  const { createProposal } = await import("../knowledge/proposals.ts");
  const key = `causal.${row.memory_key.slice(0, 16)}`;
  const res = await createProposal({
    ownerId: row.owner_id,
    changeType: "CREATE",
    proposed: {
      key,
      title: `Verified cause: ${row.title}`.slice(0, 200),
      category: "domain_knowledge",
      scope_type: row.repositories.length === 1 ? "REPOSITORY" : "GLOBAL",
      scope_ref: row.repositories.length === 1 ? row.repositories[0] : "",
      content: renderCausal(row),
      applicability: {
        ...(row.repositories.length ? { repos: row.repositories } : {}),
        keywords: [
          ...new Set([
            ...row.services,
            ...row.error_signatures.flatMap((s) => [...tokens(s)].slice(0, 4)),
          ]),
        ].slice(0, 12),
      },
    },
    confidence: 0.9,
    uncertainty:
      "Verified by the platform's Proof-of-Fix for this repository state; may not hold after the cited files change.",
    evidence: [
      {
        source: "proof_of_fix",
        ref: {
          run_id: row.run_id,
          fix_proof_id: (row.provenance as { fix_proof_id?: number }).fix_proof_id ?? null,
        },
        author: "platform",
        trust: "platform",
        quote: row.root_cause.slice(0, 500),
      },
    ],
    sourceKind: "workflow",
    sourceRunId: row.run_id,
    createdBy: "causal-memory",
  });
  if (res.proposal)
    await q(
      pool,
      "UPDATE causal_memories SET knowledge_proposal_id=$2, knowledge_key=$3 WHERE id=$1",
      [row.id, res.proposal.id, key],
    );
}

// ---------------------------------------------------------------- retrieval

export interface RecallQuery {
  text?: string;
  repositories?: string[];
  files?: string[];
  symbols?: string[];
  errorSignatures?: string[];
  services?: string[];
  limit?: number;
  includeOutdated?: boolean;
  /** Approximate token budget for the rendered context (≈ 4 characters per token). */
  tokenBudget?: number;
  /** Restrict to these repositories (agent step scope); defaults to everything the actor can read. */
  allowedRepositories?: string[];
}

const STRENGTH: Record<string, number> = {
  verified: 1,
  proposed: 0.7,
  hypothesis: 0.4,
  rejected: 0.6,
  outdated: 0.2,
};

/**
 * Hybrid recall over the actor's own records: exact channels (error signature, file, symbol, service, repository),
 * lexical overlap and — for records whose knowledge proposal was approved — the existing semantic index. Evidence
 * strength multiplies relevance; failed approaches come back flagged as cautions; outdated records only on request and
 * labelled. Records about repositories the actor can no longer read are withheld.
 */
export async function recallCausal(actorId: number, query: RecallQuery) {
  const readable = (await listAccessibleRepositories(actorId)).map((r) => r.repository.name);
  const allowed = query.allowedRepositories
    ? readable.filter((r) => query.allowedRepositories!.includes(r))
    : readable;
  const rows = await q<CausalRow>(
    pool,
    `SELECT * FROM causal_memories WHERE owner_id=$1 AND ($2::boolean OR status<>'outdated') ORDER BY updated_at DESC LIMIT 500`,
    [actorId, !!query.includeOutdated],
  );
  const text = [query.text ?? "", ...(query.errorSignatures ?? [])].join(" ");
  const sigs = (query.errorSignatures ?? []).map(normalizeSignature).filter(Boolean);
  let semantic: Map<string, { rank: number }> | undefined;
  const mirrored = rows.filter((r) => r.knowledge_key);
  if (text.trim() && mirrored.length) {
    const items = await q<{ id: number; key: string; version: number }>(
      pool,
      "SELECT id, key, current_version AS version FROM knowledge_items WHERE key = ANY($1) AND owner_id = $2 AND enabled",
      [mirrored.map((r) => r.knowledge_key), actorId],
    ).catch(() => []);
    if (items.length) {
      const { semanticRanksByKey } = await import("../retrieval/semantic.ts");
      semantic = await semanticRanksByKey(actorId, text, items).catch(() => undefined);
    }
  }
  const scored = rows
    .filter((r) => r.repositories.every((repo) => allowed.includes(repo)))
    .map((r) => {
      const why: string[] = [];
      let s = 0;
      const hit = (points: number, reason: string) => {
        s += points;
        why.push(reason);
      };
      if (
        sigs.some((q_) =>
          r.error_signatures.some((m) => m === q_ || m.includes(q_) || q_.includes(m)),
        )
      )
        hit(5, "error signature");
      // Stored files may be repository-qualified ("repo:path"); a query may pass either form.
      const files = (query.files ?? []).filter((f) =>
        r.files.some((rf) => rf === f || rf.endsWith(`:${f}`) || f.endsWith(`:${rf}`)),
      );
      if (files.length) hit(Math.min(6, 3 * files.length), `files ${files.join(", ")}`);
      const symbols = (query.symbols ?? []).filter(
        (x) => r.symbols.includes(x) || r.root_cause.includes(x),
      );
      if (symbols.length) hit(3, `symbols ${symbols.join(", ")}`);
      if ((query.services ?? []).some((x) => r.services.includes(x))) hit(2, "service");
      if ((query.repositories ?? []).some((x) => r.repositories.includes(x))) hit(1, "repository");
      const lex = text.trim()
        ? jaccard(
            text,
            `${r.title} ${r.root_cause} ${r.symptoms.join(" ")} ${r.incident} ${r.fix_approach}`,
          )
        : 0;
      if (lex > 0.05) hit(4 * lex + 0.5, `text ${lex.toFixed(2)}`);
      const sem = r.knowledge_key ? semantic?.get(r.knowledge_key) : undefined;
      if (sem) hit(2 / sem.rank, `semantic #${sem.rank}`);
      const strength = STRENGTH[r.negative ? "rejected" : r.status] ?? 0.4;
      // Relevance decides inclusion; evidence strength decides the order (weak or outdated records rank lower).
      return { r, relevance: s, score: s * strength, why };
    })
    .filter((x) => x.relevance >= 1.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(10, Math.max(1, Number.isFinite(query.limit) ? Number(query.limit) : 5)));
  const budget = (query.tokenBudget ?? 600) * 4;
  let used = 0;
  const items = [];
  for (const { r, score, why } of scored) {
    const label = r.negative
      ? "CAUTION — failed approach"
      : r.status === "verified"
        ? "VERIFIED"
        : r.status === "outdated"
          ? `OUTDATED (${r.invalidation_reason ?? "code changed"}) — not authoritative`
          : `${r.status.toUpperCase()} — not verified`;
    const body = `[${label}] ${renderCausal(r)}`;
    const cut = body.slice(0, Math.max(0, budget - used));
    if (!cut) break;
    used += cut.length;
    items.push({
      id: r.id,
      status: r.status,
      negative: r.negative,
      authoritative: r.status === "verified" && !r.negative,
      score: Math.round(score * 100) / 100,
      why,
      version: r.version,
      run_id: r.run_id,
      repositories: r.repositories,
      text: cut,
    });
  }
  return { items, tokens_estimate: Math.ceil(used / 4) };
}

// ---------------------------------------------------------------- lifecycle

/**
 * Invalidation: a verified/proposed record whose cited files changed on the repository base since the recorded commit
 * becomes "outdated" (persisted, versioned, reason kept). Bounded per pass; repositories without a checkout are skipped.
 */
export async function invalidateCausalMemories(limit = 50) {
  // Cursor order: never-checked first, then least recently checked — every record is reached in turn.
  const rows = await q<CausalRow & { checked_at: string | null }>(
    pool,
    `SELECT * FROM causal_memories WHERE status IN ('verified','proposed') AND validity ? 'commits'
      AND cardinality(files) > 0 ORDER BY checked_at NULLS FIRST, id LIMIT $1`,
    [limit],
  );
  const { checkoutOf, baseCommit } = await import("../impact/index.ts");
  const { repositoryBaseBranch } = await import("../repos/service.ts");
  let outdated = 0;
  for (const r of rows) {
    const commits = (r.validity.commits ?? {}) as Record<string, string>;
    const changed: string[] = [];
    const single = Object.keys(commits).length === 1;
    for (const [repo, sha] of Object.entries(commits)) {
      if (!/^[0-9a-f]{7,40}$/.test(sha)) continue;
      const path = await checkoutOf(repo).catch(() => null);
      if (!path) continue;
      const head = await baseCommit(path, await repositoryBaseBranch(repo));
      if (!head || head === sha) continue;
      // This repository's own files ("repo:path"; unqualified paths only when the record has one repository).
      const files = r.files.flatMap((f) =>
        f.startsWith(`${repo}:`)
          ? [f.slice(repo.length + 1)]
          : !f.includes(":") && single
            ? [f]
            : [],
      );
      if (!files.length) continue;
      // A sha the checkout does not have cannot be compared: unknown, never "changed".
      const known = await exec("git", ["-C", path, "cat-file", "-e", `${sha}^{commit}`], {
        timeout: 10_000,
      }).then(
        () => true,
        () => false,
      );
      if (!known) continue;
      const out = await exec(
        "git",
        ["-C", path, "diff", "--name-only", sha, head, "--", ...files.map((f) => `:(literal)${f}`)],
        {
          timeout: 20_000,
        },
      )
        .then((x) => x.stdout.split("\n").filter(Boolean))
        .catch(() => []);
      changed.push(...out.map((f) => `${repo}:${f}`));
    }
    await withTx(async (c) => {
      if (!changed.length) {
        await q(c, "UPDATE causal_memories SET checked_at=now() WHERE id=$1", [r.id]);
        return;
      }
      const row = await one<CausalRow>(
        c,
        "UPDATE causal_memories SET status='outdated',version=version+1,checked_at=now(),invalidated_at=now(),invalidation_reason=$2,updated_at=now() WHERE id=$1 AND status IN ('verified','proposed') RETURNING *",
        [r.id, `cited files changed: ${changed.slice(0, 5).join(", ")}`.slice(0, 300)],
      );
      if (row) {
        await snapshot(c, row, "outdated after code change", null);
        await retractProposal(c, row, "cited code changed");
        outdated++;
      }
    });
  }
  return { checked: rows.length, outdated };
}

/**
 * Human correction by the owner (verify after review, reject, mark outdated, reopen), versioned and audited. It is
 * also how an open contradiction is resolved; a correction that makes the record non-authoritative retracts its
 * pending knowledge proposal.
 */
export async function setCausalStatus(
  actorId: number,
  id: number,
  status: CausalStatus,
  reason: string,
) {
  if (!CAUSAL_STATUSES.includes(status)) throw new HttpError(400, "invalid status");
  if (!reason.trim()) throw new HttpError(400, "a reason is required");
  return withTx(async (c) => {
    const row = await one<CausalRow>(
      c,
      `UPDATE causal_memories SET status=$3,version=version+1,
         provenance=(provenance || jsonb_build_object('human_correction', jsonb_build_object('by', $2::bigint, 'reason', $4::text, 'at', now())))
           #- '{contradiction,unresolved}',
         invalidation_reason=CASE WHEN $3='outdated' THEN $4 ELSE invalidation_reason END,
         invalidated_at=CASE WHEN $3='outdated' THEN now() ELSE NULL END,updated_at=now()
       WHERE id=$1 AND owner_id=$2 RETURNING *`,
      [id, actorId, status, reason.slice(0, 500)],
    );
    if (!row) throw new HttpError(404, "not found");
    await snapshot(c, row, `human: ${status} — ${reason.slice(0, 200)}`, actorId);
    if (status !== "verified") await retractProposal(c, row, `human: ${status}`);
    await q(
      c,
      "INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES($1,'causal_memory.status','causal_memory',$2,$3)",
      [actorId, String(id), JSON.stringify({ status, reason: reason.slice(0, 200) })],
    );
    return row;
  });
}

/** Restore an earlier version as a NEW version (history is never rewritten). Owner only. */
export async function rollbackCausal(actorId: number, id: number, version: number) {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new HttpError(400, "version must be a positive integer");
  return withTx(async (c) => {
    const cur = await one<CausalRow>(
      c,
      "SELECT * FROM causal_memories WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [id, actorId],
    );
    if (!cur) throw new HttpError(404, "not found");
    const v = await one<{ snapshot: CausalRow & { invalidated_at?: string | null } }>(
      c,
      "SELECT snapshot FROM causal_memory_versions WHERE memory_id=$1 AND version=$2",
      [id, version],
    );
    if (!v) throw new HttpError(404, "version not found");
    const keys = COLUMNS.filter((k) => k !== "run_id" && k !== "fix_proof_id");
    const snap = v.snapshot as unknown as Record<string, unknown>;
    const row = (await one<CausalRow>(
      c,
      `UPDATE causal_memories SET version=$2,${keys.map((k, i) => `${k}=$${i + 3}`).join(",")},
         invalidated_at=$${keys.length + 3}::timestamptz,invalidation_reason=$${keys.length + 4}::text,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [
        id,
        cur.version + 1,
        ...keys.map((k) => val(k, snap[k])),
        snap.invalidated_at ?? null,
        snap.invalidation_reason ?? null,
      ],
    ))!;
    await snapshot(c, row, `rollback to version ${version}`, actorId);
    if (row.status !== "verified") await retractProposal(c, row, `rollback to version ${version}`);
    await q(
      c,
      "INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES($1,'causal_memory.rollback','causal_memory',$2,$3)",
      [actorId, String(id), JSON.stringify({ to_version: version, new_version: row.version })],
    );
    return row;
  });
}

export async function causalHistory(actorId: number, id: number) {
  const cur = await one<CausalRow>(
    pool,
    "SELECT * FROM causal_memories WHERE id=$1 AND owner_id=$2",
    [id, actorId],
  );
  if (!cur) throw new HttpError(404, "not found");
  const versions = await q(
    pool,
    "SELECT version, change, actor_id, created_at FROM causal_memory_versions WHERE memory_id=$1 ORDER BY version",
    [id],
  );
  return { memory: cur, versions };
}
