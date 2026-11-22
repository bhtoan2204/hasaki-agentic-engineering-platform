/**
 * Source revision consistency for a run. The first source-dependent agent step pins, per repository, the base
 * commit it saw (origin/<branch> after the freshness check in prepareRepository) in workflow_runs.source_revisions.
 * Later steps read the pin:
 *  - new run worktrees are created from it (git/provider.ts), so Implement starts where Analyze/Plan looked;
 *  - an analysis step whose checkout is no longer at the pin records an explicit `source_revision` transition and is
 *    told both commits, so it reads the pinned source instead of silently using a different one.
 * Nothing here resets, rebases or moves a checkout or worktree.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pool, one } from "../db/pool.ts";
import { noteDecision } from "./decisions.ts";
import { lastFreshness, trackingRef, type Freshness } from "../repos/freshness.ts";

const exec = promisify(execFile);
const head = (path: string) =>
  exec("git", ["-C", path, "rev-parse", "--verify", "HEAD^{commit}"], { timeout: 30_000 })
    .then((r) => r.stdout.trim())
    .catch(() => null);

export interface PinnedRevision {
  branch: string;
  commit: string;
  checkout_head: string | null;
  remote_commit: string | null;
  freshness: Freshness["status"] | "no_remote";
  fetched: boolean;
  pinned_at: string;
  step: string;
}
export type SourceRevisions = Record<string, PinnedRevision>;

export interface RevisionView {
  repo: string;
  pinned: PinnedRevision;
  /** The commit the agent's checkout is at now (analysis steps read it directly). */
  head: string | null;
  /** This step pinned it. */
  pinnedNow: boolean;
  drift: boolean;
}

export const readPins = async (runId: number) =>
  (
    await one<{ s: SourceRevisions | null }>(
      pool,
      "SELECT source_revisions AS s FROM workflow_runs WHERE id = $1",
      [runId],
    )
  )?.s ?? {};

/** Pin (first writer wins) or compare, for each prepared checkout of the step. */
export async function resolveSourceRevisions(x: {
  runId: number;
  stepId: number;
  stepKey: string;
  attemptId: number;
  generation: number;
  mode: "analysis" | "coding";
  checkouts: Record<string, { path: string; branch: string }>;
}): Promise<RevisionView[]> {
  const out: RevisionView[] = [];
  for (const [repo, { path, branch }] of Object.entries(x.checkouts)) {
    const h = await head(path);
    let pins = await readPins(x.runId);
    let pinnedNow = false;
    if (!pins[repo]) {
      const fresh = lastFreshness.get(path);
      const base = (await trackingRef(path, branch)) ?? h;
      if (!base) continue;
      const pin: PinnedRevision = {
        branch,
        commit: base,
        checkout_head: h,
        remote_commit: fresh?.remote ?? null,
        freshness: fresh?.status ?? "no_remote",
        fetched: !!fresh?.fetched,
        pinned_at: new Date().toISOString(),
        step: x.stepKey,
      };
      const row = await one<{ s: SourceRevisions }>(
        pool,
        `UPDATE workflow_runs SET source_revisions = COALESCE(source_revisions, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
          WHERE id = $1 AND NOT (COALESCE(source_revisions, '{}'::jsonb) ? $2) RETURNING source_revisions AS s`,
        [x.runId, repo, JSON.stringify(pin)],
      );
      pinnedNow = !!row;
      pins = row?.s ?? (await readPins(x.runId));
      if (pinnedNow)
        await noteDecision({
          runId: x.runId,
          stepId: x.stepId,
          attemptId: x.attemptId,
          generation: x.generation,
          kind: "source_revision",
          action: "RECORD",
          outcome: "applied",
          reason: `${repo} pinned to ${branch}@${base.slice(0, 12)} (${pin.freshness}${pin.fetched ? ", fetched" : ""})`,
          details: { repo, ...pin },
        });
    }
    const pinned = pins[repo];
    if (!pinned) continue;
    // Coding steps work in a worktree created from the pin; only an analysis step reads the checkout itself.
    const drift = x.mode === "analysis" && !!h && h !== pinned.commit;
    if (drift)
      await noteDecision({
        runId: x.runId,
        stepId: x.stepId,
        attemptId: x.attemptId,
        generation: x.generation,
        kind: "source_revision",
        action: "RECONCILE",
        outcome: "applied",
        reason: `${repo}: checkout at ${h!.slice(0, 12)} differs from the run's pinned ${pinned.commit.slice(0, 12)}; the step reads the pinned revision`,
        details: { repo, pinned: pinned.commit, checkout_head: h },
      });
    out.push({ repo, pinned, head: h, pinnedNow, drift });
  }
  return out;
}

/** The prompt section: which revision to analyse, and how to read it when the checkout is elsewhere. */
export function revisionNote(views: RevisionView[]): string | null {
  if (!views.length) return null;
  return views
    .map((v) => {
      const pin = v.pinned.commit;
      const line = `- ${v.repo}: ${v.pinned.branch}@${pin.slice(0, 12)} (pinned by step "${v.pinned.step}"${v.pinned.freshness === "current" || v.pinned.freshness === "refreshed" ? ", verified current with the remote when pinned" : ""}).`;
      return v.drift
        ? `${line} Your checkout is at ${v.head!.slice(0, 12)}, not the pinned revision: base every conclusion on ${pin.slice(0, 12)}. See what differs with \`git diff --stat ${pin} HEAD\` and read pinned files with \`git show ${pin}:<path>\`. Do not look for other copies of the repository.`
        : line;
    })
    .join("\n");
}
