import { createHash } from "node:crypto";
import { HttpError } from "../http/error.ts";
import { pool, q, one, withTx, json, type Db } from "../db/pool.ts";
import { knowledge } from "./service.ts";
import { CATEGORIES, SCOPES } from "./resolve.ts";

/**
 * Knowledge evolution lifecycle (deterministic; the only path that turns a detected change into authoritative knowledge).
 *
 *   detected change ──► knowledge_proposals (pending) ──► human approves ──► registry write (new version / new item +
 *   supersession / deprecation) ──► future runs resolve it;  approved ──► rollback (new version restoring the old text,
 *   supersession undone). History is never rewritten: every change is a version or an audit row, and context snapshots
 *   keep exactly what each past attempt was given.
 *
 * Change types
 *   UPDATE     same item, new version (same scope). Optional effective_from: the old version keeps applying until then.
 *   SUPERSEDE  new item (often narrower scope: one project / market / provider) that replaces the target wherever it
 *              applies; the target keeps applying elsewhere. The new item inherits the target's conflict_key.
 *   DEPRECATE  the target stops applying (now, or at effective_from).
 *   CREATE     a new item.
 *
 * Safety rules
 *   - Enforced items and security policies are never changed through proposals.
 *   - A proposal is made against a target version; approving it after the target changed needs an explicit
 *     acceptCurrentVersion (the reviewer saw the newer text).
 *   - Approval and rollback lock the proposal and the target rows: concurrent approvals apply once, the second gets the
 *     already-approved proposal back (idempotent).
 *   - Open proposals are deduplicated on dedupe_key (target + scope + substance); a repeat adds its evidence instead.
 */

export type ChangeType = "CREATE" | "UPDATE" | "SUPERSEDE" | "DEPRECATE";
export const AUDIT_ACTOR = "system:knowledge-audit";

type Coverage = {
  scope_type: string;
  scope_ref?: string | null;
  conflict_key?: string | null;
  applicability?: object | null;
};
/** Items cover the same targets: same scope, conflict key and applicability (key order ignored). */
export function duplicateCoverage(items: Coverage[]): boolean {
  const canonical = items[0];
  return items.every(
    (i) =>
      i.scope_type === canonical.scope_type &&
      (i.scope_ref ?? "") === (canonical.scope_ref ?? "") &&
      (i.conflict_key ?? null) === (canonical.conflict_key ?? null) &&
      JSON.stringify(Object.entries(i.applicability ?? {}).sort()) ===
        JSON.stringify(Object.entries(canonical.applicability ?? {}).sort()),
  );
}
export function isLive(
  item: { expires_at?: string | Date | null; effective_from?: string | Date | null },
  now = new Date(),
): boolean {
  return (
    (!item.expires_at || new Date(item.expires_at) > now) &&
    (!item.effective_from || new Date(item.effective_from) <= now)
  );
}
export const CHANGE_TYPES: ChangeType[] = ["CREATE", "UPDATE", "SUPERSEDE", "DEPRECATE"];
export type ProposalStatus = "pending" | "approved" | "rejected" | "rolled_back" | "obsolete";
/** Categories a proposal may create or change. Security policies stay human-authored. */
export const EVOLVABLE: string[] = CATEGORIES.filter(
  (c) => c !== "security_policy" && c !== "task_memory",
);

export interface Evidence {
  /** answer | approval_comment | reexecute_feedback | requirement | proposal | repository_file | reviewer */
  source: string;
  /** Where it came from: { run_id, step, question_id, attempt, path, proposal_id, … } */
  ref: Record<string, unknown>;
  author: string;
  /** human: an authenticated user wrote it; requirement: the work item (BA ticket); platform: derived by the platform. */
  trust: "human" | "requirement" | "platform";
  quote: string;
}

export interface ProposedChange {
  superseded_by?: string;
  canonical_version?: number;
  canonical_sha256?: string;
  key?: string;
  title?: string;
  category?: string;
  scope_type?: string;
  scope_ref?: string;
  conflict_key?: string | null;
  content?: string;
  applicability?: Record<string, unknown>;
  effective_from?: string | null;
}

