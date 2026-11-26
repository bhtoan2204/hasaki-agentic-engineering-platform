import { canStart, isServable } from "./policy.ts";
import { canReadShared } from "./access.ts";
import { scrubResult } from "./scrub.ts";
import { recordSharedEvent } from "./telemetry.ts";
import { isDescendant } from "./ancestry.ts";
import type { SharedRow } from "./repository.ts";
import type { SharedKind } from "./key.ts";
import type { SharedEvent } from "./types.ts";

export type { SharedEvent, SharedOutcomeName } from "./types.ts";
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
  observe(event: SharedEvent): void;
  /** Is `commit` a descendant of `ancestor` in the repository? null: cannot be told (nothing is then marked stale). */
  descends(repo: string, ancestor: string, commit: string): Promise<boolean | null>;
}

export const DEFAULT_HOOKS: SharingHooks = {
  canRead: (row, actor) => canReadShared(row, actor),
  servable: (row, now) => isServable(row, now),
  mayStart: (latest, now) => canStart(latest, now),
  scrub: (kind, result) => scrubResult(kind, result),
  observe: (e) => recordSharedEvent(e),
  descends: (repo, ancestor, commit) => isDescendant(repo, ancestor, commit),
};

let current: SharingHooks = DEFAULT_HOOKS;
export const sharingHooks = () => current;
/** Later steps (and tests) replace hooks; the parts not given keep their current behaviour. */
export function setSharingHooks(patch: Partial<SharingHooks>) {
  current = { ...current, ...patch };
}
export const resetSharingHooks = () => void (current = DEFAULT_HOOKS);
