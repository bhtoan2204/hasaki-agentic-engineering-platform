import type pg from "pg";
import { config } from "../config.ts";
import { pool, withTx } from "../db/pool.ts";
import { subscribe } from "../db/listener.ts";
import { background } from "../workflow/background.ts";
import { ignoreError } from "../ignoreError.ts";
import type { SharedKey } from "./key.ts";
import { sharingHooks, type SharedActor, type SharedOutcomeName } from "./hooks.ts";
import { staleReason } from "./policy.ts";
import {
  attachRun,
  byId,
  insertRunning,
  latestVersion,
  markStale,
  olderOfSubject,
  recordUse,
  type Provenance,
  type SharedRow,
} from "./repository.ts";

/**
 * Lookup-before-compute with single-flight (docs/shared-results/PLAN.md, section 4.2):
 *  hit    a servable result the caller may read: returned, no model call;
 *  wait   an analysis of this key is running and the caller may read it: no second run, the caller waits on it;
 *  miss   nothing usable: this call claimed the key and started the analysis in the SAME transaction as the claim;
 *  forced the same as a miss, but the caller asked for a re-run: a NEW VERSION of the key (the previous valid version is
 *         superseded only when this one is published, so readers keep a valid result meanwhile);
 *  bypass the existing result or running analysis is not for this caller (access), or a new start is not allowed yet (failed,
 *         in backoff or out of attempts): the caller runs its own analysis outside sharing, exactly as before.
 *
 * Single-flight is the database's: the partial unique index shared_analyses_one_running. Two claims of one key (two
 * requests, two instances, a force while another run is going) cannot both commit a running row: the second blocks on the
 * first transaction, then fails with 23505 and looks again (it is now a waiter). A force never starts a second run beside
 * a running one. The claim and the run commit together, so a crash before the commit leaves neither a claim nor a run, and
 * a crash after it leaves a run whose end the reconcile task settles (settle.ts).
 *
 * The hit path is one SELECT (the row, its runner's name included). Recording the use and the reuse counter is one
 * statement, run in the background after the answer is ready: it adds no query to the caller's wait.
 */
export type LookupResult =
  | { outcome: "hit"; analysis: SharedRow }
  | { outcome: "wait"; analysis: SharedRow }
  | { outcome: "miss" | "forced"; analysis: SharedRow; runId: number }
  | { outcome: "bypass"; analysis: SharedRow | null };

