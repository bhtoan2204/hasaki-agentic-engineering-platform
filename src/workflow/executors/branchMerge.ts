import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../../config.ts";
import { git } from "../../git.ts";
import { workspacesOf } from "../../git/provider.ts";
import { requireRunRepositoryAccess } from "../../repos/access.ts";
import { repositories, repositoryBaseBranch } from "../../repos/service.ts";
import { repositoryLock } from "../../repos/workspaces.ts";
import { repositoryBranch } from "../../repos/remote.ts";
import { classify, goBaseline, parseGoTest } from "./baseline.ts";
import type { ExecResult, RunRow, StepRow } from "../types.ts";
import type { Untyped } from "../../untyped.ts";
import { ignoreError } from "../../ignoreError.ts";

/** The part of the executor context this action uses (kept local: registry.ts sits in the agent import cycle). */
export interface ExecutionContext {
  run: RunRow;
  step: StepRow;
  input: { upstream: Record<string, { output: Untyped }> };
  signal: AbortSignal;
  log(kind: "system" | "log", content: string, data?: unknown): Promise<void>;
  artifact(kind: string, name: string, content: string, data?: unknown): Promise<number>;
}

export type RunCommand = (
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
  onChunk?: (text: string) => void,
) => Promise<{ code: number | null; output: string; timedOut: boolean }>;

type MergeModel = (run: RunRow, prompt: string, signal: AbortSignal) => Promise<string>;
let model: MergeModel | null = null;
/** The run's provider answers conflict resolutions; registered with the default executors. */
export function setMergeModel(m: MergeModel) {
  model = m;
}

async function ask(ctx: ExecutionContext, prompt: string) {
  if (!model) throw new Error("no model is registered for conflict resolution");
  return model(ctx.run, prompt, ctx.signal);
}

interface MergeResult {
  repo: string;
  status: "merged" | "already_merged" | "skipped";
  reason?: string;
  merge_commit?: string;
  conflicts?: string[];
  tested?: boolean;
  regenerated_mocks?: string[];
  pre_existing_failures?: string[];
}

interface MergeDeps {
  baseline?: typeof goBaseline;
}

const IDENTITY = ["-c", "user.name=platform", "-c", "user.email=platform@local"];
const MARKER = /^(<{7}|={7}|>{7})(\s|$)/m;
const MAX_FILE_CHARS = 150_000;
const MAX_DIFF_CHARS = 20_000;
const PUSH_ATTEMPTS = 3;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…[truncated]" : s);

