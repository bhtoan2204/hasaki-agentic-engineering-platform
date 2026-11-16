import { pool, q, one, json, type Db } from "../db/pool.ts";

export interface KnowledgeListFilter {
  category?: string;
  ownerId?: number;
  all?: boolean;
}

export interface ProposalListFilter {
  ownerId: number;
  all?: boolean;
  status?: string;
  runId?: number;
  targetKey?: string;
}

export const knowledgeRepository = {
  listKnowledgeItems(filter: KnowledgeListFilter = {}, db: Db = pool) {
    const scoped = filter.ownerId != null || filter.all === true;
    return q(
      db,
      `SELECT i.*, v.content, v.applicability, v.metadata, v.effective_from, v.created_at AS version_created_at
         FROM knowledge_items i LEFT JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version
        WHERE ($1::text IS NULL OR i.category = $1)
          AND (
            ($2::bool AND i.owner_id IS NULL)
            OR ($3::bool AND (i.owner_id IS NULL OR i.owner_id = $4))
            OR ($5::bool)
          )
        ORDER BY i.category, i.scope_type, i.owner_id NULLS FIRST, i.key`,
      [
        filter.category ?? null,
        !scoped,
        filter.ownerId != null && !filter.all,
        filter.ownerId ?? null,
        !!filter.all,
      ],
    );
  },

  getKnowledgeItemByKey(key: string, ownerId: number | null = null, db: Db = pool) {
    return one(
      db,
      "SELECT * FROM knowledge_items WHERE key = $1 AND owner_id IS NOT DISTINCT FROM $2",
      [key, ownerId],
    );
  },

  getKnowledgeItemById(id: number, db: Db = pool) {
    return one(db, "SELECT * FROM knowledge_items WHERE id = $1", [id]);
  },

  getKnowledgeVersions(itemId: number, db: Db = pool) {
    return q(db, "SELECT * FROM knowledge_versions WHERE item_id = $1 ORDER BY version DESC", [
      itemId,
    ]);
  },

  getKnowledgeAudit(itemId: number, limit = 100, db: Db = pool) {
    return q(db, "SELECT * FROM knowledge_audit WHERE item_id = $1 ORDER BY id DESC LIMIT $2", [
      itemId,
      limit,
    ]);
  },

  findSupersededByItem(supersededById: number, db: Db = pool) {
    return one(db, "SELECT key, title, enabled FROM knowledge_items WHERE id = $1", [
      supersededById,
    ]);
  },

  findSupersedesItems(itemId: number, db: Db = pool) {
    return q(
      db,
      "SELECT key, title, enabled, superseded_at FROM knowledge_items WHERE superseded_by = $1 ORDER BY key",
      [itemId],
    );
  },

  findItemForRevert(key: string, ownerId: number | null, db: Db = pool) {
    return one(
      db,
      "SELECT i.id, v.metadata FROM knowledge_items i JOIN knowledge_versions v ON v.item_id=i.id AND v.version=i.current_version WHERE i.key=$1 AND i.owner_id IS NOT DISTINCT FROM $2 FOR UPDATE OF i",
      [key, ownerId],
    );
  },

  findItemVersion(itemId: number, version: number, db: Db = pool) {
    return one(db, "SELECT * FROM knowledge_versions WHERE item_id=$1 AND version=$2", [
      itemId,
      version,
    ]);
  },

  findItemForUpdate(key: string, ownerId: number | null, db: Db = pool) {
    return one(
      db,
      "SELECT * FROM knowledge_items WHERE key = $1 AND owner_id IS NOT DISTINCT FROM $2 FOR UPDATE",
      [key, ownerId],
    );
  },

  insertKnowledgeItem(
    data: {
      key: string;
      category: string;
      scope_type: string;
      scope_ref: string;
      title: string;
      conflict_key: string | null;
      priority: number;
      enforced: boolean;
      enabled: boolean;
      ownerId: number | null;
    },
    db: Db = pool,
  ) {
    return one(
      db,
      `INSERT INTO knowledge_items (key, category, scope_type, scope_ref, title, conflict_key, priority, enforced, enabled, current_version, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10) RETURNING *`,
      [
        data.key,
        data.category,
        data.scope_type,
        data.scope_ref,
        data.title,
        data.conflict_key || null,
        data.priority,
        data.enforced,
        data.enabled,
        data.ownerId,
      ],
    );
  },

  insertKnowledgeVersion(
    data: {
      item_id: number;
      version: number;
      content: string;
      applicability: unknown;
      metadata: unknown;
      change_note: string;
      created_by: string;
      effective_from: string | null;
    },
    db: Db = pool,
  ) {
    return q(
      db,
      `INSERT INTO knowledge_versions (item_id, version, content, applicability, metadata, change_note, created_by, effective_from) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        data.item_id,
        data.version,
        data.content,
        json(data.applicability ?? {}),
        json(data.metadata ?? {}),
        data.change_note,
        data.created_by,
        data.effective_from,
      ],
    );
  },

  insertKnowledgeAudit(itemId: number, action: string, detail: unknown, db: Db = pool) {
    return q(db, "INSERT INTO knowledge_audit (item_id, action, detail) VALUES ($1, $2, $3)", [
      itemId,
      action,
      json(detail),
    ]);
  },

  deleteKnowledgeDeletion(key: string, db: Db = pool) {
    return q(db, "DELETE FROM knowledge_deletions WHERE key = $1", [key]);
  },

  updateKnowledgeItemCurrentVersion(id: number, version: number, db: Db = pool) {
    return q(
      db,
      "UPDATE knowledge_items SET current_version = $2, updated_at = now() WHERE id = $1",
      [id, version],
    );
  },

  updateKnowledgeItemFields(id: number, cols: string[], values: unknown[], db: Db = pool) {
    return q(
      db,
      `UPDATE knowledge_items SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
      [id, ...values],
    );
  },

  findConflictingRules(conflictKey: string, excludeKey?: string | null, db: Db = pool) {
    return q(
      db,
      "SELECT key, title, scope_type, scope_ref FROM knowledge_items WHERE conflict_key = $1 AND enabled AND key IS DISTINCT FROM $2 ORDER BY key LIMIT 20",
      [conflictKey, excludeKey ?? null],
    );
  },

  listProposals(filter: ProposalListFilter, db: Db = pool) {
    return q(
      db,
      `SELECT p.id, p.status, p.change_type, p.target_key, p.target_version, p.proposed, p.domain, p.confidence, p.source_kind, p.source_run_id, p.parent_id,
              p.owner_id, p.created_at, p.updated_at, p.reviewed_by, p.reviewed_at, jsonb_array_length(p.evidence) AS evidence_count,
              p.validation->>passed AS validation_passed, r.title AS run_title
         FROM knowledge_proposals p LEFT JOIN workflow_runs r ON r.id = p.source_run_id
        WHERE ($1::text IS NULL OR p.status = $1)
          AND ($2::bigint IS NULL OR p.source_run_id = $2)
          AND ($3::text IS NULL OR p.target_key = $3 OR p.proposed->>key = $3 OR p.applied->>created_key = $3)
          AND ($4::bool OR p.owner_id = $5 OR p.owner_id IS NULL)
        ORDER BY (p.status = pending) DESC, p.id DESC LIMIT 300`,
      [
        filter.status ?? null,
        filter.runId ?? null,
        filter.targetKey ?? null,
        !!filter.all,
        filter.ownerId,
      ],
    );
  },

  getProposalById(id: number, db: Db = pool) {
    return one(db, "SELECT * FROM knowledge_proposals WHERE id = $1", [id]);
  },

  getProposalTargetItem(targetItemId: number, db: Db = pool) {
    return one(
      db,
      "SELECT i.id, i.key, i.title, i.category, i.scope_type, i.scope_ref, i.current_version, i.enabled, i.owner_id, i.superseded_by, i.expires_at, v.content FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version WHERE i.id = $1",
      [targetItemId],
    );
  },

  getChildProposals(parentId: number, db: Db = pool) {
    return q(
      db,
      "SELECT id, status, change_type, target_key, validation, created_at FROM knowledge_proposals WHERE parent_id = $1 ORDER BY id",
      [parentId],
    );
  },

  upsertProposal(params: unknown[], db: Db = pool) {
    return one(
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
      params,
    );
  },
};