export interface LookupRequest {
  key: SharedKey;
  actor: SharedActor;
  /** Production errors: the group fingerprint. */
  errorKey?: string | null;
  /** Repositories a reader needs (step 5 checks them). */
  scopeRepos?: string[];
  trigger?: "manual" | "schedule";
  /** A re-run: skip the served result and start a new version (still single-flight, still access-checked). */
  force?: boolean;
  /** What the analysis runs with: stored on the row for provenance. */
  provenance?: Provenance;
  /** Starts the existing workflow inside the claim's transaction and returns its run id. */
  start: (tx: {
    client: pg.PoolClient;
    afterCommit: (cb: () => unknown) => void;
  }) => Promise<number>;
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";
const MAX_CLAIM_ATTEMPTS = 3;
const NO_PROVENANCE: Provenance = {
  provider: null,
  model: null,
  definitionVersion: null,
  rubricHash: null,
};

export async function lookupOrStart(r: LookupRequest): Promise<LookupResult> {
  const hooks = sharingHooks();
  const { kind, key } = r.key;
  const note = (outcome: SharedOutcomeName, row: SharedRow | null, runId: number | null = null) =>
    hooks.observe({
      kind,
      outcome,
      analysisId: row?.id ?? null,
      version: row?.version ?? null,
      runId,
      actorId: r.actor.id,
    });
  const use = (row: SharedRow, outcome: "hit" | "wait" | "miss" | "forced") =>
    background("shared use", () =>
      recordUse(
        pool,
        row.id,
        r.actor.id,
        outcome,
        outcome === "hit" && row.tokens_in != null ? row.tokens_in + (row.tokens_out ?? 0) : null,
      ).catch(ignoreError("shared.use")),
    );
  for (let attempt = 1; ; attempt++) {
    const now = new Date();
    const latest = await latestVersion(pool, kind, key);
    if (latest?.status === "valid" && hooks.servable(latest, now)) {
      // A valid result the caller may not read is never replaced by the caller's own run (a hit or a force): that would
      // supersede it for everyone who may read it. The caller runs unshared.
      if (!(await hooks.canRead(latest, r.actor))) {
        note("bypass", latest);
        return { outcome: "bypass", analysis: latest };
      }
      if (!r.force) {
        use(latest, "hit");
        note("hit", latest, latest.source_run_id);
        return { outcome: "hit", analysis: latest };
      }
    }
    if (latest?.status === "running") {
      if (!(await hooks.canRead(latest, r.actor))) {
        note("bypass", latest);
        return { outcome: "bypass", analysis: latest };
      }
      use(latest, "wait");
      note("wait", latest, latest.source_run_id);
      return { outcome: "wait", analysis: latest };
    }
    // A failed key is held back by its backoff and its attempt limit; a force re-run is the way past both.
    if (!r.force && !hooks.mayStart(latest, now)) {
      note("bypass", latest);
      return { outcome: "bypass", analysis: latest };
    }
    try {
      const claimed = await withTx(async (client, afterCommit) => {
        const row = await insertRunning(client, {
          kind,
          key,
          keyParts: r.key.parts,
          scopeRepos: [...new Set(r.scopeRepos ?? [])].sort(),
          errorKey: r.errorKey ?? null,
          createdBy: r.actor.id,
          trigger: r.force ? "force" : (r.trigger ?? "manual"),
          provenance: r.provenance ?? NO_PROVENANCE,
        });
        const runId = await r.start({ client, afterCommit });
        await attachRun(client, row.id, runId);
        return {
          row: {
            ...row,
            source_run_id: runId,
            created_by_name: r.actor.username ?? row.created_by_name,
          },
          runId,
        };
      });
      const outcome = r.force ? "forced" : "miss";
      use(claimed.row, outcome);
      note(outcome, claimed.row, claimed.runId);
      // Older results of this subject that this key replaces are stale from now on (commit, rubric, model... changed).
      background("shared stale", () =>
        markReplaced(claimed.row).catch(ignoreError("shared.stale")),
      );
      return { outcome, analysis: claimed.row, runId: claimed.runId };
    } catch (e) {
      // Another request or instance claimed the key between our lookup and our insert: look again (now a wait, or
      // already a hit). Anything else (the workflow refused to start) is the caller's error, and nothing was kept.
      if (!isUniqueViolation(e) || attempt >= MAX_CLAIM_ATTEMPTS) throw e;
      note("lost_race", null);
    }
  }
}

/** Mark valid results of the same subject under another key stale, with what changed. */
export async function markReplaced(row: SharedRow) {
  let marked = 0;
  for (const older of await olderOfSubject(pool, row)) {
    const reason = staleReason(older.key_parts, row.key_parts);
    if (!reason) continue;
    await markStale(pool, older.id, reason);
    marked++;
  }
  return marked;
}

export type WaitResult =
  | { status: "valid" | "failed" | "stale" | "superseded"; analysis: SharedRow }
  | { status: "timeout"; analysis: SharedRow };

/**
 * Wait until a running analysis is settled, or until `timeoutMs`. Woken by the `shared_analysis` notification that
 * settling sends; a poll is the backstop (a notification sent while the listener reconnects is lost).
 */
export async function waitForAnalysis(
  id: number,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<WaitResult> {
  const timeoutMs = opts.timeoutMs ?? config.sharedResults.waitTimeoutMs;
  const pollMs = opts.pollMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  let wake: () => void = () => {};
  let woken = false;
  const unsubscribe = subscribe("shared_analysis", (payload) => {
    if (payload !== String(id)) return;
    woken = true;
    wake();
  });
  try {
    for (;;) {
      woken = false;
      const row = await byId(pool, id);
      if (!row) throw new Error(`shared analysis ${id} not found`);
      if (row.status !== "running") return { status: row.status, analysis: row };
      const left = deadline - Date.now();
      if (left <= 0) return { status: "timeout", analysis: row };
      // A notification that arrived while the row was being read must not be slept through.
      if (woken) continue;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(pollMs, left));
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  } finally {
    wake = () => {};
    await unsubscribe().catch(() => {});
  }
}
