import { pool } from "../db/pool.ts";
import { sharingHooks } from "./hooks.ts";
import { changesBetween, formatReasons, modelIdentity, type KeyChange } from "./policy.ts";
import { markStale, olderOfSubject, type SharedRow } from "./repository.ts";

/**
 * A change of commits is a reason only when it is provably newer code: for EVERY repository that moved, the new commit is a
 * descendant of the old one. A rewind, a divergent branch, or a relation that cannot be told keeps the old result (it is
 * shown with its age, not marked stale on a guess).
 */
async function confirmed(changes: KeyChange[]) {
  const out: KeyChange[] = [];
  const hooks = sharingHooks();
  for (const c of changes) {
    if (c.code !== "commit_changed") {
      out.push(c);
      continue;
    }
    let newer = c.moved.length > 0;
    for (const m of c.moved)
      if (!m.was || (await hooks.descends(m.repo, m.was, m.now)) !== true) newer = false;
    if (newer) out.push(c);
  }
  return out;
}

/**
 * A result was just published (`row`): older valid results of the same subject under another key that it replaces become
 * stale, with what changed. Runs after the publish, never at claim time: a claimed run that fails or never finishes must not
 * take a good result away. Returns how many were marked.
 */
export async function markReplaced(row: SharedRow) {
  let marked = 0;
  for (const older of await olderOfSubject(pool, row, modelIdentity(row.key_parts))) {
    const reasons = await confirmed(changesBetween(older.key_parts, row.key_parts));
    if (!reasons.length) continue;
    const reason = formatReasons(reasons);
    if (!(await markStale(pool, older.id, reason))) continue;
    marked++;
    sharingHooks().observe({
      kind: row.kind,
      outcome: "stale",
      analysisId: older.id,
      version: older.version,
      runId: null,
      actorId: null,
      key: older.key,
      scope: typeof older.key_parts.scope === "string" ? older.key_parts.scope : null,
      reason,
    });
  }
  return marked;
}
