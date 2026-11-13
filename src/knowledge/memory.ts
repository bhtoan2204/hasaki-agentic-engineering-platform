import { isEvaluationRun } from "../eval/scope.ts";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.ts";
import { pool, q, one } from "../db/pool.ts";
import { repoPath, repositories, repositoryBaseBranch } from "../repos/service.ts";
import { knowledge } from "./service.ts";

/**
 * Cross-task memory on top of the knowledge registry (category `task_memory`, scope REPOSITORY, loaded on demand).
 *
 * Per completed run and repository two items are written:
 *  - `memory.run-<id>.<repo>.facts`        trust "verified": platform-derived facts only (changed files, commit, the
 *                                           verification/test outcomes). Enabled immediately.
 *  - `memory.run-<id>.<repo>.conclusions`  trust "unverified": what the agents concluded (summaries, decisions). Stored
 *                                           DISABLED — never loaded into a prompt until a human approves it.
 * Agent text is quoted, never phrased as instructions. Each item records repo, commit SHA, run, timestamps and trust;
 * items whose files changed on the base branch since that commit are treated as stale and not loaded.
 */

const exec = promisify(execFile);
/** Bound git while a workflow transaction may be holding row locks. A hang becomes UNKNOWN / skipped, not an open transaction. */
const GIT_TIMEOUT_MS = 30_000;
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec("git", ["-C", cwd, ...args], { maxBuffer: 8 << 20, timeout: GIT_TIMEOUT_MS })
  ).stdout.trim();
const quote = (s: string, max = 1500) =>
  String(s ?? "")
    .replace(/<\/?untrusted_input[^>]*>/gi, "")
    .slice(0, max)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");

export type Trust = "verified" | "unverified" | "approved" | "rejected";
export interface MemoryMeta {
  run_id: number;
  work_item: string | null;
  repo: string;
  commit_sha: string;
  base_branch: string;
  files: string[];
  trust: Trust;
  confidence: "high" | "medium" | "low";
  extracted_at: string;
  sources: string[];
  approved_by?: string;
  approved_at?: string;
}

