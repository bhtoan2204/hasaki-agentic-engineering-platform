import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pool, q, one } from "../db/pool.ts";
import { repositoryBaseBranch } from "../repos/service.ts";
import type { ExecResult } from "../workflow/types.ts";
import { analyzeImpact, MAX_DIFF_BYTES } from "./analyze.ts";

const exec = promisify(execFile);
const MAX_UNTRACKED = 50;

/** The part of the executor context the deterministic impact step needs (structural: no executor import cycle). */
interface ImpactContext {
  run: { id: number; owner_id?: number | null };
  log(kind: "system", content: string, data?: unknown): Promise<void>;
}

/**
 * The worktree's change against its merge base with the base branch: committed AND uncommitted edits, plus new
 * untracked files (as additions). Read-only: nothing is staged or written in the worktree.
 */
async function worktreeDiff(path: string, base: string) {
  const git = (args: string[]) =>
    exec("git", ["-C", path, ...args], { maxBuffer: MAX_DIFF_BYTES + 1024, timeout: 30_000 }).then(
      (r) => r.stdout,
    );
  const mergeBase = (
    await git(["merge-base", `origin/${base}`, "HEAD"]).catch(() =>
      git(["merge-base", base, "HEAD"]),
    )
  ).trim();
  let diff = await git(["diff", "--no-color", mergeBase]);
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)
    .slice(0, MAX_UNTRACKED);
  for (const f of untracked) {
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) break;
    // `git diff --no-index` exits 1 when the files differ (always, against /dev/null): the output is the result.
    diff += await exec(
      "git",
      ["-C", path, "diff", "--no-color", "--no-index", "--", "/dev/null", f],
      {
        maxBuffer: MAX_DIFF_BYTES,
        timeout: 10_000,
      },
    ).then(
      (r) => r.stdout,
      (e: { stdout?: string }) => e.stdout ?? "",
    );
  }
  return diff;
}

/**
 * `impact_analysis` integration action: cross-repository impact of the run's changes, as the run owner and limited to
 * the run's allowed repositories. Deterministic and read-only; it never fails the run (errors are reported in its
 * output) — the independent review reads it.
 */
export async function impactAnalysisStep(ctx: ImpactContext): Promise<ExecResult> {
  try {
    const owner = Number(ctx.run.owner_id);
    if (!Number.isSafeInteger(owner) || owner <= 0)
      return { kind: "completed", output: { skipped: "run has no owner", repositories: [] } };
    const run = await one<{ allowed_repositories: string[]; selected_repositories: string[] }>(
      pool,
      "SELECT allowed_repositories, selected_repositories FROM workflow_runs WHERE id=$1",
      [ctx.run.id],
    );
    const scope = [
      ...new Set([...(run?.allowed_repositories ?? []), ...(run?.selected_repositories ?? [])]),
    ];
    const workspaces = await q<{ repo: string; path: string }>(
      pool,
      "SELECT DISTINCT ON (repo) repo, path FROM execution_workspaces WHERE run_id=$1 AND subtask_id IS NULL ORDER BY repo",
      [ctx.run.id],
    );
    const results: Array<Record<string, unknown>> = [];
    for (const w of workspaces) {
      try {
        const diff = await worktreeDiff(w.path, await repositoryBaseBranch(w.repo));
        if (!diff.trim()) {
          results.push({ repository: w.repo, empty_diff: true, impacts: [], breaking: [] });
          continue;
        }
        results.push(
          (await analyzeImpact(owner, {
            repository: w.repo,
            diff: Buffer.byteLength(diff) > MAX_DIFF_BYTES ? undefined : diff,
            files:
              Buffer.byteLength(diff) > MAX_DIFF_BYTES
                ? [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]).slice(0, 200)
                : undefined,
            allowedRepositories: scope.length ? scope : undefined,
          })) as unknown as Record<string, unknown>,
        );
      } catch (e) {
        results.push({
          repository: w.repo,
          error: (e as Error).message.replace(/\/[^\s'"]+/g, "<path>").slice(0, 300),
        });
      }
    }
    const impacts = results.flatMap((r) => (Array.isArray(r.impacts) ? r.impacts : []));
    const breaking = results.flatMap((r) => (Array.isArray(r.breaking) ? r.breaking : []));
    const partial = results.some(
      (r) =>
        r.error ||
        (!r.empty_diff && (r.analysis as { status?: string } | undefined)?.status !== "complete"),
    );
    // Per repository: complete / partial / stale / unsupported (or error) — never an implicit "no impact".
    const statuses = Object.fromEntries(
      results.map((r) => [
        String(r.repository),
        r.error
          ? "error"
          : r.empty_diff
            ? "empty_diff"
            : String((r.analysis as { status?: string } | undefined)?.status ?? "unknown"),
      ]),
    );
    await ctx.log(
      "system",
      `impact analysis: ${impacts.length} cross-repository dependency(ies), ${breaking.length} breaking change(s)${results.some((r) => r.empty_diff) ? ", empty diff in some repositories" : ""}${partial ? ` (INCOMPLETE — ${Object.entries(statuses).map(([k, v]) => `${k}: ${v}`).join(", ")}; no dependency found does not mean no impact)` : ""}`,
      { impact: { impacts: impacts.length, breaking: breaking.length, partial, statuses } },
    );
    return {
      kind: "completed",
      output: {
        repositories: results,
        coordinated_repositories: [
          ...new Set(
            results.flatMap((r) =>
              Array.isArray(r.coordinated_repositories)
                ? (r.coordinated_repositories as string[])
                : [],
            ),
          ),
        ],
        breaking_changes: breaking.length,
        partial,
        statuses,
      },
    };
  } catch (e) {
    return {
      kind: "completed",
      output: {
        error: `impact analysis unavailable: ${(e as Error).message.slice(0, 200)}`,
        repositories: [],
        partial: true,
      },
    };
  }
}
