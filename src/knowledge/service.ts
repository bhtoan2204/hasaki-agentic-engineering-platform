import { pool, q, one, withTx, json, inTx, txWrote, type Db } from "../db/pool.ts";
import { CacheAside } from "../cache/index.ts";
import { CATEGORIES, SCOPES, type KnowledgeCandidate } from "./resolve.ts";

export interface KnowledgeInput {
  key: string;
  category: string;
  scope_type: string;
  scope_ref?: string;
  title: string;
  conflict_key?: string | null;
  priority?: number;
  enforced?: boolean;
  enabled?: boolean;
  content: string;
  applicability?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  change_note?: string;
  created_by?: string;
  /** Null is shared team knowledge. A number is that user's private item. */
  ownerId?: number | null;
  /** The new version takes effect at this instant (ISO); null/absent = immediately. */
  effective_from?: string | null;
}

function check(x: Partial<KnowledgeInput>) {
  if (x.category && !(CATEGORIES as readonly string[]).includes(x.category)) throw new Error(`unknown category ${x.category}`);
  if (x.scope_type && !(SCOPES as readonly string[]).includes(x.scope_type)) throw new Error(`unknown scope ${x.scope_type}`);
  if (x.scope_type && x.scope_type !== "GLOBAL" && !x.scope_ref) throw new Error(`scope ${x.scope_type} needs scope_ref`);
}

