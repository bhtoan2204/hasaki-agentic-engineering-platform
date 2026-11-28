import type pg from "pg";
import { config } from "../config.ts";
import { pool, withTx } from "../db/pool.ts";
import { subscribe } from "../db/listener.ts";
import { background } from "../workflow/background.ts";
import { ignoreError } from "../ignoreError.ts";
import type { SharedKey } from "./key.ts";
import { sharingHooks, type SharedActor, type SharedOutcomeName } from "./hooks.ts";
import { retryState } from "./policy.ts";
import { scrubKeyParts } from "./scrub.ts";
import {
  attachRun,
  byId,
  insertRunning,
  latestVersion,
  recordUse,
  validVersions,
  type Provenance,
  type SharedRow,
} from "./repository.ts";

/**
 * Lookup-before-compute with single-flight (docs/shared-results/PLAN.md, section 4.2):
 *  hit    a servable result the caller may read: returned, no model call. While a re-run (a newer version) is running or has
 *         failed, this is the newest valid version the caller may read, with a note about the newer one;
 *  wait   an analysis of this key is running and the caller may read it: no second run, the caller waits on it;
 *  miss   nothing usable: this call claimed the key and started the analysis in the SAME transaction as the claim;
 *  forced the same as a miss, but the caller asked for a re-run: a NEW VERSION of the key (the previous valid version is
 *         superseded only when this one is published, so readers keep a valid result meanwhile);
 *  bypass the existing result or running analysis is not for this caller (access), or a new start is not allowed yet (failed,
 *         in backoff or out of attempts): the caller runs its own analysis outside sharing, exactly as before. The row is
 *         returned only when the caller may read it (otherwise null: not even who ran it crosses an access boundary).
 *
 * Single-flight is the database's: the partial unique index shared_analyses_one_running. Two claims of one key (two
 * requests, two instances, a force while another run is going) cannot both commit a running row: the second blocks on the
 * first transaction, then fails with 23505 and looks again (it is now a waiter). A force never starts a second run beside
 * a running one. The claim and the run commit together, so a crash before the commit leaves neither a claim nor a run, and
 * a crash after it leaves a run whose end the reconcile task settles (settle.ts).
 *
 * Lookup itself runs one latestVersion SELECT (plus validVersions only when a newer version is running/failed), followed by
 * `canReadShared` (cached repo grants when warm or 3 SELECTs when cold; 1 batched `user_secrets` query for personal log
 * access on runtime RCA), and one background statement to record the use and reuse counter.
 */
export type LookupResult =
  | {
      outcome: "hit";
      analysis: SharedRow;
      /** A newer version of this key is running (a re-run) or failed; the served one is the last valid result. */
      newer?: { version: number; status: "running" | "failed" };
    }
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

function proposedRow(r: LookupRequest, now: Date, latest: SharedRow | null): SharedRow {
  return {
    id: 0,
    kind: r.key.kind,
    key: r.key.key,
    version: (latest?.version ?? 0) + 1,
    status: "running",
    key_parts: r.key.parts,
    scope_repos: [...new Set(r.scopeRepos ?? [])].sort(),
    error_key: r.errorKey ?? null,
    result: null,
    source_run_id: null,
    created_by: r.actor.id,
    created_by_name: r.actor.username ?? null,
    trigger: r.force ? "force" : (r.trigger ?? "manual"),
    provider: r.provenance?.provider ?? null,
    model: r.provenance?.model ?? null,
    definition_version: r.provenance?.definitionVersion ?? null,
    rubric_hash: r.provenance?.rubricHash ?? null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    duration_ms: null,
    observed: null,
    started_at: now,
    finished_at: null,
    valid_until: null,
    stale_reason: null,
    failure: null,
    attempts: 0,
    next_retry_at: null,
    reuse_count: 0,
    last_reused_at: null,
  };
}