export interface ProposalInput {
  auditReviewOnly?: boolean;
  ownerId: number | null;
  parentId?: number | null;
  changeType: ChangeType;
  targetKey?: string | null;
  proposed: ProposedChange;
  domain?: string;
  confidence?: number;
  uncertainty?: string;
  evidence: Evidence[];
  impacts?: Record<string, unknown>;
  validation?: {
    passed: boolean;
    checks: Array<{ name: string; passed: boolean; detail: string }>;
  } | null;
  sourceKind?: "workflow" | "skill_evolution" | "repository_import" | "manual" | "failure_pattern";
  sourceRunId?: number | null;
  createdBy?: string;
}

// ---------------------------------------------------------------- pure helpers

const norm = (s: string) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Identifier-like terms of a rule: snake_case, camelCase, dotted paths and `backticked` names (field and function names
 * are what a business-rule change usually swaps: line_amount → platform_price). Lower-cased.
 */
export function ruleTerms(text: string): Set<string> {
  const out = new Set<string>();
  const s = String(text ?? "");
  for (const m of s.matchAll(/`([^`\n]{2,60})`/g)) out.add(m[1].trim().toLowerCase());
  for (const m of s.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[_.][A-Za-z0-9]+)+\b/g))
    out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g)) out.add(m[0].toLowerCase());
  return out;
}

/** Terms the new rule drops (removed) and introduces (added) compared with the old one. */
export function termChange(oldRule: string, newRule: string) {
  const a = ruleTerms(oldRule),
    b = ruleTerms(newRule);
  return {
    removed: [...a].filter((t) => !b.has(t)).sort(),
    added: [...b].filter((t) => !a.has(t)).sort(),
  };
}

export interface DiffLine {
  op: " " | "-" | "+";
  line: string;
}
/** Line diff (LCS). Inputs are capped so a review never computes a huge table. */
export function lineDiff(before: string, after: string, maxLines = 800): DiffLine[] {
  const a = String(before ?? "")
      .split("\n")
      .slice(0, maxLines),
    b = String(after ?? "")
      .split("\n")
      .slice(0, maxLines);
  const n = a.length,
    m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) (out.push({ op: " ", line: a[i] }), i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", line: a[i++] });
    else out.push({ op: "+", line: b[j++] });
  }
  while (i < n) out.push({ op: "-", line: a[i++] });
  while (j < m) out.push({ op: "+", line: b[j++] });
  return out;
}

/**
 * Same target + same scope + same substance → same open proposal. Substance is the set of terms the change introduces
 * (two wordings of "use platform_price" collapse), or the normalized text when the rule has no identifiers.
 */
export function dedupeKey(x: {
  changeType: ChangeType;
  targetKey?: string | null;
  proposed: ProposedChange;
  existingRule?: string;
  parentId?: number | null;
}) {
  const p = x.proposed;
  const scope = `${p.scope_type ?? ""}:${norm(p.scope_ref ?? "")}`;
  const added = termChange(x.existingRule ?? "", p.content ?? "").added;
  const substance =
    x.changeType === "DEPRECATE"
      ? "deprecate"
      : added.length
        ? `terms:${added.join(",")}`
        : `text:${sha(norm(p.content ?? ""))}`;
  const target = x.targetKey ?? `new:${norm(p.title ?? p.key ?? "")}`;
  return sha(
    [
      x.changeType,
      target,
      scope,
      substance,
      p.effective_from ?? "",
      x.parentId ? `parent:${x.parentId}` : "",
    ].join("|"),
  );
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 80);

function validateProposed(changeType: ChangeType, p: ProposedChange, needContent: boolean) {
  if (p.category && !EVOLVABLE.includes(p.category))
    throw new HttpError(400, `category ${p.category} cannot be changed through a proposal`);
  if (p.scope_type && !(SCOPES as readonly string[]).includes(p.scope_type))
    throw new HttpError(400, `unknown scope ${p.scope_type}`);
  if (p.scope_type && p.scope_type !== "GLOBAL" && !p.scope_ref)
    throw new HttpError(400, `scope ${p.scope_type} needs scope_ref`);
  if (needContent && changeType !== "DEPRECATE" && !String(p.content ?? "").trim())
    throw new HttpError(400, "the proposed rule has no content");
  if (
    p.effective_from != null &&
    p.effective_from !== "" &&
    Number.isNaN(new Date(p.effective_from).getTime())
  )
    throw new HttpError(400, `invalid effective_from "${p.effective_from}"`);
}

// ---------------------------------------------------------------- create / read

/**
 * Store a proposal. Returns `{ proposal, created }`; `created: false` when an open duplicate absorbed it (its evidence is
 * merged), when the same change is already approved, or when the target already says exactly this (`proposal: null`).
 */
export async function createProposal(
  x: ProposalInput,
  db: Db = pool,
): Promise<{ proposal: any | null; created: boolean; reason?: string }> {
  if (!CHANGE_TYPES.includes(x.changeType))
    throw new HttpError(400, `unknown change type ${x.changeType}`);
  if (!x.evidence.length) throw new HttpError(400, "a proposal needs evidence");
  let target: any = null;
  if (x.changeType !== "CREATE") {
    if (!x.targetKey) throw new HttpError(400, `${x.changeType} needs the existing item (target)`);
    target = await one(
      db,
      "SELECT i.*, v.content, v.applicability, v.metadata FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version WHERE i.key = $1 AND (i.owner_id IS NULL OR i.owner_id IS NOT DISTINCT FROM $2) ORDER BY i.owner_id NULLS LAST LIMIT 1",
      [x.targetKey, x.ownerId],
    );
    if (!target) throw new HttpError(404, `knowledge item "${x.targetKey}" not found`);
    if (target.enforced || target.category === "security_policy")
      throw new HttpError(
        409,
        `"${target.key}" is an enforced/security item: change it by hand, not through a proposal`,
      );
  }
  const proposed: ProposedChange = {
    ...x.proposed,
    category: x.proposed.category ?? target?.category ?? "business_rule",
    scope_type: x.proposed.scope_type ?? target?.scope_type ?? "GLOBAL",
    scope_ref:
      (x.proposed.scope_type ?? target?.scope_type ?? "GLOBAL") === "GLOBAL"
        ? ""
        : (x.proposed.scope_ref ?? target?.scope_ref ?? ""),
    effective_from: x.proposed.effective_from || null,
  };
  validateProposed(
    x.changeType,
    x.auditReviewOnly && x.changeType === "DEPRECATE"
      ? { ...proposed, category: undefined }
      : proposed,
    true,
  );
  if (
    target &&
    x.changeType === "UPDATE" &&
    norm(target.content) === norm(proposed.content ?? "") &&
    !proposed.effective_from
  )
    return { proposal: null, created: false, reason: "the target already says this" };
  const existingRule = target?.content ?? "";
  const key = dedupeKey({
    changeType: x.changeType,
    targetKey: target?.key ?? null,
    proposed,
    existingRule,
    parentId: x.parentId,
  });
  const done = await one(
    db,
    "SELECT * FROM knowledge_proposals WHERE dedupe_key = $1 AND status = 'approved' ORDER BY id DESC LIMIT 1",
    [key],
  );
  if (done)
    return { proposal: done, created: false, reason: `already approved as proposal #${done.id}` };
  const confidence = Math.max(0, Math.min(1, Number(x.confidence ?? 0.5) || 0));
  // Insert, or fold into the open duplicate: evidence is appended (deduplicated by quote+source), confidence kept at the max.
  const row = await one(
    db,
    `INSERT INTO knowledge_proposals (owner_id, parent_id, change_type, target_item_id, target_key, target_version, existing_rule, proposed, domain, confidence, uncertainty,
                                      evidence, impacts, validation, source_kind, source_run_id, dedupe_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (dedupe_key) WHERE status = 'pending' DO UPDATE SET
       evidence = knowledge_proposals.evidence || (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(EXCLUDED.evidence) e
                                                    WHERE NOT knowledge_proposals.evidence @> jsonb_build_array(e)),
       confidence = GREATEST(knowledge_proposals.confidence, EXCLUDED.confidence),
       updated_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [
      x.ownerId,
      x.parentId ?? null,
      x.changeType,
      target?.id ?? null,
      target?.key ?? null,
      target?.current_version ?? null,
      existingRule,
      json(proposed),
      x.domain ?? "",
      confidence,
      x.uncertainty ?? "",
      json(x.evidence),
      json(x.impacts ?? {}),
      x.validation ? json(x.validation) : null,
      x.sourceKind ?? "workflow",
      x.sourceRunId ?? null,
      key,
      x.createdBy ?? "",
    ],
  );
  const { inserted, ...proposal } = row;
  return {
    proposal,
    created: !!inserted,
    reason: inserted ? undefined : `merged into open proposal #${proposal.id}`,
  };
}

