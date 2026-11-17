import { createHash } from "node:crypto";
import { pool, withTx, inTx, txWrote, type Db } from "../db/pool.ts";
import { CacheAside } from "../cache/index.ts";
import { validateSpec } from "./graph.ts";
import { TEMPLATES } from "./templates.ts";
import type { WorkflowSpec } from "./types.ts";
import { definitionRepository, type DefinitionVersion } from "./definitionRepository.ts";

export type { DefinitionVersion } from "./definitionRepository.ts";

/** Stable JSON (sorted keys) so identical specs hash identically. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (isObject(v))
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
export const hashOf = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

export const definitions = {
  list: definitionRepository.list,
  get: definitionRepository.get,
  archive: definitionRepository.archive,

  /** A published version; latest when `version` is omitted. */
  /** The owner's private copy when it exists, otherwise the shared definition. */
  async version(
    key: string,
    version?: number,
    db: Db = pool,
    ownerId?: number | null,
  ): Promise<DefinitionVersion | undefined> {
    const wrote =
      inTx(db) &&
      (txWrote(db, "workflow_definitions") || txWrote(db, "workflow_definition_versions"));
    const load = () => definitionRepository.version(key, version, db, ownerId);
    return wrote
      ? load()
      : versionCache.get(`${key}|${version ?? "latest"}|${ownerId ?? ""}`, load);
  },

  /** Create a definition with an (optionally published) first spec. ownerId null means shared. */
  async create(input: {
    key: string;
    spec: unknown;
    publish?: boolean;
    isTemplate?: boolean;
    changeNote?: string;
    ownerId?: number | null;
    templateBase?: unknown;
  }) {
    const spec = validateSpec(input.spec);
    return withTx(async (c) => {
      const id = await definitionRepository.insert(c, input.key, spec, input);
      if (input.publish !== false) await publishTx(c, id, input.changeNote ?? "initial version");
      const definition = await definitions.get(input.key, c, input.ownerId ?? null);
      if (!definition) throw new Error(`created workflow "${input.key}" could not be read`);
      return definition;
    });
  },

  /** Save a draft; validated, but nothing running is affected until it is published. */
  async saveDraft(key: string, rawSpec: unknown, ownerId: number | null = null) {
    const spec = validateSpec(rawSpec);
    const d = await definitionRepository.saveDraft(key, spec, ownerId);
    if (!d) throw new Error(`workflow "${key}" not found`);
    return definitions.get(key, pool, ownerId);
  },

  /** Freeze the draft into a new immutable version. No-op if identical to the latest version. */
  async publish(key: string, changeNote = "", ownerId: number | null = null) {
    return withTx(async (c) => {
      const d = await definitionRepository.lockByKey(c, key, ownerId);
      if (!d) throw new Error(`workflow "${key}" not found`);
      return publishTx(c, d.id, changeNote);
    });
  },
};

async function publishTx(c: Db, definitionId: number, changeNote: string) {
  const d = await definitionRepository.definition(c, definitionId);
  if (!d?.draft_spec) throw new Error("nothing to publish: no draft");
  const spec = validateSpec(d.draft_spec);
  const hash = hashOf(spec);
  const latest = await definitionRepository.latest(c, definitionId);
  if (latest?.spec_hash === hash) return { version: latest.version, unchanged: true };
  const version = d.latest_version + 1;
  await definitionRepository.insertVersion(c, definitionId, version, spec, hash, changeNote);
  await definitionRepository.setPublishedVersion(c, definitionId, version);
  return { version, unchanged: false };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isKeyedList = (v: unknown): v is Array<{ key: string }> =>
  Array.isArray(v) && v.every((x) => isObject(x) && typeof x.key === "string");
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * Three-way merge of a template update into a definition: `base` is the template the definition was last seeded
 * from, `ours` its latest published spec, `theirs` the new template. Local edits win on conflict; keyed lists
 * (steps) merge per key, other arrays as a whole.
 */
export function mergeTemplateSpec(base: unknown, ours: unknown, theirs: unknown): unknown {
  if (same(ours, base)) return theirs;
  if (same(theirs, base) || same(ours, theirs)) return ours;
  if (isObject(ours) && isObject(theirs)) {
    const b = isObject(base) ? base : {};
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
      const v = mergeTemplateSpec(b[k], ours[k], theirs[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (isKeyedList(ours) && isKeyedList(theirs) && (base === undefined || isKeyedList(base))) {
    const b = new Map((base ?? []).map((x) => [x.key, x]));
    const o = new Map(ours.map((x) => [x.key, x]));
    const t = new Set(theirs.map((x) => x.key));
    const out: unknown[] = [];
    for (const x of theirs) {
      if (o.has(x.key)) out.push(mergeTemplateSpec(b.get(x.key), o.get(x.key), x));
      else if (!b.has(x.key)) out.push(x);
    }
    for (const x of ours) if (!t.has(x.key) && !b.has(x.key)) out.push(x);
    return out;
  }
  return ours;
}

/**
 * Insert missing templates; when a shipped template changed, merge the update into the definition's latest
 * version (keeping local edits such as layout or agent overrides) and publish it.
 */
export async function seedTemplates() {
  for (const t of TEMPLATES) {
    const spec = validateSpec(t.spec);
    const existing = await definitionRepository.sharedTemplate(t.key);
    if (!existing) {
      await definitions.create({
        key: t.key,
        spec,
        isTemplate: true,
        changeNote: "built-in template",
        templateBase: spec,
      });
      continue;
    }
    if (!existing.is_template || !existing.template_base || same(existing.template_base, spec))
      continue;
    await withTx(async (c) => {
      const d = await definitionRepository.lockDefinition(c, existing.id);
      // An unpublished draft would be overwritten by the publish below; retry on the next start.
      if (!d || d.draft_spec || same(d.template_base, spec)) return;
      const latest = await definitionRepository.latest(c, d.id);
      if (!latest) return;
      let next: WorkflowSpec;
      try {
        next = validateSpec(mergeTemplateSpec(d.template_base, latest.spec, spec));
      } catch (err) {
        console.warn(
          `Template "${t.key}" update not applied: merge with local edits is invalid`,
          err,
        );
        return;
      }
      if (hashOf(next) !== latest.spec_hash) {
        await definitionRepository.setTemplateDraft(c, d.id, next);
        await publishTx(
          c,
          d.id,
          same(latest.spec, d.template_base)
            ? "built-in template update"
            : "built-in template update (local edits kept)",
        );
      }
      await definitionRepository.setTemplateBase(c, d.id, spec);
    });
  }
}

/** Published version rows never change; the latest pointer does (watched through workflow_definitions writes). */
const versionCache = new CacheAside<DefinitionVersion | undefined>(
  "definitions.version",
  ["workflow_definitions", "workflow_definition_versions"],
  300_000,
  500,
);
