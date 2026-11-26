import { pool } from "../db/pool.ts";
import { resolveOutputLocale } from "../agent/language.ts";
import { audit } from "../authz/access.ts";
import { codeAssessmentProfile } from "./context.ts";
import { normalizeFocus, normalizeProject } from "./key.ts";
import { sharingHooks, type SharedActor } from "./hooks.ts";
import {
  byId,
  latestForError,
  latestForRepositories,
  validForError,
  validForRepositories,
  type SharedRow,
} from "./repository.ts";
import { installationId } from "./scope.ts";
import { scrubText } from "./scrub.ts";
import { enabledKinds } from "./settle.ts";
import { describeAnalysis, type NewerVersion } from "./view.ts";

/**
 * Reads of shared analyses for the UI (step 7). Every row goes through the same access check as a lookup (step 5); a row
 * the reader may not read is absent (404 or null), never described, so not even its runner's name crosses. A kind whose
 * flag is off is absent too, and with both flags off nothing is queried.
 */
const view = (row: SharedRow, actor: SharedActor, newer?: NewerVersion) =>
  describeAnalysis({ outcome: "read", analysis: row, ...(newer ? { newer } : {}) }, actor);
const readable = async (row: SharedRow | null | undefined, actor: SharedActor) =>
  !!row && (await sharingHooks().canRead(row, actor));

/**
 * What a reader sees for the latest version of an analysis. While that version is running or failed (a re-run), it is the
 * newest valid, servable version the reader may read (access is checked on each candidate), with a note about the newer one;
 * otherwise the latest version itself when the reader may read it. Nothing when nothing is readable.
 */
async function current(
  latest: SharedRow | null | undefined,
  valid: () => Promise<SharedRow[]>,
  actor: SharedActor,
) {
  if (!latest) return null;
  if (latest.status === "running" || latest.status === "failed") {
    const now = new Date();
    for (const c of await valid())
      if (sharingHooks().servable(c, now) && (await readable(c, actor)))
        return view(
          c,
          actor,
          (await readable(latest, actor))
            ? { version: latest.version, status: latest.status }
            : undefined,
        );
  }
  return (await readable(latest, actor)) ? view(latest, actor) : null;
}

/** One analysis by id. Admin support access (?scope=all) reads any row, and is audited. */
export async function readSharedAnalysis(id: number, actor: SharedActor, support = false) {
  const kinds = enabledKinds();
  if (!kinds.length) return null;
  const row = await byId(pool, id);
  if (!row || !kinds.includes(row.kind)) return null;
  if (!(await readable(row, actor))) {
    if (!support) return null;
    await audit(actor.id, "support.read", "shared_analysis", String(id), { kind: row.kind });
  }
  return view(row, actor);
}

/** The current RCA and bug hunt of one production error (see `current`), each null when absent or not readable. */
export async function sharedForError(fingerprint: string, actor: SharedActor) {
  const kinds = enabledKinds().filter((k) => k !== "code_assessment");
  const out: { runtime_rca: unknown; bug_hunt: unknown } = { runtime_rca: null, bug_hunt: null };
  if (!kinds.length) return out;
  const scope = await installationId();
  for (const row of await latestForError(pool, fingerprint, kinds, scope))
    out[row.kind === "prod_error.runtime_rca" ? "runtime_rca" : "bug_hunt"] = await current(
      row,
      () => validForError(pool, fingerprint, row.kind, scope),
      actor,
    );
  return out;
}

/** The current code assessment of exactly these repositories, focus, project, locale and profile (see `current`; an older commit shows as stale). */
export async function sharedForRepositories(
  repos: string[],
  focus: string,
  actor: SharedActor,
  opts: { project?: string; outputLocale?: string; title?: string; profile?: string } = {},
) {
  if (!enabledKinds().includes("code_assessment") || !repos.length) return null;
  const sorted = [...new Set(repos)].sort();
  const stored = scrubText(normalizeFocus(focus));
  const project = normalizeProject(opts.project);
  const locale = resolveOutputLocale(opts.outputLocale);
  const profile = await codeAssessmentProfile(pool, null, {
    profile: opts.profile,
    title: opts.title,
    project,
    repositories: sorted,
  });
  const scope = await installationId();
  return current(
    await latestForRepositories(pool, sorted, stored, scope, project, locale, profile),
    () => validForRepositories(pool, sorted, stored, scope, project, locale, profile),
    actor,
  );
}