export async function listProposals(
  filter: { ownerId: number; all?: boolean; status?: string; runId?: number; targetKey?: string },
  db: Db = pool,
) {
  return q(
    db,
    `SELECT p.id, p.status, p.change_type, p.target_key, p.target_version, p.proposed, p.domain, p.confidence, p.source_kind, p.source_run_id, p.parent_id,
            p.owner_id, p.created_at, p.updated_at, p.reviewed_by, p.reviewed_at, jsonb_array_length(p.evidence) AS evidence_count,
            p.validation->>'passed' AS validation_passed, r.title AS run_title
       FROM knowledge_proposals p LEFT JOIN workflow_runs r ON r.id = p.source_run_id
      WHERE ($1::text IS NULL OR p.status = $1)
        AND ($2::bigint IS NULL OR p.source_run_id = $2)
        AND ($3::text IS NULL OR p.target_key = $3 OR p.proposed->>'key' = $3 OR p.applied->>'created_key' = $3)
        AND ($4::bool OR p.owner_id = $5 OR p.owner_id IS NULL)
      ORDER BY (p.status = 'pending') DESC, p.id DESC LIMIT 300`,
    [
      filter.status ?? null,
      filter.runId ?? null,
      filter.targetKey ?? null,
      !!filter.all,
      filter.ownerId,
    ],
  );
}

