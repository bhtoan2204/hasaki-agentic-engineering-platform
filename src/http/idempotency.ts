import { createHash } from "node:crypto";
import { pool, one, q, json } from "../db/pool.ts";

/**
 * Idempotency-Key for POSTs that CREATE something (a run, a work item, evidence, a scan). State transitions (approve,
 * answer, re-execute, cancel …) are already guarded by the run row lock + status checks and need no key.
 *
 *   first request   → row (actor, key) inserted with status NULL, the handler runs, its response is stored
 *   same key again  → stored response replayed (same status and body), nothing runs twice
 *   while running   → 409 "already in progress" (the client keeps its button busy until the first one answers)
 *   different body  → 422: a key belongs to exactly one request
 *   handler error   → 5xx/transport failures release the key so the same action can be retried; 4xx are stored
 *                      (the same input fails the same way)
 * Keys are per user. Finished rows older than a day are pruned. An in-progress row (status NULL) is kept:
 * deleting it would let a retry after a crash create a second run.
 */
export const IDEMPOTENT_ROUTES: RegExp[] = [
  /^\/api\/work-items$/,
  /^\/api\/work-items\/import$/,
  /^\/api\/work-items\/\d+\/(runs|analyze)$/,
  /^\/api\/runs$/,
  /^\/api\/runs\/\d+\/steps\/[a-z0-9_-]+\/evidence$/,
  /^\/api\/work\/pick\/\d+$/,
  /^\/api\/prod-errors\/(scan|[0-9a-f]{20}\/investigate)$/,
];

export const needsIdempotency = (method: string, path: string) => method === "POST" && IDEMPOTENT_ROUTES.some((re) => re.test(path));
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export type Claim =
  | { kind: "run"; finish: (status: number, body: unknown) => Promise<void>; release: () => Promise<void> }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "conflict"; status: number; body: { error: string } };

let lastPrune = 0;

/** Drop finished keys only. In-progress keys stay until the handler stores a response or releases them. */
export async function pruneIdempotency() {
  const rows = await q(pool, "DELETE FROM http_idempotency WHERE status IS NOT NULL AND created_at < now() - interval '1 day' RETURNING key");
  return rows.length;
}

export async function claimIdempotency(actorId: number, key: string, route: string, body: unknown): Promise<Claim> {
  if (!KEY_RE.test(key)) return { kind: "conflict", status: 400, body: { error: "invalid Idempotency-Key (8–128 of A-Z a-z 0-9 . _ : -)" } };
  const hash = createHash("sha256").update(`${route}\n${JSON.stringify(body ?? null)}`).digest("hex");
  if (Date.now() - lastPrune > 3600_000) {
    lastPrune = Date.now();
    void pruneIdempotency().catch(() => { });
  }
  const inserted = await one(
    pool,
    "INSERT INTO http_idempotency (actor_id, key, route, request_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (actor_id, key) DO NOTHING RETURNING key",
    [actorId, key, route, hash],
  );
  if (inserted) {
    return {
      kind: "run",
      finish: async (status, out) => {
        if (status >= 500) await q(pool, "DELETE FROM http_idempotency WHERE actor_id = $1 AND key = $2", [actorId, key]);
        else await q(pool, "UPDATE http_idempotency SET status = $3, response = $4 WHERE actor_id = $1 AND key = $2", [actorId, key, status, json(out ?? null)]);
      },
      release: async () => void (await q(pool, "DELETE FROM http_idempotency WHERE actor_id = $1 AND key = $2", [actorId, key])),
    };
  }
  const row = await one(pool, "SELECT route, request_hash, status, response FROM http_idempotency WHERE actor_id = $1 AND key = $2", [actorId, key]);
  if (!row) return claimIdempotency(actorId, key, route, body); // released between the two statements: try again
  if (row.route !== route || row.request_hash !== hash) return { kind: "conflict", status: 422, body: { error: "Idempotency-Key was already used for a different request" } };
  if (row.status == null) return { kind: "conflict", status: 409, body: { error: "the same request is already in progress" } };
  return { kind: "replay", status: row.status, body: row.response };
}
