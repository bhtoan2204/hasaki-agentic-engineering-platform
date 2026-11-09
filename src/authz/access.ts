import { pool, q, one } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import type { PublicUser } from "../auth/users.ts";

export type Actor = PublicUser;

export function wantsSupport(actor: Actor, scope: string | null) {
  return actor.role === "admin" && scope === "all";
}

export async function audit(actorId: number, action: string, resourceType: string, resourceId: string, detail: unknown = {}) {
  await q(pool, "INSERT INTO audit_log (actor_id, action, resource_type, resource_id, detail) VALUES ($1, $2, $3, $4, $5)", [
    actorId,
    action,
    resourceType,
    resourceId,
    JSON.stringify(detail ?? {}),
  ]);
}

/** Private rows with a null owner stay hidden, including from admins, until claim-legacy. */
export async function requireOwner(actor: Actor, ownerId: number | null, support: boolean, resourceType: string, resourceId: string) {
  if (ownerId == null) throw new HttpError(404, "not found");
  if (Number(ownerId) === actor.id) return;
  if (!(support && actor.role === "admin")) throw new HttpError(404, "not found");
  await audit(actor.id, "support.access", resourceType, resourceId);
}

/**
 * A run's owner never changes once set (only legacy ownerless runs are claimed, NULL → admin), so non-NULL owners are
 * cached: every run route checks ownership first, and with a remote database that check is a full round trip.
 */
const runOwners = new Map<number, number>();
export async function requireRun(actor: Actor, runId: number, support: boolean) {
  let owner = runOwners.get(runId) ?? null;
  if (owner == null) {
    const row = await one<{ owner_id: number | null }>(pool, "SELECT owner_id FROM workflow_runs WHERE id = $1", [runId]);
    if (!row) throw new HttpError(404, "not found");
    owner = row.owner_id == null ? null : Number(row.owner_id);
    if (owner != null) {
      if (runOwners.size >= 20000) runOwners.delete(runOwners.keys().next().value!);
      runOwners.set(runId, owner);
    }
  }
  await requireOwner(actor, owner, support, "run", String(runId));
}

export async function requireWorkItem(actor: Actor, id: number, support: boolean) {
  const row = await one<{ owner_id: number | null }>(pool, "SELECT owner_id FROM work_items WHERE id = $1", [id]);
  if (!row) throw new HttpError(404, "not found");
  await requireOwner(actor, row.owner_id, support, "work_item", String(id));
}

export async function requireAttempt(actor: Actor, attemptId: number, support: boolean) {
  const row = await one<{ run_id: number; owner_id: number | null }>(
    pool,
    "SELECT a.run_id, r.owner_id FROM workflow_step_attempts a JOIN workflow_runs r ON r.id = a.run_id WHERE a.id = $1",
    [attemptId],
  );
  if (!row) throw new HttpError(404, "not found");
  await requireOwner(actor, row.owner_id, support, "run", String(row.run_id));
  return row.run_id;
}

export async function requireArtifact(actor: Actor, artifactId: number, support: boolean) {
  const row = await one<{ run_id: number; owner_id: number | null }>(
    pool,
    "SELECT a.run_id, r.owner_id FROM workflow_artifacts a JOIN workflow_runs r ON r.id = a.run_id WHERE a.id = $1",
    [artifactId],
  );
  if (!row) throw new HttpError(404, "not found");
  await requireOwner(actor, row.owner_id, support, "run", String(row.run_id));
}

export async function requireSnapshot(actor: Actor, snapshotId: number, support: boolean) {
  const row = await one<{ run_id: number; owner_id: number | null }>(
    pool,
    "SELECT s.run_id, r.owner_id FROM context_snapshots s JOIN workflow_runs r ON r.id = s.run_id WHERE s.id = $1",
    [snapshotId],
  );
  if (!row) throw new HttpError(404, "not found");
  await requireOwner(actor, row.owner_id, support, "run", String(row.run_id));
}

/** Every id must be visible before the caller writes. A mix of owned and foreign ids fails as a whole. */
export async function assertQuestionsAccessible(actor: Actor, support: boolean, answers: Record<string, string>) {
  const ids = Object.entries(answers ?? {})
    .filter(([, value]) => String(value ?? "").trim())
    .map(([id]) => Number(id));
  if (!ids.length) throw new HttpError(400, "no answers given");
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new HttpError(404, "not found");
  const rows = await q<{ id: number; owner_id: number | null }>(
    pool,
    "SELECT q.id, r.owner_id FROM workflow_questions q JOIN workflow_runs r ON r.id = q.run_id WHERE q.id = ANY($1)",
    [ids],
  );
  if (rows.length !== ids.length) throw new HttpError(404, "not found");
  for (const row of rows) await requireOwner(actor, row.owner_id, support, "question", String(row.id));
}

export function requireAdmin(actor: Actor) {
  if (actor.role !== "admin") throw new HttpError(403, "admin only");
}