/** Proposal with what a reviewer needs: old vs new text and diff, target state now, children (skill updates), conflicts. */
export async function getProposal(id: number, db: Db = pool) {
  const p = await one(db, "SELECT * FROM knowledge_proposals WHERE id = $1", [id]);
  if (!p) return undefined;
  const target = p.target_item_id
    ? await one(
        db,
        "SELECT i.id, i.key, i.title, i.category, i.scope_type, i.scope_ref, i.current_version, i.enabled, i.owner_id, i.superseded_by, i.expires_at, v.content FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version WHERE i.id = $1",
        [p.target_item_id],
      )
    : null;
  const children = await q(
    db,
    "SELECT id, status, change_type, target_key, validation, created_at FROM knowledge_proposals WHERE parent_id = $1 ORDER BY id",
    [id],
  );
  const parent = p.parent_id
    ? await one(
        db,
        "SELECT id, status, change_type, target_key, proposed FROM knowledge_proposals WHERE id = $1",
        [p.parent_id],
      )
    : null;
  const newText = p.change_type === "DEPRECATE" ? "" : String(p.proposed?.content ?? "");
  return {
    ...p,
    target,
    target_changed:
      !!target &&
      p.status === "pending" &&
      p.target_version != null &&
      target.current_version !== p.target_version,
    diff: lineDiff(p.existing_rule ?? "", newText),
    terms: termChange(p.existing_rule ?? "", newText),
    children,
    parent,
  };
}

// ---------------------------------------------------------------- approve / reject / rollback

/** A key no item uses yet, private or shared (one key never means two different rules to different readers). */
async function uniqueKey(c: Db, base: string) {
  const root = slug(base) || "rule";
  for (let n = 1; n < 200; n++) {
    const k = n === 1 ? root : `${root}-${n}`;
    if (!(await one(c, "SELECT 1 FROM knowledge_items WHERE key = $1", [k]))) return k;
  }
  throw new HttpError(409, `no free key for "${root}"`);
}

const audit = (c: Db, itemId: number, action: string, detail: unknown) =>
  q(c, "INSERT INTO knowledge_audit (item_id, action, detail) VALUES ($1, $2, $3)", [
    itemId,
    action,
    json(detail),
  ]);

export interface ApproveOptions {
  by: string;
  comment?: string;
  /** Reviewer edits applied before activation (scope, effective date, wording). */
  edits?: ProposedChange;
  /** The target changed since the proposal was made; the reviewer saw the newer text and approves anyway. */
  acceptCurrentVersion?: boolean;
  /** Skill update whose automatic validation failed: the reviewer takes responsibility. */
  overrideValidation?: boolean;
  /** CREATE only: create shared team knowledge instead of the proposal owner's private item (admin). */
  shared?: boolean;
}

/**
 * Approve and apply in one transaction. Idempotent: approving an approved proposal returns it unchanged.
 * `afterCommit` receives the applied proposal (skill evolution runs there, outside the transaction).
 */
