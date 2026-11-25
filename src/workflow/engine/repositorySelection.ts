import { EngineError, lockRun } from "../mutations.ts";
import { q, type Db } from "../../db/pool.ts";
import { effectivePermissions } from "../../repos/access.ts";
import { runEvents } from "../events.ts";
import type { RunRow } from "../types.ts";
import { txThenRun } from "./shared.ts";

export async function setSelectedRepositories(c: Db, run: RunRow, repos: string[]) {
  const clean = [...new Set(repos.map(String))];
  const outside = clean.filter((r) => !run.allowed_repositories.includes(r));
  if (outside.length)
    throw new EngineError(`repositories outside the allowed set: ${outside.join(", ")}`, 400);
  // The persisted scope may predate a revocation: the owner must still be able to read every selected repository.
  if (clean.length && run.owner_id != null) {
    const perms = await effectivePermissions(Number(run.owner_id), {
      db: c,
      project: String(run.inputs?.project ?? ""),
    });
    const lost = clean.filter((r) => !perms.get(r)?.effective.read);
    if (lost.length)
      throw new EngineError(`repository access revoked for the run owner: ${lost.join(", ")}`, 403);
  }
  await q(
    c,
    "UPDATE workflow_runs SET selected_repositories = $2, updated_at = now() WHERE id = $1",
    [run.id, clean],
  );
  run.selected_repositories = clean;
  await runEvents.add(
    c,
    run.id,
    "system",
    `selected repositories: ${clean.join(", ") || "(none)"}`,
  );
}

export async function selectRepositories(runId: number, repos: string[]) {
  return txThenRun(runId, async (c) => {
    const run = await lockRun(c, runId);
    await setSelectedRepositories(c, run, repos);
    return;
  });
}