export async function lookupOrStart(r: LookupRequest): Promise<LookupResult> {
  const hooks = sharingHooks();
  const { kind, key } = r.key;
  const begun = performance.now();
  const scope = typeof r.key.parts.scope === "string" ? r.key.parts.scope : null;
  const note = (
    outcome: SharedOutcomeName,
    row: SharedRow | null,
    runId: number | null = null,
    extra: { reason?: string; tokensSaved?: number } = {},
  ) =>
    hooks.observe({
      kind,
      outcome,
      analysisId: row?.id ?? null,
      version: row?.version ?? null,
      runId,
      actorId: r.actor.id,
      key,
      scope,
      durationMs: outcome === "lost_race" ? undefined : performance.now() - begun,
      ...extra,
    });
  const saved = (row: SharedRow) =>
    row.tokens_in != null ? row.tokens_in + (row.tokens_out ?? 0) : null;
  const use = (row: SharedRow, outcome: "hit" | "wait" | "miss" | "forced") =>
    background("shared use", () =>
      recordUse(pool, row.id, r.actor.id, outcome, outcome === "hit" ? saved(row) : null).catch(
        ignoreError("shared.use"),
      ),
    );
  for (let attempt = 1; ; attempt++) {
    const now = new Date();
    const latest = await latestVersion(pool, kind, key);
    // The version a reader gets: the latest one when it is valid, otherwise (a re-run is running, or it failed) the newest
    // valid version the caller may read. Access is checked on every candidate version, not once for the key.
    const candidates =
      latest?.status === "valid"
        ? [latest]
        : latest && (latest.status === "running" || latest.status === "failed")
          ? await validVersions(pool, kind, key)
          : [];
    let served: SharedRow | null = null;
    let unreadable = false;
    for (const c of candidates) {
      if (!hooks.servable(c, now)) continue;
      if (await hooks.canRead(c, r.actor)) {
        served = c;
        break;
      }
      unreadable = true;
    }
    // A valid result the caller may not read is never replaced by the caller's own run (a hit or a force): that would
    // supersede it for everyone who may read it. The caller runs unshared.
    if (!served && unreadable) {
      note("bypass", latest, null, { reason: "access" });
      return { outcome: "bypass", analysis: null };
    }
    if (served && !r.force) {
      const newer =
        latest &&
        latest.id !== served.id &&
        (latest.status === "running" || latest.status === "failed")
          ? { version: latest.version, status: latest.status }
          : undefined;
      use(served, "hit");
      note("hit", served, served.source_run_id, { tokensSaved: saved(served) ?? undefined });
      return { outcome: "hit", analysis: served, ...(newer ? { newer } : {}) };
    }
    if (latest?.status === "running") {
      if (!(await hooks.canRead(latest, r.actor))) {
        note("bypass", latest, null, { reason: "access" });
        return { outcome: "bypass", analysis: null };
      }
      use(latest, "wait");
      note("wait", latest, latest.source_run_id);
      return { outcome: "wait", analysis: latest };
    }
    // A member without access to read a runtime RCA (log access) must not claim or publish one (REVIEW.md N8).
    if (
      kind === "prod_error.runtime_rca" &&
      !(await hooks.canRead(proposedRow(r, now, latest), r.actor))
    ) {
      note("bypass", latest, null, { reason: "access" });
      return { outcome: "bypass", analysis: null };
    }
    // A failed key is held back by its backoff and its attempt limit; a force re-run is the way past both.
    if (!r.force && !hooks.mayStart(latest, now)) {
      const held = latest ? retryState(latest, now).state : "none";
      note("bypass", latest, null, { reason: held === "none" ? "not_allowed" : held });
      return {
        outcome: "bypass",
        analysis: latest && (await hooks.canRead(latest, r.actor)) ? latest : null,
      };
    }
    try {
      const claimed = await withTx(async (client, afterCommit) => {
        const row = await insertRunning(client, {
          kind,
          key,
          keyParts: scrubKeyParts(r.key.parts),
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
      return { outcome, analysis: claimed.row, runId: claimed.runId };
    } catch (e) {
      // Another request or instance claimed the key between our lookup and our insert: look again (now a wait, or
      // already a hit). Anything else (the workflow refused to start) is the caller's error, and nothing was kept.
      if (!isUniqueViolation(e) || attempt >= MAX_CLAIM_ATTEMPTS) throw e;
      note("lost_race", null);
    }
  }
}

export type WaitResult =
  | { status: "valid" | "failed" | "stale" | "superseded"; analysis: SharedRow }
  | { status: "timeout"; analysis: SharedRow }
  | { status: "denied"; analysis: null };

/**
 * Wait until a running analysis is settled, or until `timeoutMs`. Woken by the `shared_analysis` notification that
 * settling sends; a poll is the backstop (a notification sent while the listener reconnects is lost).
 * Access is checked again on the row returned: a waiter who cannot read it now (access lost meanwhile, or never had it)
 * gets "denied" and no row.
 */
export async function waitForAnalysis(
  id: number,
  actor: SharedActor,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<WaitResult> {
  const r = await waitSettled(id, opts);
  if (await sharingHooks().canRead(r.analysis, actor)) return r;
  sharingHooks().observe({
    kind: r.analysis.kind,
    outcome: "denied",
    analysisId: r.analysis.id,
    version: r.analysis.version,
    runId: null,
    actorId: actor.id,
    key: r.analysis.key,
    scope: typeof r.analysis.key_parts.scope === "string" ? r.analysis.key_parts.scope : null,
    reason: "access",
  });
  return { status: "denied", analysis: null };
}

async function waitSettled(
  id: number,
  opts: { timeoutMs?: number; pollMs?: number },
): Promise<Exclude<WaitResult, { status: "denied" }>> {
  const timeoutMs = opts.timeoutMs ?? config.sharedResults.waitTimeoutMs;
  const pollMs = opts.pollMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  let wake: () => void = () => {};
  let woken = false;
  const onUpdate = () => {
    woken = true;
    wake();
  };
  const unsubscribe = subscribe(
    "shared_analysis",
    (payload) => {
      if (payload === String(id)) onUpdate();
    },
    onUpdate,
  );
  try {
    // Wait until LISTEN is active before the initial snapshot read, otherwise a settle between read and LISTEN is lost.
    let readyTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      unsubscribe.ready.catch(() => {}),
      new Promise<void>((resolve) => {
        readyTimer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      }),
    ]);
    clearTimeout(readyTimer);
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