export async function approveProposal(id: number, o: ApproveOptions, onApplied?: (p: any) => void) {
  if (!o.by?.trim()) throw new HttpError(400, "approval needs the reviewer");
  return withTx(async (c, afterCommit) => {
    const p = await one(c, "SELECT * FROM knowledge_proposals WHERE id = $1 FOR UPDATE", [id]);
    if (!p) throw new HttpError(404, "proposal not found");
    if (p.status === "approved") return p;
    if (p.status !== "pending") throw new HttpError(409, `proposal #${id} is ${p.status}`);
    if (p.validation && p.validation.passed === false && !o.overrideValidation)
      throw new HttpError(
        409,
        `automatic validation failed (${(p.validation.checks ?? [])
          .filter((x: any) => !x.passed)
          .map((x: any) => x.name)
          .join(", ")}); fix the text or approve with override_validation`,
      );
    const edits: ProposedChange = Object.fromEntries(
      Object.entries(o.edits ?? {}).filter(
        ([k, v]) =>
          [
            "title",
            "content",
            "scope_type",
            "scope_ref",
            "applicability",
            "effective_from",
            "conflict_key",
          ].includes(k) && v !== undefined,
      ),
    );
    const prop: ProposedChange = { ...p.proposed, ...edits };
    if (prop.scope_type === "GLOBAL") prop.scope_ref = "";
    if (prop.effective_from === "") prop.effective_from = null;
    const auditDeprecation =
      o.by === AUDIT_ACTOR && p.created_by === AUDIT_ACTOR && p.change_type === "DEPRECATE";
    validateProposed(
      p.change_type,
      auditDeprecation && prop.category === "task_memory" ? { ...prop, category: undefined } : prop,
      true,
    );
    const target = p.target_item_id
      ? await one(c, "SELECT * FROM knowledge_items WHERE id = $1 FOR UPDATE", [p.target_item_id])
      : null;
    if (p.change_type !== "CREATE") {
      if (!target) throw new HttpError(409, `the target item of proposal #${id} no longer exists`);
      if (target.enforced || target.category === "security_policy")
        throw new HttpError(
          409,
          `"${target.key}" is enforced/security knowledge: not changeable through proposals`,
        );
      if (auditDeprecation && target.category === "business_rule")
        throw new HttpError(
          409,
          `"${target.key}" is a business rule: the audit cannot deprecate it`,
        );
      if (
        p.target_version != null &&
        target.current_version !== p.target_version &&
        !o.acceptCurrentVersion
      )
        throw new HttpError(
          409,
          `"${target.key}" changed since this proposal (v${p.target_version} → v${target.current_version}); review the current text and approve with accept_current_version`,
        );
    }
    const note = `proposal #${id} (${p.change_type}) approved by ${o.by}${o.comment ? `: ${o.comment}` : ""}`;
    let applied: Record<string, unknown>;
    switch (p.change_type as ChangeType) {
      case "UPDATE": {
        const cur = await one(
          c,
          "SELECT * FROM knowledge_versions WHERE item_id = $1 AND version = $2",
          [target.id, target.current_version],
        );
        const metadata = {
          ...(cur.metadata ?? {}),
          // Repository-imported items: remember which repository file this registry version evolved from, so a re-import
          // can tell "repository unchanged since" (keep the registry) from "repository changed too" (conflict, needs review).
          evolution: {
            proposal_id: id,
            approved_by: o.by,
            base_source: cur.metadata?.source ?? null,
            base_version: cur.version,
          },
        };
        await knowledge.update(
          target.key,
          {
            content: prop.content,
            applicability: (prop.applicability as any) ?? cur.applicability,
            metadata,
            effective_from: prop.effective_from ?? null,
            change_note: note,
            created_by: o.by,
            ...(prop.title ? { title: prop.title } : {}),
          },
          target.owner_id ?? null,
          c,
        );
        const after = await one(c, "SELECT current_version FROM knowledge_items WHERE id = $1", [
          target.id,
        ]);
        applied = {
          item_key: target.key,
          owner_id: target.owner_id ?? null,
          previous_version: cur.version,
          new_version: after.current_version,
          effective_from: prop.effective_from ?? null,
        };
        break;
      }
      case "SUPERSEDE": {
        const key = await uniqueKey(c, prop.key || `${target.key}-${prop.scope_ref || "v2"}`);
        // Old and new rule must compete in one conflict group: then even when the supersession link is replaced (a second
        // scoped SUPERSEDE of the same rule), scope precedence still keeps exactly one of them per context.
        const conflictKey = target.conflict_key ?? `rule.${target.key}`;
        if (!target.conflict_key) {
          await q(
            c,
            "UPDATE knowledge_items SET conflict_key = $2, updated_at = now() WHERE id = $1",
            [target.id, conflictKey],
          );
          await audit(c, target.id, "updated", {
            conflict_key: { from: null, to: conflictKey },
            proposal_id: id,
          });
        }
        await knowledge.create(
          {
            key,
            category: target.category,
            scope_type: prop.scope_type!,
            scope_ref: prop.scope_ref,
            title: prop.title || target.title,
            conflict_key: conflictKey,
            priority: target.priority,
            content: prop.content!,
            applicability: (prop.applicability as any) ?? {},
            metadata: { evolution: { proposal_id: id, supersedes: target.key, approved_by: o.by } },
            effective_from: prop.effective_from ?? null,
            change_note: note,
            created_by: o.by,
            ownerId: target.owner_id ?? null,
          },
          c,
        );
        const created = await one(
          c,
          "SELECT id FROM knowledge_items WHERE key = $1 AND owner_id IS NOT DISTINCT FROM $2",
          [key, target.owner_id ?? null],
        );
        await q(
          c,
          "UPDATE knowledge_items SET superseded_by = $2, superseded_at = now(), updated_at = now() WHERE id = $1",
          [target.id, created.id],
        );
        await audit(c, target.id, "superseded", {
          by: key,
          proposal_id: id,
          scope: `${prop.scope_type}${prop.scope_ref ? ":" + prop.scope_ref : ""}`,
          effective_from: prop.effective_from ?? null,
        });
        applied = {
          created_key: key,
          owner_id: target.owner_id ?? null,
          superseded_key: target.key,
          previous_superseded_by: target.superseded_by ?? null,
          previous_superseded_at: target.superseded_at ?? null,
        };
        break;
      }
      case "DEPRECATE": {
        applied = {
          item_key: target.key,
          owner_id: target.owner_id ?? null,
          previous_enabled: target.enabled,
          previous_expires_at: target.expires_at ?? null,
          previous_superseded_by: target.superseded_by ?? null,
          previous_superseded_at: target.superseded_at ?? null,
        };
        if (prop.effective_from)
          await q(
            c,
            "UPDATE knowledge_items SET expires_at = $2, updated_at = now() WHERE id = $1",
            [target.id, prop.effective_from],
          );
        else
          await knowledge.update(
            target.key,
            { enabled: false, change_note: note, created_by: o.by },
            target.owner_id ?? null,
            c,
          );
        if (prop.superseded_by) {
          const canonical = await one(
            c,
            "SELECT i.*,v.content,v.applicability,v.effective_from FROM knowledge_items i JOIN knowledge_versions v ON v.item_id=i.id AND v.version=i.current_version WHERE i.key=$1 AND i.owner_id IS NULL AND i.enabled FOR SHARE OF i",
            [prop.superseded_by],
          );
          if (
            !canonical ||
            target.owner_id != null ||
            canonical.id === target.id ||
            canonical.superseded_by ||
            !isLive(canonical)
          )
            throw new HttpError(409, "invalid shared canonical item");
          if (
            prop.canonical_version !== canonical.current_version ||
            prop.canonical_sha256 !== sha(canonical.content)
          )
            throw new HttpError(409, "canonical item changed since the audit");
          const currentVersion = await one(
            c,
            "SELECT content,applicability FROM knowledge_versions WHERE item_id=$1 AND version=$2",
            [target.id, target.current_version],
          );
          if (
            currentVersion.content !== canonical.content ||
            !duplicateCoverage([
              canonical,
              { ...target, applicability: currentVersion.applicability },
            ])
          )
            throw new HttpError(409, "duplicate coverage changed since the audit");
          await q(
            c,
            "UPDATE knowledge_items SET superseded_by=$2, superseded_at=now() WHERE id=$1",
            [target.id, canonical.id],
          );
          applied.superseded_to = canonical.id;
        }
        await audit(c, target.id, "deprecated", {
          proposal_id: id,
          at: prop.effective_from ?? "now",
        });
        break;
      }
      case "CREATE": {
        const ownerId = o.shared ? null : (p.owner_id ?? null);
        const key = await uniqueKey(c, prop.key || `rule.${prop.title ?? "new"}`);
        await knowledge.create(
          {
            key,
            category: prop.category ?? "business_rule",
            scope_type: prop.scope_type!,
            scope_ref: prop.scope_ref,
            title: prop.title || key,
            conflict_key: prop.conflict_key ?? null,
            content: prop.content!,
            applicability: (prop.applicability as any) ?? {},
            metadata: { evolution: { proposal_id: id, approved_by: o.by } },
            effective_from: prop.effective_from ?? null,
            change_note: note,
            created_by: o.by,
            ownerId,
          },
          c,
        );
        applied = { created_key: key, owner_id: ownerId };
        break;
      }
    }
    const row = await one(
      c,
      "UPDATE knowledge_proposals SET status = 'approved', proposed = $2, reviewed_by = $3, reviewed_at = now(), review_comment = $4, applied = $5, updated_at = now() WHERE id = $1 RETURNING *",
      [id, json(prop), o.by, o.comment ?? null, json(applied)],
    );
    const itemId =
      target?.id ??
      (
        await one(
          c,
          "SELECT id FROM knowledge_items WHERE key = $1 AND owner_id IS NOT DISTINCT FROM $2",
          [applied.created_key, applied.owner_id],
        )
      )?.id;
    if (itemId)
      await audit(c, itemId, "proposal_approved", {
        proposal_id: id,
        change_type: p.change_type,
        by: o.by,
      });
    if (onApplied) afterCommit(() => onApplied(row));
    return row;
  });
}