export const knowledge = {
  list(filter: { category?: string; ownerId?: number; all?: boolean } = {}, db: Db = pool) {
    const scoped = filter.ownerId != null || filter.all === true;
    return q(
      db,
      `SELECT i.*, v.content, v.applicability, v.metadata, v.created_at AS version_created_at
         FROM knowledge_items i LEFT JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version
        WHERE ($1::text IS NULL OR i.category = $1)
          AND (
            ($2::bool AND i.owner_id IS NULL)
            OR ($3::bool AND (i.owner_id IS NULL OR i.owner_id = $4))
            OR ($5::bool)
          )
        ORDER BY i.category, i.scope_type, i.owner_id NULLS FIRST, i.key`,
      [filter.category ?? null, !scoped, filter.ownerId != null && !filter.all, filter.ownerId ?? null, !!filter.all],
    );
  },

  /** Shared item when ownerId is omitted. Pass the owner to read that user's private item. */
  async get(key: string, db: Db = pool, ownerId: number | null = null) {
    const item = await one(db, "SELECT * FROM knowledge_items WHERE key = $1 AND owner_id IS NOT DISTINCT FROM $2", [key, ownerId]);
    if (!item) return undefined;
    const versions = await q(db, "SELECT * FROM knowledge_versions WHERE item_id = $1 ORDER BY version DESC", [item.id]);
    const audit = await q(db, "SELECT * FROM knowledge_audit WHERE item_id = $1 ORDER BY id DESC LIMIT 100", [item.id]);
    // Supersession both ways, plus the version in effect now (a later approved version may take effect in the future).
    const superseded_by = item.superseded_by ? ((await one(db, "SELECT key, title, enabled FROM knowledge_items WHERE id = $1", [item.superseded_by])) ?? null) : null;
    const supersedes = await q(db, "SELECT key, title, enabled, superseded_at FROM knowledge_items WHERE superseded_by = $1 ORDER BY key", [item.id]);
    const now = Date.now();
    const effective_version =
      versions.find((v: any) => v.version <= item.current_version && (!v.effective_from || new Date(v.effective_from).getTime() <= now))?.version ?? null;
    return { ...item, versions, audit, superseded_by_item: superseded_by, supersedes, effective_version };
  },

  /** `db`: run inside the caller's transaction (proposal approval), else a new one. */
  async create(x: KnowledgeInput, db?: Db) {
    check(x);
    const run = <T>(fn: (c: Db) => Promise<T>) => (db ? fn(db) : withTx(fn));
    return run(async (c) => {
      const scopeRef = x.scope_type === "GLOBAL" ? "" : (x.scope_ref ?? "");
      const item = await one(
        c,
        `INSERT INTO knowledge_items (key, category, scope_type, scope_ref, title, conflict_key, priority, enforced, enabled, current_version, owner_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10) RETURNING *`,
        [x.key, x.category, x.scope_type, scopeRef, x.title, x.conflict_key || null, x.priority ?? 0, x.enforced ?? false, x.enabled ?? true, x.ownerId ?? null],
      );
      await q(c, `INSERT INTO knowledge_versions (item_id, version, content, applicability, metadata, change_note, created_by, effective_from) VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`, [
        item.id,
        x.content,
        json(x.applicability ?? {}),
        json(x.metadata ?? {}),
        x.change_note ?? "created",
        x.created_by ?? "",
        x.effective_from ?? null,
      ]);
      await q(c, "INSERT INTO knowledge_audit (item_id, action, detail) VALUES ($1, 'created', $2)", [item.id, json({ scope: x.scope_type, scope_ref: scopeRef })]);
      return knowledge.get(x.key, c, x.ownerId ?? null);
    });
  },

  /**
   * Content/applicability/metadata changes create a new version (history is never rewritten);
   * item attribute changes (scope, enabled, priority...) are recorded in the audit log.
   */
  async update(key: string, x: Partial<KnowledgeInput>, ownerId: number | null = null, db?: Db) {
    check(x);
    const run = <T>(fn: (c: Db) => Promise<T>) => (db ? fn(db) : withTx(fn));
    return run(async (c) => {
      const item = await one(c, "SELECT * FROM knowledge_items WHERE key = $1 AND owner_id IS NOT DISTINCT FROM $2 FOR UPDATE", [key, ownerId]);
      if (!item) throw new Error(`knowledge item "${key}" not found`);
      const cur = await one(c, "SELECT * FROM knowledge_versions WHERE item_id = $1 AND version = $2", [item.id, item.current_version]);
      const content = x.content ?? cur.content;
      const applicability = x.applicability ?? cur.applicability;
      const metadata = x.metadata ?? cur.metadata;
      if (content !== cur.content || json(applicability) !== json(cur.applicability) || json(metadata) !== json(cur.metadata) || (x.effective_from ?? null) !== null) {
        const version = item.current_version + 1;
        await q(c, `INSERT INTO knowledge_versions (item_id, version, content, applicability, metadata, change_note, created_by, effective_from) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
          item.id,
          version,
          content,
          json(applicability),
          json(metadata),
          x.change_note ?? "",
          x.created_by ?? "",
          x.effective_from ?? null,
        ]);
        await q(c, "UPDATE knowledge_items SET current_version = $2, updated_at = now() WHERE id = $1", [item.id, version]);
        await q(c, "INSERT INTO knowledge_audit (item_id, action, detail) VALUES ($1, 'version', $2)", [item.id, json({ version, note: x.change_note ?? "", ...(x.effective_from ? { effective_from: x.effective_from } : {}) })]);
      }
      const attrs = (["title", "scope_type", "scope_ref", "conflict_key", "priority", "enforced", "enabled"] as const).filter(
        (k) => x[k] !== undefined && x[k] !== item[k],
      );
      if (attrs.length) {
        const vals = attrs.map((k) => (k === "conflict_key" ? x[k] || null : k === "scope_ref" && (x.scope_type ?? item.scope_type) === "GLOBAL" ? "" : x[k]));
        await q(c, `UPDATE knowledge_items SET ${attrs.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [item.id, ...vals]);
        const action = attrs.length === 1 && attrs[0] === "enabled" ? (x.enabled ? "enabled" : "disabled") : "updated";
        await q(c, "INSERT INTO knowledge_audit (item_id, action, detail) VALUES ($1, $2, $3)", [
          item.id,
          action,
          json(Object.fromEntries(attrs.map((k) => [k, { from: item[k], to: x[k] }]))),
        ]);
      }
      return knowledge.get(key, c, ownerId);
    });
  },

  /**
   * Enabled items the run may see: shared knowledge plus that owner's private items.
   * Applicability scope (GLOBAL, REPOSITORY, …) is not visibility.
   * Each item comes at the version IN EFFECT at `at`: the newest version up to current_version whose effective_from has
   * passed (an approved rule dated in the future does not apply yet; an item with no version in effect is left out).
   * `superseded_by` is the successor's key while that successor is enabled.
   */
  async candidates(db: Db = pool, ownerId?: number | null, at: Date = new Date()): Promise<KnowledgeCandidate[]> {
    // Cached per owner (read on every step attempt). Bypassed inside a transaction that wrote knowledge itself.
    const wrote = inTx(db) && (txWrote(db, "knowledge_items") || txWrote(db, "knowledge_versions"));
    if (!wrote) {
      const snap = await candidateCache.get(String(ownerId ?? ""), () => loadCandidateSet(db, ownerId ?? null));
      // Versions older than the one in effect at load time were dropped: an instant before that needs the database.
      if (at.getTime() >= snap.loadedAt - 1000) return pickEffective(snap.items, at);
    }
    return q<KnowledgeCandidate>(
      db,
      `SELECT i.key, i.title, i.category, i.scope_type, i.scope_ref, i.conflict_key, i.priority, i.enforced, i.expires_at,
              v.version, v.content, v.applicability, v.metadata, v.effective_from, s.key AS superseded_by
         FROM knowledge_items i
         JOIN LATERAL (
              SELECT * FROM knowledge_versions kv
               WHERE kv.item_id = i.id AND kv.version <= i.current_version AND (kv.effective_from IS NULL OR kv.effective_from <= $2)
               ORDER BY kv.version DESC LIMIT 1) v ON true
         LEFT JOIN knowledge_items s ON s.id = i.superseded_by AND s.enabled
        WHERE i.enabled AND (i.owner_id IS NULL OR ($1::bigint IS NOT NULL AND i.owner_id = $1))`,
      [ownerId ?? null, at],
    );
  },
};

// ---------------------------------------------------------------- candidate cache

interface CandidateSet {
  loadedAt: number;
  items: Array<Omit<KnowledgeCandidate, "version" | "content" | "applicability" | "metadata" | "effective_from"> & {
    versions: Array<{ version: number; content: string; applicability: any; metadata: any; effective_from: string | null }>;
  }>;
}
const candidateCache = new CacheAside<CandidateSet>("knowledge.candidates", ["knowledge_items", "knowledge_versions"], 60_000, 200);

/**
 * Every enabled visible item with the versions that can still be in effect: the one in effect now and newer ones
 * dated in the future (time only moves forward, so older versions can never be selected again).
 */
async function loadCandidateSet(db: Db, ownerId: number | null): Promise<CandidateSet> {
  const loadedAt = Date.now();
  const items = await q(
    db,
    `SELECT i.key, i.title, i.category, i.scope_type, i.scope_ref, i.conflict_key, i.priority, i.enforced, i.expires_at, s.key AS superseded_by,
            (SELECT json_agg(json_build_object('version', v.version, 'content', v.content, 'applicability', v.applicability, 'metadata', v.metadata,
                                               'effective_from', v.effective_from) ORDER BY v.version DESC)
               FROM knowledge_versions v
              WHERE v.item_id = i.id AND v.version <= i.current_version
                AND v.version >= COALESCE((SELECT max(e.version) FROM knowledge_versions e
                                            WHERE e.item_id = i.id AND e.version <= i.current_version AND (e.effective_from IS NULL OR e.effective_from <= $2)), 0)
            ) AS versions
       FROM knowledge_items i LEFT JOIN knowledge_items s ON s.id = i.superseded_by AND s.enabled
      WHERE i.enabled AND (i.owner_id IS NULL OR ($1::bigint IS NOT NULL AND i.owner_id = $1))`,
    [ownerId, new Date(loadedAt)],
  );
  return { loadedAt, items: items.map((r) => ({ ...r, versions: r.versions ?? [] })) };
}

/** Same selection as the SQL path: per item the newest version whose effective_from has passed; none → left out. */
function pickEffective(items: CandidateSet["items"], at: Date): KnowledgeCandidate[] {
  const t = at.getTime();
  const out: KnowledgeCandidate[] = [];
  for (const { versions, ...it } of items) {
    const v = versions.find((x) => !x.effective_from || new Date(x.effective_from).getTime() <= t);
    if (v) out.push({ ...it, version: v.version, content: v.content, applicability: v.applicability ?? {}, metadata: v.metadata ?? {}, effective_from: v.effective_from } as KnowledgeCandidate);
  }
  return out;
}

/** A few starter items so a fresh install shows how scopes and skills work. Only inserted when missing. */
export async function seedKnowledge() {
  const seeds: KnowledgeInput[] = [
    {
      key: "commit-convention",
      category: "repository_convention",
      scope_type: "ORGANIZATION",
      scope_ref: "hasaki",
      title: "Hasaki commit convention (TECH-HD-001)",
      content:
        "Commit message: `<type>(<scope>): <imperative summary, < 50 chars>`, blank line, body explaining WHY, then footer lines " +
        "`func: <FUNCTION_CODE>` (only if the task or git log of the touched files gives a real code; never invent one) and " +
        "`task: <task code>`. Types: feat | fix | refactor | perf | test | docs | style | build | ci | chore. No Co-Authored-By trailer.",
      applicability: { step_types: ["coding_agent"] },
    },
    {
      key: "no-secrets-in-code",
      category: "security_policy",
      scope_type: "GLOBAL",
      title: "Never commit secrets or customer PII",
      conflict_key: "security.secrets",
      enforced: true,
      content: "Never commit credentials, tokens, private keys or customer personal data (phone, address, email) to code, tests, logs or PR text.",
    },
    {
      key: "security-review",
      category: "agent_skill",
      scope_type: "GLOBAL",
      title: "Security Review",
      content:
        "Check: injection (SQL, command, template), missing authorization on new endpoints, secrets in code/config, PII in logs, " +
        "unsafe deserialisation, SSRF in outbound calls, missing input validation at trust boundaries. Report each finding with " +
        "severity, file:line, exploit scenario and a concrete fix.",
      metadata: { required_tools: ["Read", "Grep", "Glob"], output_contract: "{ findings: [{ severity, file, line, issue, suggestion }] }" },
    },
    {
      key: "latency-service-boundaries",
      category: "agent_skill",
      scope_type: "GLOBAL",
      title: "Latency & Service Boundaries",
      content: [
        "Before adding a synchronous call to another service:",
        "1. Trace the request path end to end and list the data each step needs.",
        "2. Check whether that data is already available locally: in the incoming request/payload, in domain state already loaded",
        "   for this request, or in a database owned by the current service.",
        "3. Prefer local handling when the local data is sufficient AND meets the requirements for freshness, consistency and",
        "   ownership (the owning service remains the source of truth; do not copy data you do not own just to avoid a call).",
        "",
        "If a call to another service is still needed:",
        "- State why (freshness, consistency, ownership, missing data).",
        "- Reuse results already fetched within the same request; batch calls; run independent calls in parallel.",
        "- Report the number of sequential round trips before and after the change (e.g. 3 → 1).",
        "- Quote latency in milliseconds only when it was measured (logs, traces, benchmarks); otherwise say it is unmeasured.",
      ].join("\n"),
      metadata: {
        description: "Avoid unnecessary synchronous service calls: trace the request path, use data already in the request/domain/own DB, justify remaining calls, batch/parallelize, report round trips (ms only when measured).",
        required_tools: ["Read", "Grep", "Glob"],
        output_contract: "{ call_analysis: [{ call, needed: boolean, reason, data_source }], round_trips: { before, after }, latency_ms_measured?: number }",
      },
    },
    {
      key: "unit-test-generation",
      category: "agent_skill",
      scope_type: "GLOBAL",
      title: "Unit Test Generation",
      content:
        "Write table-driven tests next to the code under test, covering the happy path, each error branch and boundary values. " +
        "Prefer real collaborators over mocks unless they cross a process boundary.",
      metadata: { required_tools: ["Read", "Edit", "Write", "Bash"] },
    },
  ];
  for (const s of seeds) if (!(await knowledge.get(s.key))) await knowledge.create({ ...s, change_note: "seed" });
}
