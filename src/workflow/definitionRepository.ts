import { pool, q, one, json, type Db } from "../db/pool.ts";
import type { WorkflowSpec } from "./types.ts";

export interface DefinitionVersion {
  id: number;
  definition_id: number;
  key: string;
  version: number;
  spec: WorkflowSpec;
  spec_hash: string;
}

interface DefinitionRow {
  id: number;
  key: string;
  name: string;
  description: string;
  latest_version: number;
  is_template: boolean;
  archived: boolean;
  owner_id: number | null;
  created_at: Date;
  updated_at: Date;
  draft_spec: WorkflowSpec | null;
  template_base: WorkflowSpec | null;
}

type PublishedVersion = Pick<DefinitionVersion, "id" | "version" | "spec" | "spec_hash"> & {
  change_note: string;
  published_at: Date;
};

export const definitionRepository = {
  list(db: Db = pool, scope?: { ownerId?: number; all?: boolean }) {
    const all = !!scope?.all;
    const owner = all ? null : (scope?.ownerId ?? null);
    return q<
      Pick<
        DefinitionRow,
        | "id"
        | "key"
        | "name"
        | "description"
        | "latest_version"
        | "is_template"
        | "archived"
        | "updated_at"
        | "owner_id"
      > & {
        has_draft: boolean;
        category: string | null;
        execution_mode: string | null;
        triggers: WorkflowSpec["triggers"] | null;
        run_count: number;
      }
    >(
      db,
      `SELECT d.id, d.key, d.name, d.description, d.latest_version, d.is_template, d.archived, d.updated_at, d.owner_id,
              d.draft_spec IS NOT NULL AS has_draft,
              lv.spec->>'category' AS category, lv.spec->>'execution_mode' AS execution_mode, lv.spec->'triggers' AS triggers,
              (SELECT count(*) FROM workflow_runs r WHERE r.definition_key = d.key AND ($1::bigint IS NULL OR r.owner_id = $1)) AS run_count
         FROM workflow_definitions d
         LEFT JOIN workflow_definition_versions lv ON lv.definition_id = d.id AND lv.version = d.latest_version
        WHERE NOT d.archived AND (d.owner_id IS NULL OR $3::bool OR d.owner_id = $2)
        ORDER BY d.is_template DESC, d.owner_id NULLS FIRST, d.name`,
      [owner, owner, all],
    );
  },

  /** Shared definition when ownerId is null. Private definitions are looked up by their owner. */
  async get(key: string, db: Db = pool, ownerId: number | null = null) {
    const d = await one<DefinitionRow>(
      db,
      "SELECT * FROM workflow_definitions WHERE key = $1 AND owner_id IS NOT DISTINCT FROM $2",
      [key, ownerId],
    );
    if (!d) return undefined;
    const versions = await q<PublishedVersion>(
      db,
      "SELECT id, version, spec, spec_hash, change_note, published_at FROM workflow_definition_versions WHERE definition_id = $1 ORDER BY version DESC",
      [d.id],
    );
    return { ...d, versions };
  },

  async insert(
    db: Db,
    key: string,
    spec: WorkflowSpec,
    input: {
      isTemplate?: boolean;
      ownerId?: number | null;
      templateBase?: unknown;
    },
  ) {
    const row = await one<{ id: number }>(
      db,
      `INSERT INTO workflow_definitions (key, name, description, draft_spec, is_template, owner_id, template_base)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        key,
        spec.name,
        spec.description,
        json(spec),
        input.isTemplate ?? false,
        input.ownerId ?? null,
        input.templateBase === undefined ? null : json(input.templateBase),
      ],
    );
    return row!.id;
  },

  saveDraft(key: string, spec: WorkflowSpec, ownerId: number | null, db: Db = pool) {
    return one<{ id: number }>(
      db,
      `UPDATE workflow_definitions SET draft_spec = $2, name = $3, description = $4, updated_at = now()
        WHERE key = $1 AND owner_id IS NOT DISTINCT FROM $5 RETURNING id`,
      [key, json(spec), spec.name, spec.description, ownerId],
    );
  },

  lockByKey(db: Db, key: string, ownerId: number | null) {
    return one<{ id: number }>(
      db,
      "SELECT id FROM workflow_definitions WHERE key = $1 AND owner_id IS NOT DISTINCT FROM $2 FOR UPDATE",
      [key, ownerId],
    );
  },

  async archive(key: string, ownerId: number | null = null, db: Db = pool) {
    await q(
      db,
      "UPDATE workflow_definitions SET archived = true, updated_at = now() WHERE key = $1 AND owner_id IS NOT DISTINCT FROM $2",
      [key, ownerId],
    );
  },

  definition(db: Db, id: number) {
    return one<DefinitionRow>(db, "SELECT * FROM workflow_definitions WHERE id = $1", [id]);
  },

  lockDefinition(db: Db, id: number) {
    return one<DefinitionRow>(db, "SELECT * FROM workflow_definitions WHERE id = $1 FOR UPDATE", [
      id,
    ]);
  },

  latest(db: Db, id: number) {
    return one<Pick<PublishedVersion, "spec" | "spec_hash" | "version">>(
      db,
      "SELECT spec, spec_hash, version FROM workflow_definition_versions WHERE definition_id = $1 ORDER BY version DESC LIMIT 1",
      [id],
    );
  },

  async insertVersion(
    db: Db,
    id: number,
    version: number,
    spec: WorkflowSpec,
    hash: string,
    changeNote: string,
  ) {
    await q(
      db,
      `INSERT INTO workflow_definition_versions (definition_id, version, spec, spec_hash, change_note)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, version, json(spec), hash, changeNote],
    );
  },

  async setPublishedVersion(db: Db, id: number, version: number) {
    await q(
      db,
      "UPDATE workflow_definitions SET latest_version = $2, draft_spec = NULL, updated_at = now() WHERE id = $1",
      [id, version],
    );
  },

  sharedTemplate(key: string, db: Db = pool) {
    return one<Pick<DefinitionRow, "id" | "is_template" | "template_base">>(
      db,
      "SELECT id, is_template, template_base FROM workflow_definitions WHERE key = $1 AND owner_id IS NULL",
      [key],
    );
  },

  async setTemplateDraft(db: Db, id: number, spec: WorkflowSpec) {
    await q(db, "UPDATE workflow_definitions SET draft_spec = $2 WHERE id = $1", [id, json(spec)]);
  },

  async setTemplateBase(db: Db, id: number, spec: WorkflowSpec) {
    await q(db, "UPDATE workflow_definitions SET template_base = $2 WHERE id = $1", [
      id,
      json(spec),
    ]);
  },

  version(key: string, version: number | undefined, db: Db, ownerId?: number | null) {
    return one<DefinitionVersion>(
      db,
      `SELECT v.id, v.definition_id, d.key, v.version, v.spec, v.spec_hash
         FROM workflow_definition_versions v JOIN workflow_definitions d ON d.id = v.definition_id
        WHERE d.key = $1 AND (d.owner_id IS NULL OR d.owner_id = $3)
          AND v.version = COALESCE($2, d.latest_version)
        ORDER BY d.owner_id NULLS LAST LIMIT 1`,
      [key, version ?? null, ownerId || null],
    );
  },

  referenceSpecs(db: Db, scope?: { ownerId: number; all: boolean }) {
    return q<{
      key: string;
      draft_spec: WorkflowSpec | null;
      spec: WorkflowSpec | null;
      version: number | null;
    }>(
      db,
      `SELECT d.key, d.draft_spec, v.version, v.spec
         FROM workflow_definitions d LEFT JOIN workflow_definition_versions v ON v.definition_id = d.id AND v.version = d.latest_version
        WHERE NOT d.archived AND (d.owner_id IS NULL OR $1::bool OR d.owner_id = $2)`,
      [!scope || scope.all, scope?.ownerId ?? null],
    );
  },
};