export async function rejectProposal(id: number, o: { by: string; comment?: string }) {
  if (!o.by?.trim()) throw new HttpError(400, "rejection needs the reviewer");
  return withTx(async (c) => {
    const p = await one(c, "SELECT * FROM knowledge_proposals WHERE id = $1 FOR UPDATE", [id]);
    if (!p) throw new HttpError(404, "proposal not found");
    if (p.status === "rejected") return p;
    if (p.status !== "pending") throw new HttpError(409, `proposal #${id} is ${p.status}`);
    // Skill updates waiting on a rejected rule change have nothing left to implement.
    await q(
      c,
      "UPDATE knowledge_proposals SET status = 'obsolete', updated_at = now() WHERE parent_id = $1 AND status = 'pending'",
      [id],
    );
    return one(
      c,
      "UPDATE knowledge_proposals SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_comment = $3, updated_at = now() WHERE id = $1 RETURNING *",
      [id, o.by, o.comment ?? null],
    );
  });
}

/**
 * Undo an approved proposal with new registry writes (never deleting history): UPDATE → a new version restoring the
 * previous text; SUPERSEDE/CREATE → the created item is disabled and the supersession link removed; DEPRECATE → the
 * previous enabled/expiry state. Approved skill updates derived from it are rolled back with it (otherwise skills would
 * keep teaching the rule that was just undone); pending ones become obsolete. Refused while a LATER approved change to
 * the same item is active — roll that back first.
 */
