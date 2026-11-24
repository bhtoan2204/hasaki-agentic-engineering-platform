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
  step?: { config?: Record<string, unknown> | null };
  input?: { upstream: Record<string, { output?: unknown } | undefined> };
  log(kind: "system", content: string, data?: unknown): Promise<void>;
}

type Target = { repo: string; files: string[]; symbols: string[] };
const strings = (v: unknown, n: number) =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && !!x).slice(0, n);

/** The files and symbols a step's output says it will change: `target` (one or a list) or proposal `changes`. */
export function proposedTargets(output: unknown): Target[] {
  const o = (output && typeof output === "object" ? output : {}) as Record<string, unknown>;
  const items = [o.target, o.changes].flatMap((v) => (Array.isArray(v) ? v : v ? [v] : []));
  const byRepo = new Map<string, Target>();
  for (const item of items) {
    const t = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (typeof t.repo !== "string" || !t.repo) continue;
    const cur = byRepo.get(t.repo) ?? { repo: t.repo, files: [], symbols: [] };
    const files = typeof t.files === "string" ? [t.files] : strings(t.files, 200);
    cur.files = [...new Set([...cur.files, ...files])].slice(0, 200);
    cur.symbols = [...new Set([...cur.symbols, ...strings(t.symbols, 20)])].slice(0, 20);
    byRepo.set(t.repo, cur);
  }
  return [...byRepo.values()];
}

/**
 * Whether the blast radius of a proposed change is established from the platform's indexes: every target repository
 * analysed, with no limitation other than the inherent one of a change that does not exist yet (only file names).
 */
export function blastRadiusOf(results: Array<Record<string, unknown>>) {
  const reasons: string[] = [];
  if (!results.length) reasons.push("no target files or symbols were named");
  const confirmed: unknown[] = [];
  const uncertain: unknown[] = [];
  for (const r of results) {
    if (r.error) {
      reasons.push(`${r.repository}: ${r.error}`);
      continue;
    }
    const analysis = (r.analysis ?? {}) as { status?: string; limitations?: string[] };
    if (analysis.status === "stale" || analysis.status === "unsupported")
      reasons.push(`${r.repository}: analysis ${analysis.status}`);
    for (const l of analysis.limitations ?? [])
      if (!l.startsWith("only file names were given")) reasons.push(`${r.repository}: ${l}`);
    for (const i of Array.isArray(r.impacts) ? (r.impacts as Array<Record<string, unknown>>) : []) {
      const entry = { repo: i.repo, kind: i.kind, key: i.key, relation: i.relation };
      (i.confidence === "static" ? confirmed : uncertain).push(entry);
    }
  }
  return {
    established: reasons.length === 0,
    reasons: reasons.slice(0, 20),
    confirmed: confirmed.slice(0, 50),
    uncertain: uncertain.slice(0, 50),
  };
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
    const from = ctx.step?.config?.from;
    if (typeof from === "string") return await proposedImpact(ctx, from);
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

/**
 * Proposal mode (`config.from`): the cross-repository blast radius of a change that does not exist yet, from the files
 * and symbols the named step targets. Read-only and deterministic like the diff mode; never fails the run.
 */
async function proposedImpact(ctx: ImpactContext, from: string): Promise<ExecResult> {
  const owner = Number(ctx.run.owner_id);
  if (!Number.isSafeInteger(owner) || owner <= 0)
    return {
      kind: "completed",
      output: {
        mode: "proposal",
        repositories: [],
        blast_radius: blastRadiusOf([{ repository: "(run)", error: "run has no owner" }]),
      },
    };
  const run = await one<{ allowed_repositories: string[]; selected_repositories: string[] }>(
    pool,
    "SELECT allowed_repositories, selected_repositories FROM workflow_runs WHERE id=$1",
    [ctx.run.id],
  );
  const scope = [
    ...new Set([...(run?.allowed_repositories ?? []), ...(run?.selected_repositories ?? [])]),
  ];
  const results: Array<Record<string, unknown>> = [];
  for (const t of proposedTargets(ctx.input?.upstream[from]?.output)) {
    if (scope.length && !scope.includes(t.repo)) {
      results.push({ repository: t.repo, error: "repository outside this run's scope" });
      continue;
    }
    results.push(
      await analyzeImpact(owner, {
        repository: t.repo,
        files: t.files,
        symbols: t.symbols,
        allowedRepositories: scope.length ? scope : undefined,
      }).then(
        (r) => r as unknown as Record<string, unknown>,
        (e: Error) => ({
          repository: t.repo,
          error: e.message.replace(/\/[^\s'"]+/g, "<path>").slice(0, 300),
        }),
      ),
    );
  }
  const blast = blastRadiusOf(results);
  await ctx.log(
    "system",
    `blast radius (proposal from ${from}): ${blast.confirmed.length} confirmed and ${blast.uncertain.length} uncertain cross-repository dependency(ies) — ${blast.established ? "established" : `NOT established: ${blast.reasons.slice(0, 3).join("; ")}`}`,
    { blast_radius: { established: blast.established, reasons: blast.reasons.length } },
  );
  return {
    kind: "completed",
    output: { mode: "proposal", from, repositories: results, blast_radius: blast },
  };
}
