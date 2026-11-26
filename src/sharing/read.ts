import { pool } from "../db/pool.ts";
import { audit } from "../authz/access.ts";
import { normalizeFocus } from "./key.ts";
import { sharingHooks, type SharedActor } from "./hooks.ts";
import { byId, latestForError, latestForRepositories, type SharedRow } from "./repository.ts";
import { installationId } from "./scope.ts";
import { scrubText } from "./scrub.ts";
import { enabledKinds } from "./settle.ts";
import { describeAnalysis } from "./view.ts";

/**
 * Reads of shared analyses for the UI (step 7). Every row goes through the same access check as a lookup (step 5); a row
 * the reader may not read is absent (404 or null), never described, so not even its runner's name crosses. A kind whose
 * flag is off is absent too, and with both flags off nothing is queried.
 */
const view = (row: SharedRow, actor: SharedActor) =>
  describeAnalysis({ outcome: "read", analysis: row }, actor);
const readable = async (row: SharedRow | null | undefined, actor: SharedActor) =>
  !!row && (await sharingHooks().canRead(row, actor));

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

/** The latest RCA and bug hunt of one production error, each null when absent or not readable. */
export async function sharedForError(fingerprint: string, actor: SharedActor) {
  const kinds = enabledKinds().filter((k) => k !== "code_assessment");
  const out: { runtime_rca: unknown; bug_hunt: unknown } = { runtime_rca: null, bug_hunt: null };
  if (!kinds.length) return out;
  for (const row of await latestForError(pool, fingerprint, kinds, await installationId()))
    if (await readable(row, actor))
      out[row.kind === "prod_error.runtime_rca" ? "runtime_rca" : "bug_hunt"] = await view(
        row,
        actor,
      );
  return out;
}

/** The latest code assessment of exactly these repositories and focus (any commit: an older one shows as stale). */
export async function sharedForRepositories(repos: string[], focus: string, actor: SharedActor) {
  if (!enabledKinds().includes("code_assessment") || !repos.length) return null;
  const row = await latestForRepositories(
    pool,
    [...new Set(repos)].sort(),
    scrubText(normalizeFocus(focus)),
    await installationId(),
  );
  return (await readable(row, actor)) ? view(row!, actor) : null;
}
