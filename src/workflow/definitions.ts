import { createHash } from "node:crypto";
import { pool, q, one, withTx, json, type Db } from "../db/pool.ts";
import { validateSpec } from "./graph.ts";
import { TEMPLATES } from "./templates.ts";
import type { WorkflowSpec } from "./types.ts";

/** Stable JSON (sorted keys) so identical specs hash identically. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical((v as any)[k])).join(",") + "}";
  return JSON.stringify(v);
}
export const hashOf = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

export interface DefinitionVersion {
  id: number;
  definition_id: number;
  key: string;
  version: number;
  spec: WorkflowSpec;
  spec_hash: string;
}

export const definitions = {
  list(db: Db = pool) {
    return q(
      db,
      `SELECT d.id, d.key, d.name, d.description, d.latest_version, d.is_template, d.archived, d.updated_at,
              d.draft_spec IS NOT NULL AS has_draft,
              (SELECT count(*) FROM workflow_runs r WHERE r.definition_key = d.key) AS run_count
         FROM workflow_definitions d WHERE NOT d.archived ORDER BY d.is_template DESC, d.name`,
    );
  },

  async get(key: string, db: Db = pool) {
    const d = await one(db, "SELECT * FROM workflow_definitions WHERE key = $1", [key]);
    if (!d) return undefined;
    const versions = await q(
      db,
      "SELECT id, version, spec, spec_hash, change_note, published_at FROM workflow_definition_versions WHERE definition_id = $1 ORDER BY version DESC",
      [d.id],
    );
    return { ...d, versions };
  },

  /** A published version; latest when `version` is omitted. */
  async version(key: string, version?: number, db: Db = pool): Promise<DefinitionVersion | undefined> {
    return one<DefinitionVersion>(
      db,
      `SELECT v.id, v.definition_id, d.key, v.version, v.spec, v.spec_hash
         FROM workflow_definition_versions v JOIN workflow_definitions d ON d.id = v.definition_id
        WHERE d.key = $1 AND v.version = COALESCE($2, d.latest_version)`,
      [key, version ?? null],
    );
  },

  /** Create a definition with an (optionally published) first spec. */
  async create(input: { key: string; spec: unknown; publish?: boolean; isTemplate?: boolean; changeNote?: string }) {
    const spec = validateSpec(input.spec);
    return withTx(async (c) => {
      const d = await one(
        c,
        `INSERT INTO workflow_definitions (key, name, description, draft_spec, is_template) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [input.key, spec.name, spec.description, json(spec), input.isTemplate ?? false],
      );
      if (input.publish !== false) await publishTx(c, d.id, input.changeNote ?? "initial version");
      return definitions.get(input.key, c);
    });
  },

  /** Save a draft; validated, but nothing running is affected until it is published. */
  async saveDraft(key: string, rawSpec: unknown) {
    const spec = validateSpec(rawSpec);
    const d = await one(
      pool,
      `UPDATE workflow_definitions SET draft_spec = $2, name = $3, description = $4, updated_at = now() WHERE key = $1 RETURNING id`,
      [key, json(spec), spec.name, spec.description],
    );
    if (!d) throw new Error(`workflow "${key}" not found`);
    return definitions.get(key);
  },

  /** Freeze the draft into a new immutable version. No-op if identical to the latest version. */
  async publish(key: string, changeNote = "") {
    return withTx(async (c) => {
      const d = await one(c, "SELECT id FROM workflow_definitions WHERE key = $1 FOR UPDATE", [key]);
      if (!d) throw new Error(`workflow "${key}" not found`);
      return publishTx(c, d.id, changeNote);
    });
  },

  async archive(key: string) {
    await q(pool, "UPDATE workflow_definitions SET archived = true, updated_at = now() WHERE key = $1", [key]);
  },
};

async function publishTx(c: Db, definitionId: number, changeNote: string) {
  const d = await one(c, "SELECT * FROM workflow_definitions WHERE id = $1", [definitionId]);
  if (!d.draft_spec) throw new Error("nothing to publish: no draft");
  const spec = validateSpec(d.draft_spec);
  const hash = hashOf(spec);
  const latest = await one(c, "SELECT spec_hash, version FROM workflow_definition_versions WHERE definition_id = $1 ORDER BY version DESC LIMIT 1", [
    definitionId,
  ]);
  if (latest?.spec_hash === hash) return { version: latest.version, unchanged: true };
  const version = d.latest_version + 1;
  await q(c, `INSERT INTO workflow_definition_versions (definition_id, version, spec, spec_hash, change_note) VALUES ($1, $2, $3, $4, $5)`, [
    definitionId,
    version,
    json(spec),
    hash,
    changeNote,
  ]);
  await q(c, "UPDATE workflow_definitions SET latest_version = $2, draft_spec = NULL, updated_at = now() WHERE id = $1", [definitionId, version]);
  return { version, unchanged: false };
}

/**
 * Insert missing templates; publish a new version of a template only when the shipped spec changed AND the
 * user has not published their own edits on top (their latest version still matches a shipped spec hash).
 */
export async function seedTemplates() {
  for (const t of TEMPLATES) {
    const spec = validateSpec(t.spec);
    const existing = await definitions.get(t.key);
    if (!existing) {
      await definitions.create({ key: t.key, spec, isTemplate: true, changeNote: "built-in template" });
      continue;
    }
    if (!existing.is_template) continue;
    const latest = existing.versions[0];
    if (latest && latest.spec_hash !== hashOf(spec) && latest.change_note.startsWith("built-in template")) {
      await withTx(async (c) => {
        await q(c, "UPDATE workflow_definitions SET draft_spec = $2 WHERE id = $1", [existing.id, json(spec)]);
        await publishTx(c, existing.id, "built-in template update");
      });
    }
  }
}