/** Build the two memory items of one repository from run data (pure: easy to test). */
export function buildMemoryItems(x: {
  runId: number;
  title: string;
  workItem: string | null;
  repo: string;
  sha: string;
  baseBranch?: string;
  files: string[];
  verification?: any;
  independentVerdict?: string | null;
  testsPassed?: boolean | null;
  conclusions: Array<{ step: string; text: string }>;
}) {
  const now = new Date().toISOString();
  const base = {
    run_id: x.runId,
    work_item: x.workItem,
    repo: x.repo,
    commit_sha: x.sha,
    base_branch: x.baseBranch || config.baseBranch,
    files: x.files.slice(0, 50),
    extracted_at: now,
  };
  const keyBase = `memory.run-${x.runId}.${slug(x.repo)}`;
  const facts = [
    `Task ${x.workItem ?? `run #${x.runId}`}: ${x.title}`,
    `Repository ${x.repo} at commit ${x.sha.slice(0, 12)} (run #${x.runId}).`,
    x.files.length
      ? `Files changed for this task:\n${x.files
          .slice(0, 30)
          .map((f) => `- ${f}`)
          .join("\n")}`
      : "No files changed.",
    x.verification
      ? `Build/test verification: ${x.verification.status ?? x.verification.outcome}${x.verification.repairs ? ` after ${x.verification.repairs} repair(s)` : ""}.`
      : "",
    x.independentVerdict ? `Independent verification verdict: ${x.independentVerdict}.` : "",
    x.testsPassed != null ? `Test step: ${x.testsPassed ? "passed" : "failed"}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const items = [
    {
      key: `${keyBase}.facts`,
      title: `${x.workItem ?? `Run #${x.runId}`} — where it changed ${x.repo}`,
      content: facts,
      enabled: true,
      meta: {
        ...base,
        trust: "verified" as Trust,
        confidence: "high" as MemoryMeta["confidence"],
        sources: ["git", "verification", "test step"].filter(
          (s) => s !== "verification" || x.verification,
        ),
      },
    },
  ];
  const concl = x.conclusions.filter((c) => c.text.trim());
  if (concl.length)
    items.push({
      key: `${keyBase}.conclusions`,
      title: `${x.workItem ?? `Run #${x.runId}`} — agent conclusions (${x.repo})`,
      content: [
        "Agent conclusions from a previous task — NOT verified facts. Use as hints only; confirm in the code before relying on them.",
        ...concl.map((c) => `From step "${c.step}":\n${quote(c.text)}`),
      ].join("\n\n"),
      enabled: false,
      meta: {
        ...base,
        trust: "unverified" as Trust,
        confidence: "low" as const,
        sources: concl.map((c) => `step:${c.step}`),
      },
    });
  return items;
}

/** Extract memory from a COMPLETED run. Idempotent (existing keys are left untouched). */
export async function extractRunMemory(runId: number) {
  if (await isEvaluationRun(runId)) return [];
  const run = await one(
    pool,
    "SELECT r.*, w.code AS wi_code FROM workflow_runs r LEFT JOIN work_items w ON w.id = r.work_item_id WHERE r.id = $1",
    [runId],
  );
  if (!run || run.status !== "COMPLETED" || run.owner_id == null) return [];
  const steps = await q(
    pool,
    "SELECT key, type, output FROM workflow_steps WHERE run_id = $1 ORDER BY position",
    [runId],
  );
  const coding = steps.filter((s: any) => s.type === "coding_agent" && s.output);
  const verdict = steps.find((s: any) => s.output?.independent === true)?.output?.verdict ?? null;
  const tests = steps.filter((s: any) => s.type === "command" && s.output && !s.output.skipped);
  const testsPassed = tests.length ? tests.every((s: any) => s.output.passed !== false) : null;
  const conclusions = coding.flatMap((s: any) => [
    { step: s.key, text: String(s.output.summary ?? "") },
    ...((s.output.decisions ?? []) as any[]).map((d) => ({
      step: s.key,
      text: typeof d === "string" ? d : `${d.title ?? ""}: ${d.detail ?? ""}`,
    })),
  ]);
  const written: string[] = [];
  for (const w of await q(
    pool,
    "SELECT repo, branch, path FROM execution_workspaces WHERE run_id = $1 AND subtask_id IS NULL",
    [runId],
  )) {
    // The cleanup step removes the worktree: read the run branch from the repository checkout instead.
    const reg = await repositories.get(w.repo);
    const dir = [w.path, reg ? repoPath(reg) : ""].find((d) => d && existsSync(d));
    if (!dir) continue;
    const ref = dir === w.path ? "HEAD" : `refs/heads/${w.branch}`;
    const sha = await git(dir, "rev-parse", ref).catch(() => "");
    if (!sha) continue;
    const baseBranch = await repositoryBaseBranch(w.repo);
    const files = (
      await git(dir, "diff", "--name-only", `origin/${baseBranch}...${sha}`).catch(() => "")
    )
      .split("\n")
      .filter(Boolean);
    const items = buildMemoryItems({
      runId,
      title: run.title,
      workItem: run.wi_code,
      repo: w.repo,
      sha,
      files,
      baseBranch,
      verification: coding[0]?.output?.verification,
      independentVerdict: verdict,
      testsPassed,
      conclusions,
    });
    for (const it of items) {
      if (await knowledge.get(it.key, pool, run.owner_id ?? null)) continue;
      await knowledge.create({
        key: it.key,
        category: "task_memory",
        scope_type: "REPOSITORY",
        scope_ref: w.repo,
        title: it.title,
        content: it.content,
        enabled: it.enabled,
        applicability: { repos: [w.repo] },
        metadata: { load: "on_demand", description: it.title, memory: it.meta },
        created_by: "memory extraction",
        change_note: `from run #${runId}`,
        ownerId: run.owner_id ?? null,
      });
      written.push(it.key);
    }
  }
  return written;
}

/** Promote (or reject) an agent-conclusion memory item. Only a human call path reaches this. */
export async function reviewMemory(
  key: string,
  decision: "approve" | "reject",
  by: string,
  ownerId: number | null = null,
) {
  const item = await knowledge.get(key, pool, ownerId);
  if (!item || item.category !== "task_memory") throw new Error(`memory item "${key}" not found`);
  const meta = item.versions[0]?.metadata ?? {};
  if (!meta.memory) throw new Error(`"${key}" has no memory provenance`);
  if (!by.trim()) throw new Error("approval needs the reviewer's name");
  const memory = {
    ...meta.memory,
    trust: decision === "approve" ? "approved" : "rejected",
    approved_by: by,
    approved_at: new Date().toISOString(),
  };
  return knowledge.update(
    key,
    {
      enabled: decision === "approve",
      metadata: { ...meta, memory },
      change_note: `${decision}d by ${by}`,
      created_by: by,
    },
    ownerId,
  );
}

