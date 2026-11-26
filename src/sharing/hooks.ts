import { log } from "../logging.ts";
import { canStart, isServable } from "./policy.ts";
import { canReadShared } from "./access.ts";
import { scrubResult } from "./scrub.ts";
import type { SharedRow } from "./repository.ts";
import type { SharedKind } from "./key.ts";

export type SharedOutcomeName =
  "hit" | "wait" | "miss" | "forced" | "bypass" | "lost_race" | "denied";
export interface SharedActor {
  id: number;
  role?: string;
  /** For the answer's "run by" (the caller already has it). */
  username?: string;
}

/**
 * Where the later steps plug in, without rewriting the lookup (docs/shared-results/PROGRESS.md, step 3):
 *  - step 4 (validity, retry, force): `servable` (TTL and staleness of a valid row) and `mayStart` (failed-row backoff); both
 *    now default to the rules of policy.ts;
 *  - step 5 (access, scrub): `canRead` (who may be served a row) and `scrub` (before a result is stored);
 *  - step 6 (metrics, tracing): `observe` (one call per lookup outcome and per settled row).
 * The defaults are the policies of access.ts (who may read, checked on every read) and scrub.ts (before a result is stored).
 */
export interface SharingHooks {
  canRead(row: SharedRow, actor: SharedActor): boolean | Promise<boolean>;
  servable(row: SharedRow, now: Date): boolean;
  mayStart(latest: SharedRow | null, now: Date): boolean;
  scrub(kind: SharedKind, result: unknown): unknown;
  observe(event: {
    kind: SharedKind;
    outcome: SharedOutcomeName | "published" | "failed" | "expired";
    analysisId: number | null;
    version: number | null;
    runId: number | null;
    actorId: number | null;
  }): void;
}

export const DEFAULT_HOOKS: SharingHooks = {
  canRead: (row, actor) => canReadShared(row, actor),
  servable: (row, now) => isServable(row, now),
  mayStart: (latest, now) => canStart(latest, now),
  scrub: (kind, result) => scrubResult(kind, result),
  // R1: only values already in scope; no query to enrich the line.
  observe: (e) =>
    log.info(
      `shared result ${e.kind}: ${e.outcome} analysis=${e.analysisId ?? "-"} v=${e.version ?? "-"} run=${e.runId ?? "-"} actor=${e.actorId ?? "-"}`,
    ),
};

let current: SharingHooks = DEFAULT_HOOKS;
export const sharingHooks = () => current;
/** Later steps (and tests) replace hooks; the parts not given keep their current behaviour. */
export function setSharingHooks(patch: Partial<SharingHooks>) {
  current = { ...current, ...patch };
}
export const resetSharingHooks = () => void (current = DEFAULT_HOOKS);