async function remoteTip(path: string, branch: string): Promise<string | null> {
  try {
    await git(path, "fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  } catch (e) {
    if (/couldn't find remote ref/i.test((e as Error).message)) return null;
    throw e;
  }
  return git(path, "rev-parse", `refs/remotes/origin/${branch}`);
}

const isAncestor = (path: string, a: string, b: string) =>
  git(path, "merge-base", "--is-ancestor", a, b).then(
    () => true,
    () => false,
  );

function resolvedText(reply: string, original: string): string {
  const m = reply.match(/<<<RESOLVED\n([\s\S]*?)\n?RESOLVED>>>/);
  if (!m) throw new Error("the model reply has no <<<RESOLVED … RESOLVED>>> block");
  let text = m[1];
  if (MARKER.test(text)) throw new Error("the resolution still contains conflict markers");
  if (original.endsWith("\n") && !text.endsWith("\n")) text += "\n";
  return text;
}

/**
 * Merge the run's published branches into a shared integration branch (e.g. release/qc) and push it.
 * The merge happens in a detached scratch worktree, never on the run's own branch, so its PR stays clean.
 * Conflicts are resolved by the run's model; a resolved merge is pushed only after `command` (build + test) passes.
 */
export async function mergeIntoBranch(
  ctx: ExecutionContext,
  runCommand: RunCommand,
): Promise<ExecResult> {
  const cfg = ctx.step.config;
  if (cfg.mode === "none")
    return { kind: "completed", output: { skipped: true, reason: "disabled (mode: none)" } };
  const target = repositoryBranch(String(cfg.target ?? "release/qc"));
  const prOut = ctx.input.upstream[String(cfg.pr_from ?? "")]?.output;
  const published = new Set<string>(
    Array.isArray(prOut?.pull_requests)
      ? prOut.pull_requests.map((p: { repo: string }) => p.repo)
      : [],
  );
  const workspaces = (await workspacesOf(ctx.run.id)).filter((w) => published.has(w.repo));
  if (!workspaces.length) {
    await ctx.log("system", `nothing to merge into ${target}: no branch was published in this run`);
    return { kind: "completed", output: { target, merges: [], skipped: true } };
  }
  const merges: MergeResult[] = [];
  for (const w of workspaces) {
    try {
      merges.push(await mergeOne(ctx, runCommand, w, target));
    } catch (e) {
      const error = `${w.repo}: merge into ${target} failed: ${(e as Error).message}`;
      await ctx.log("system", error);
      return { kind: "failed", error, retryable: false };
    }
  }
  return { kind: "completed", output: { target, merges } };
}

async function mergeOne(
  ctx: ExecutionContext,
  runCommand: RunCommand,
  w: { repo: string; branch: string; path: string },
  target: string,
): Promise<MergeResult> {
  const row = await repositories.get(w.repo);
  if (!row?.enabled || !row.allowed_actions.includes("write"))
    throw new Error("repository write permission required");
  await requireRunRepositoryAccess(ctx.run.id, w.repo, "write");
  if ((await repositoryBaseBranch(w.repo)) === target)
    throw new Error(`${target} is the repository's base branch: it only changes through PRs`);
  return mergeAndPush(ctx, runCommand, w, target, (fn) => repositoryLock(row, fn));
}

/** The git part of mergeOne, after the permission checks. `lock` serializes fetch/push on the shared clone. */
export async function mergeAndPush(
  ctx: ExecutionContext,
  runCommand: RunCommand,
  w: { repo: string; branch: string; path: string },
  target: string,
  lock: <T>(fn: () => Promise<T>) => Promise<T>,
  deps: MergeDeps = {},
): Promise<MergeResult> {
  if (!(await git(w.path, "config", "--get", "remote.origin.url").catch(() => "")))
    return { repo: w.repo, status: "skipped", reason: "the repository has no origin remote" };
  const cfg = ctx.step.config;
  const dir = join(
    config.dataDir,
    "merges",
    `run-${ctx.run.id}-${w.repo.replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now()}`,
  );
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    const tips = await lock(async () => ({
      feature: await remoteTip(w.path, w.branch),
      target: await remoteTip(w.path, target),
    }));
    if (!tips.feature)
      return { repo: w.repo, status: "skipped", reason: `${w.branch} is not on the remote` };
    if (!tips.target)
      return { repo: w.repo, status: "skipped", reason: `the remote has no ${target}` };
    if (await isAncestor(w.path, tips.feature, tips.target)) {
      await ctx.log(
        "system",
        `${w.repo}: ${w.branch}@${tips.feature.slice(0, 9)} is already in ${target}`,
      );
      return { repo: w.repo, status: "already_merged" };
    }
    mkdirSync(join(config.dataDir, "merges"), { recursive: true });
    await git(w.path, "worktree", "add", "--detach", dir, tips.target);
    try {
      const conflicts = await merge(ctx, dir, w, target, tips.feature);
      let tested = false;
      let verified: Verification | null = null;
      if (conflicts.length) {
        verified = await testResolution(
          ctx,
          runCommand,
          dir,
          w.repo,
          target,
          conflicts,
          String(cfg.command ?? ""),
          { path: w.path, sha: tips.target },
          deps.baseline ?? goBaseline,
        );
        tested = true;
      }
      const head = await git(dir, "rev-parse", "HEAD");
      await ctx.artifact(
        "diff",
        `${ctx.step.key}-${w.repo}.diff`,
        await git(dir, "diff", `${tips.target}..HEAD`),
        { repo: w.repo, target, merge_commit: head, conflicts },
      );
      const pushed = await lock(() =>
        git(dir, "push", "origin", `HEAD:refs/heads/${target}`).then(
          () => true,
          (e: Error) => {
            if (/non-fast-forward|fetch first|\[rejected\]/.test(e.message)) return false;
            throw e;
          },
        ),
      );
      if (pushed) {
        await ctx.log(
          "system",
          `${w.repo}: merged ${w.branch} into ${target} (${head.slice(0, 9)})${conflicts.length ? `, resolved ${conflicts.length} conflicted file(s)` : ""}`,
        );
        return {
          repo: w.repo,
          status: "merged",
          merge_commit: head,
          conflicts,
          tested,
          ...(verified?.regenerated.length ? { regenerated_mocks: verified.regenerated } : {}),
          ...(verified?.preExisting.length ? { pre_existing_failures: verified.preExisting } : {}),
        };
      }
      await ctx.log(
        "system",
        `${w.repo}: ${target} moved while merging; merging again (${attempt}/${PUSH_ATTEMPTS})`,
      );
    } finally {
      await git(w.path, "worktree", "remove", "--force", dir).catch(
        ignoreError("branch_merge.worktree_remove"),
      );
      rmSync(dir, { recursive: true, force: true });
      await git(w.path, "worktree", "prune").catch(ignoreError("branch_merge.worktree_remove"));
    }
  }
  throw new Error(`${target} kept moving: gave up after ${PUSH_ATTEMPTS} attempts`);
}

/** Merge `sha` into the scratch worktree and commit it; returns the files whose conflicts the model resolved. */
async function merge(
  ctx: ExecutionContext,
  dir: string,
  w: { repo: string; branch: string },
  target: string,
  sha: string,
): Promise<string[]> {
  try {
    await git(
      dir,
      ...IDENTITY,
      "merge",
      "--no-ff",
      "-m",
      `Merge branch '${w.branch}' into ${target}`,
      sha,
    );
    return [];
  } catch (e) {
    const conflicted = (await git(dir, "diff", "--name-only", "--diff-filter=U"))
      .split("\n")
      .filter(Boolean);
    if (!conflicted.length) throw e;
    const status = await git(dir, "status", "--porcelain");
    const structural = status
      .split("\n")
      .filter((l) => /^(DD|AU|UD|UA|DU) /.test(l))
      .map((l) => l.slice(3));
    if (structural.length)
      throw new Error(`delete/rename conflicts need a human: ${structural.join(", ")}`, {
        cause: e,
      });
    await ctx.log(
      "system",
      `${w.repo}: ${conflicted.length} conflicted file(s): ${conflicted.join(", ")}`,
    );
    const base = await git(dir, "merge-base", "HEAD", sha);
    for (const file of conflicted) {
      const current = await readFile(join(dir, file), "utf8");
      if (current.includes("\0")) throw new Error(`${file} is binary`, { cause: e });
      if (current.length > MAX_FILE_CHARS)
        throw new Error(`${file} is too large to resolve`, { cause: e });
      const prompt = [
        `You are resolving a git merge conflict while merging the feature branch \`${w.branch}\` (task: ${ctx.run.title}) into the shared QC branch \`${target}\`.`,
        `Keep both sides: everything ${target} changed (other developers' work) must stay, and the feature's change must be added on top. Drop a side only when both sides made the same change.`,
        `Do not refactor, reformat or change anything outside the conflicted regions.`,
        ``,
        `File: ${file}`,
        `Feature branch change since the merge base:`,
        "```diff",
        clip(await git(dir, "diff", base, sha, "--", file), MAX_DIFF_CHARS),
        "```",
        `${target} change since the merge base:`,
        "```diff",
        clip(await git(dir, "diff", base, "HEAD", "--", file), MAX_DIFF_CHARS),
        "```",
        `Current file with conflict markers:`,
        "```",
        current,
        "```",
        `Reply with the complete resolved file and nothing else, between a line <<<RESOLVED and a line RESOLVED>>>.`,
      ].join("\n");
      const reply = await ask(ctx, prompt);
      await writeFile(join(dir, file), resolvedText(reply, current));
    }
    await git(dir, "add", "--", ...conflicted);
    await git(dir, ...IDENTITY, "commit", "--no-edit");
    return conflicted;
  }
}

interface Verification {
  /** Mock files regenerated by mockgen and kept because that made the build/test pass. */
  regenerated: string[];
  /** Failures accepted because the target branch fails the same way without this merge. */
  preExisting: string[];
}

type Verdict =
  | { ok: true; preExisting: string[] }
  | { ok: false; summary: string; newFailures: boolean; detail?: string };

/** The `go test` output of the given failing tests (their `--- FAIL` blocks) and of any panic, without the others. */
function failureDetail(output: string, tests: string[]) {
  const wanted = new Set(tests.flatMap((t) => [t, t.split("/")[0]]));
  const out: string[] = [];
  let keep = false;
  for (const line of output.split("\n")) {
    const head = /^\s*--- FAIL: (\S+)/.exec(line);
    if (head) keep = wanted.has(head[1]);
    else if (/^panic: /.test(line)) keep = true;
    else if (/^(FAIL|ok|PASS|=== RUN)\b/.test(line)) keep = false;
    if (keep) out.push(line);
  }
  return clip(out.join("\n"), 6000);
}

/** Test files named in failure output (absolute paths inside `dir` or repository-relative), read for context. */
async function failingTestSources(dir: string, text: string, exclude: string[]) {
  const named = new Set<string>();
  for (const m of text.matchAll(/([\w./-]*_test\.go):\d+/g)) {
    const p = m[1].startsWith(dir + "/") ? m[1].slice(dir.length + 1) : m[1];
    if (!p.startsWith("/") && !exclude.includes(p)) named.add(p);
  }
  const sources: Array<{ file: string; text: string }> = [];
  for (const file of [...named].slice(0, 3)) {
    const text = await readFile(join(dir, file), "utf8").catch(() => null);
    if (text !== null) sources.push({ file, text: clip(text, 12000) });
  }
  return sources;
}

const revertTree = async (dir: string) => {
  await git(dir, "reset", "--hard", "HEAD");
  await git(dir, "clean", "-fdq");
};

/**
 * Regenerate the gomock files of the packages this merge touched (QC interfaces drift from prod, so a mock merged from a
 * prod-based branch can be stale). Returns the files that changed; a failed generator leaves the tree untouched.
 */
async function regenerateMocks(
  ctx: ExecutionContext,
  runCommand: RunCommand,
  dir: string,
  repo: string,
  targetSha: string,
  timeoutMs: number,
): Promise<string[]> {
  const touched = new Set(
    (await git(dir, "diff", "--name-only", `${targetSha}..HEAD`))
      .split("\n")
      .filter((f) => f.endsWith(".go"))
      .map((f) => dirname(f)),
  );
  const generating = (
    await git(dir, "grep", "-l", "-E", "^//go:generate .*mockgen", "--", "*.go").catch(() => "")
  )
    .split("\n")
    .filter(Boolean);
  const pkgs = [
    ...new Set(
      generating.map((f) => dirname(f)).filter((d) => touched.has(d) && /^[\w./-]+$/.test(d)),
    ),
  ];
  if (!pkgs.length) return [];
  const r = await runCommand(
    `go generate -run mockgen ${pkgs.map((p) => (p === "." ? "." : `./${p}`)).join(" ")}`,
    dir,
    {},
    timeoutMs,
    ctx.signal,
    (chunk) => void ctx.log("log", chunk, { repo }),
  );
  if (r.code !== 0 || r.timedOut) {
    await ctx.log("system", `${repo}: mock regeneration failed, keeping the merge as resolved`);
    await revertTree(dir);
    return [];
  }
  return [
    ...(await git(dir, "diff", "--name-only")).split("\n"),
    ...(await git(dir, "ls-files", "--others", "--exclude-standard")).split("\n"),
  ].filter(Boolean);
}

/** Build + test the resolved merge; on failure let the model revise the resolved files, then amend the merge commit. */
async function testResolution(
  ctx: ExecutionContext,
  runCommand: RunCommand,
  dir: string,
  repo: string,
  target: string,
  files: string[],
  command: string,
  base: { path: string; sha: string },
  baseline: typeof goBaseline,
): Promise<Verification> {
  if (!command) throw new Error("conflicts were resolved but the step has no build/test command");
  const rounds = Number(ctx.step.config.max_fix_rounds ?? 2);
  const timeoutMs = Number(ctx.step.config.timeout_seconds ?? 900) * 1000;
  const execute = async (label: string) => {
    const r = await runCommand(
      command,
      dir,
      { BASE_BRANCH: target, REPO: repo, BRANCH: target, RUN_ID: String(ctx.run.id) },
      timeoutMs,
      ctx.signal,
      (chunk) => void ctx.log("log", chunk, { repo }),
    );
    await ctx.artifact("log", `${ctx.step.key}-${repo}-test-${label}.log`, r.output, {
      exit_code: r.code,
      timed_out: r.timedOut,
    });
    return r;
  };
  // A failure only blocks the merge when the target branch does not fail the same way without it.
  const judge = async (r: Awaited<ReturnType<typeof execute>>): Promise<Verdict> => {
    if (r.code === 0 && !r.timedOut) return { ok: true, preExisting: [] };
    const raw = {
      ok: false as const,
      summary: clip(r.output.slice(-8000), 8000),
      newFailures: false,
    };
    if (r.timedOut) return raw;
    const branch = parseGoTest(r.output);
    const failing = Object.entries(branch)
      .filter(([, p]) => p.status === "fail")
      .map(([k]) => k);
    if (!failing.length) return raw;
    try {
      await ctx.log(
        "system",
        `${repo}: comparing ${failing.length} failing package(s) with ${target}@${base.sha.slice(0, 9)}`,
      );
      const tip = await baseline(
        base.path,
        failing,
        (cmd, cwd) =>
          runCommand(
            cmd,
            cwd,
            { BASE_BRANCH: target, REPO: repo },
            timeoutMs,
            ctx.signal,
            (chunk) => void ctx.log("log", chunk, { repo, baseline: true }),
          ),
        base.sha,
      );
      const c = classify(branch, tip.report);
      if (!c.regressions.length && c.pre_existing.length) {
        const known = c.pre_existing.flatMap((p) =>
          p.tests.length || p.build_errors.length
            ? [...p.tests, ...p.build_errors].map((x) => `${p.package}: ${x}`)
            : [p.package],
        );
        await ctx.log(
          "system",
          `${repo}: ${known.length} failure(s) also fail on ${target}@${tip.sha.slice(0, 9)}; not caused by this merge`,
          { repo, pre_existing: c.pre_existing },
        );
        return { ok: true, preExisting: known };
      }
      if (!c.regressions.length) return raw;
      const summary = c.regressions
        .map((x) => `${x.package}: ${[...x.tests, ...x.build_errors].join("; ") || x.reason}`)
        .join("\n");
      return {
        ok: false,
        summary,
        newFailures: true,
        detail: failureDetail(
          r.output,
          c.regressions.flatMap((x) => x.tests),
        ),
      };
    } catch (e) {
      await ctx.log(
        "system",
        `${repo}: baseline comparison failed: ${(e as Error).message.split("\n")[0]}`,
      );
      return raw;
    }
  };

  let mocksTried = false;
  for (let round = 0; ; round++) {
    await ctx.log("system", `▶ ${repo}: build + test of the resolved merge`);
    const r = await execute(String(round));
    const verdict = await judge(r);
    if (verdict.ok) return { regenerated: [], preExisting: verdict.preExisting };
    if (!mocksTried && !r.timedOut) {
      mocksTried = true;
      const regenerated = await regenerateMocks(ctx, runCommand, dir, repo, base.sha, timeoutMs);
      if (regenerated.length) {
        await ctx.log(
          "system",
          `${repo}: regenerated ${regenerated.length} mock file(s); testing again`,
        );
        const again = await judge(await execute(`${round}-mocks`));
        if (again.ok) {
          await git(dir, "add", "--", ...regenerated);
          await git(dir, ...IDENTITY, "commit", "--amend", "--no-edit");
          return { regenerated, preExisting: again.preExisting };
        }
        await revertTree(dir);
      }
    }
    if (r.timedOut || round >= rounds) {
      const detail = verdict.newFailures
        ? ` (new failures compared with ${target}: ${clip(verdict.summary, 400)})`
        : "";
      throw new Error(
        `build/test of the resolved merge ${r.timedOut ? "timed out" : `failed (exit ${r.code})`}; nothing was pushed${detail}`,
      );
    }
    await ctx.log(
      "system",
      `${repo}: build/test failed, revising the resolution (${round + 1}/${rounds})`,
    );
    const cause = verdict.newFailures
      ? ` with failures that \`${target}\` does not have on its own`
      : "";
    const tests = await failingTestSources(dir, verdict.detail ?? verdict.summary, files);
    const evidence = [
      ...(verdict.detail ? ["Test output:", "```", verdict.detail, "```"] : []),
      ...tests.flatMap((t) => [
        `Test code in \`${t.file}\` (context only, not part of this resolution):`,
        "```",
        t.text,
        "```",
      ]),
    ];
    for (const file of files) {
      const current = await readFile(join(dir, file), "utf8");
      const prompt = [
        `A merge into \`${target}\` resolved conflicts in ${files.join(", ")}, and the build/test now fails${cause}:`,
        "```",
        verdict.summary,
        "```",
        ...evidence,
        `If \`${file}\` causes this failure, fix it while keeping both sides' changes; otherwise return it unchanged.`,
        `Current ${file}:`,
        "```",
        current,
        "```",
        `Reply with the complete file and nothing else, between a line <<<RESOLVED and a line RESOLVED>>>.`,
      ].join("\n");
      const reply = await ask(ctx, prompt);
      await writeFile(join(dir, file), resolvedText(reply, current));
    }
    await git(dir, "add", "--", ...files);
    await git(dir, ...IDENTITY, "commit", "--amend", "--no-edit");
  }
}