export type Freshness = "FRESH" | "STALE" | "UNKNOWN";
/** Remote-tracking refs older than this cannot vouch for "nothing changed since" (the base may have moved upstream). */
export const MEMORY_REF_MAX_AGE_MS = 24 * 3600_000;

const freshCache = new Map<string, Freshness>();
/**
 * Freshness of a memory item against origin/<base> in `repoDir`. Only FRESH items may be loaded.
 *  FRESH   — provenance is complete, the commit exists locally, origin/<base> was fetched recently, and none of the
 *            item's files changed on the base branch since the task (merged unchanged, or untouched since branching).
 *  STALE   — one of the item's files was changed on the base branch after the task.
 *  UNKNOWN — anything that prevents proving freshness: missing provenance (commit / file list / repo), a repo that is
 *            not available, a commit not in this clone (history rewritten), no or old remote-tracking ref, git errors.
 * Missing provenance is never assumed fresh.
 */
export async function memoryFreshness(
  meta: Partial<MemoryMeta> | null | undefined,
  repoDir: string | null,
  opts: { maxRefAgeMs?: number; now?: number } = {},
): Promise<{ state: Freshness; reason: string }> {
  if (!meta || typeof meta !== "object") return { state: "UNKNOWN", reason: "no provenance" };
  if (!meta.commit_sha || !/^[0-9a-f]{7,40}$/i.test(meta.commit_sha))
    return { state: "UNKNOWN", reason: "no commit recorded" };
  if (!Array.isArray(meta.files)) return { state: "UNKNOWN", reason: "no file list recorded" };
  if (!repoDir || !existsSync(repoDir))
    return { state: "UNKNOWN", reason: "repository not available locally" };
  const base = `origin/${meta.base_branch || config.baseBranch}`;
  const baseSha = await git(
    repoDir,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/${base}`,
  ).catch(() => "");
  if (!baseSha) return { state: "UNKNOWN", reason: `${base} not available` };
  // Age of the last fetch: an old remote-tracking ref cannot prove that the base did not move.
  const commonDir = await git(
    repoDir,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ).catch(() => "");
  const fetched = commonDir
    ? [join(commonDir, "FETCH_HEAD"), join(commonDir, "refs", "remotes", base)].map((f) =>
        existsSync(f) ? statSync(f).mtimeMs : 0,
      )
    : [0];
  const age = (opts.now ?? Date.now()) - Math.max(...fetched);
  if (age > (opts.maxRefAgeMs ?? MEMORY_REF_MAX_AGE_MS))
    return {
      state: "UNKNOWN",
      reason: `${base} was last fetched too long ago to vouch for freshness`,
    };
  const exists = await git(repoDir, "cat-file", "-e", `${meta.commit_sha}^{commit}`).then(
    () => true,
    () => false,
  );
  if (!exists)
    return {
      state: "UNKNOWN",
      reason: `commit ${meta.commit_sha.slice(0, 12)} is not in this clone (history rewritten or another clone)`,
    };
  if (!meta.files.length) return { state: "FRESH", reason: "no files to go stale" };
  const k = `${repoDir}|${meta.commit_sha}|${baseSha}|${meta.files.join(",")}`;
  const cached = freshCache.get(k);
  if (cached) return { state: cached, reason: "cached" };
  try {
    // Files changed on the base since the branch point AND different from the task commit → edited after the task.
    const mb = await git(repoDir, "merge-base", meta.commit_sha, baseSha);
    const changedOnBase = await git(
      repoDir,
      "diff",
      "--name-only",
      mb,
      baseSha,
      "--",
      ...meta.files,
    );
    const differsFromTask = await git(
      repoDir,
      "diff",
      "--name-only",
      meta.commit_sha,
      baseSha,
      "--",
      ...meta.files,
    );
    const state: Freshness = changedOnBase && differsFromTask ? "STALE" : "FRESH";
    freshCache.set(k, state);
    return {
      state,
      reason:
        state === "STALE"
          ? `changed on ${base} since the task: ${differsFromTask.split("\n").slice(0, 5).join(", ")}`
          : "unchanged since the task",
    };
  } catch (e) {
    return { state: "UNKNOWN", reason: `git error: ${(e as Error).message.split("\n")[0]}` };
  }
}

/** Compatibility wrapper: anything not provably FRESH counts as stale (fail closed). */
export async function isStale(meta: MemoryMeta, repoDir: string): Promise<boolean> {
  return (await memoryFreshness(meta, repoDir)).state !== "FRESH";
}