export async function rollbackProposal(id: number, o: { by: string; comment?: string }) {
  if (!o.by?.trim()) throw new HttpError(400, "rollback needs the reviewer");
  return withTx(async (c) => rollbackTx(c, id, o));
}

async function rollbackTx(c: Db, id: number, o: { by: string; comment?: string }): Promise<any> {
  const p = await one(c, "SELECT * FROM knowledge_proposals WHERE id = $1 FOR UPDATE", [id]);
  if (!p) throw new HttpError(404, "proposal not found");
  if (p.status === "rolled_back") return p;
  if (p.status !== "approved")
    throw new HttpError(409, `only approved proposals can be rolled back (#${id} is ${p.status})`);
  const a = p.applied ?? {};
  const keys = [a.item_key, a.created_key, a.superseded_key].filter(Boolean);
  const later = await one(
    c,
    `SELECT id FROM knowledge_proposals WHERE status = 'approved' AND id <> $1 AND reviewed_at > $2 AND parent_id IS DISTINCT FROM $1
        AND (target_key = ANY($3) OR applied->>'item_key' = ANY($3) OR applied->>'created_key' = ANY($3) OR applied->>'superseded_key' = ANY($3)) LIMIT 1`,
    [id, p.reviewed_at, keys],
  );
  if (later)
    throw new HttpError(
      409,
      `proposal #${later.id} changed the same knowledge later; roll it back first`,
    );
  for (const ch of await q(
    c,
    "SELECT id FROM knowledge_proposals WHERE parent_id = $1 AND status = 'approved' ORDER BY id DESC",
    [id],
  ))
    await rollbackTx(c, ch.id, { by: o.by, comment: `parent proposal #${id} rolled back` });
  await q(
    c,
    "UPDATE knowledge_proposals SET status = 'obsolete', updated_at = now() WHERE parent_id = $1 AND status = 'pending'",
    [id],
  );
  const note = `rollback of proposal #${id} by ${o.by}${o.comment ? `: ${o.comment}` : ""}`;
  const owner = a.owner_id ?? null;
  const item = async (key: string) =>
    one(
      c,
      "SELECT * FROM knowledge_items WHERE key = $1 AND owner_id IS NOT DISTINCT FROM $2 FOR UPDATE",
      [key, owner],
    );
  switch (p.change_type as ChangeType) {
    case "UPDATE": {
      const it = await item(a.item_key);
      if (!it) throw new HttpError(409, `"${a.item_key}" no longer exists`);
      const prev = await one(
        c,
        "SELECT * FROM knowledge_versions WHERE item_id = $1 AND version = $2",
        [it.id, a.previous_version],
      );
      await knowledge.update(
        it.key,
        {
          content: prev.content,
          applicability: prev.applicability,
          metadata: prev.metadata,
          change_note: note,
          created_by: o.by,
        },
        owner,
        c,
      );
      await audit(c, it.id, "rolled_back", {
        proposal_id: id,
        restored_version: a.previous_version,
      });
      break;
    }
    case "SUPERSEDE":
    case "CREATE": {
      const created = await item(a.created_key);
      if (created) {
        await knowledge.update(
          created.key,
          { enabled: false, change_note: note, created_by: o.by },
          owner,
          c,
        );
        await audit(c, created.id, "rolled_back", { proposal_id: id });
        if (a.superseded_key) {
          const old = await item(a.superseded_key);
          if (old && Number(old.superseded_by) === Number(created.id)) {
            await q(
              c,
              "UPDATE knowledge_items SET superseded_by = $2, superseded_at = NULL, updated_at = now() WHERE id = $1",
              [old.id, a.previous_superseded_by ?? null],
            );
            await audit(c, old.id, "supersession_removed", { proposal_id: id, was: created.key });
          }
        }
      }
      break;
    }
    case "DEPRECATE": {
      const it = await item(a.item_key);
      if (it) {
        await q(c, "UPDATE knowledge_items SET expires_at = $2, updated_at = now() WHERE id = $1", [
          it.id,
          a.previous_expires_at ?? null,
        ]);
        // Only undo a supersession this proposal set and nobody changed since.
        const supersededTo =
          a.superseded_to ??
          (p.proposed?.superseded_by
            ? (
                await one(c, "SELECT id FROM knowledge_items WHERE key=$1 AND owner_id IS NULL", [
                  p.proposed.superseded_by,
                ])
              )?.id
            : null);
        if (supersededTo != null && Number(it.superseded_by) === Number(supersededTo))
          await q(c, "UPDATE knowledge_items SET superseded_by=$2, superseded_at=$3 WHERE id=$1", [
            it.id,
            a.previous_superseded_by ?? null,
            a.previous_superseded_at ?? null,
          ]);
        if (a.previous_enabled && !it.enabled)
          await knowledge.update(
            it.key,
            { enabled: true, change_note: note, created_by: o.by },
            owner,
            c,
          );
        await audit(c, it.id, "rolled_back", { proposal_id: id });
      }
      break;
    }
  }
  return one(
    c,
    "UPDATE knowledge_proposals SET status = 'rolled_back', rolled_back_by = $2, rolled_back_at = now(), review_comment = COALESCE(review_comment, '') || $3, updated_at = now() WHERE id = $1 RETURNING *",
    [id, o.by, o.comment ? `\nrollback: ${o.comment}` : ""],
  );
}

/** Who may review a proposal: shared knowledge (target or result) needs an admin; private knowledge its owner. */
export async function reviewScope(id: number, db: Db = pool) {
  const p = await one(
    db,
    "SELECT p.owner_id, p.change_type, p.applied, i.owner_id AS target_owner FROM knowledge_proposals p LEFT JOIN knowledge_items i ON i.id = p.target_item_id WHERE p.id = $1",
    [id],
  );
  if (!p) return undefined;
  const writesShared =
    p.change_type === "CREATE"
      ? p.applied
        ? p.applied.owner_id == null
        : false
      : p.target_owner == null;
  return { proposalOwner: p.owner_id == null ? null : Number(p.owner_id), writesShared };
}
