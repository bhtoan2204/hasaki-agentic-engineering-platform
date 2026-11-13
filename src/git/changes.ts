import { effectivePermissions } from "../repos/access.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repositoryBaseBranch } from "../repos/service.ts";
import { pool, q, one } from "../db/pool.ts";
import {
  prDescription,
  prFields,
  testExceptionsOf,
  verificationNotesOf,
} from "../workflow/executors/builtin.ts";
import { workspaceRef, workspacesOf } from "./provider.ts";

const exec = promisify(execFile);
const MAX_DIFF = 600_000;

async function git(cwd: string, ...args: string[]) {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    return `(git ${args[0]} failed: ${(e as Error).message.split("\n")[0]})`;
  }
}
const capped = (s: string) =>
  s.length > MAX_DIFF
    ? s.slice(0, MAX_DIFF) + `\n… diff truncated (${s.length - MAX_DIFF} more chars)`
    : s;

/**
 * Read-only view of what a run changed, per workspace: commits ahead of the base branch, changed files, the diff,
 * uncommitted work, and the PR title/description the git_pull_request step would send. Used to review before the PR step.
 */
/**
 * `viewerId`: source code (commits, diffs, file lists) is shown only for repositories the viewer can read right now;
 * a run's history is kept, but a revoked repository shows as restricted, not as code. This also applies to an admin
 * looking at another member's run.
 */
export async function runChanges(runId: number, viewerId?: number) {
  const run = await one(
    pool,
    "SELECT r.*, w.code AS work_item_code FROM workflow_runs r LEFT JOIN work_items w ON w.id = r.work_item_id WHERE r.id = $1",
    [runId],
  );
  if (!run) throw new Error(`run ${runId} not found`);
  const steps = await q(
    pool,
    "SELECT key, type, status, config, output FROM workflow_steps WHERE run_id = $1 ORDER BY position",
    [runId],
  );
  const prStep = steps.find((s) => s.type === "git_pull_request");
  const source = prStep
    ? (steps.find((s) => s.key === prStep.config?.content_from)?.output ??
      steps.find((s) => s.output?.pull_requests)?.output ??
      {})
    : {};
  const testExceptions = await testExceptionsOf(runId);
  const verificationNotes = await verificationNotesOf(runId);
  const repos = [];
  const readable =
    viewerId == null
      ? null
      : await effectivePermissions(viewerId, { project: String(run.inputs?.project ?? "") });
  for (const w of await workspacesOf(runId)) {
    if (readable && !readable.get(w.repo)?.effective.read) {
      repos.push({ repo: w.repo, branch: w.branch, exists: false, restricted: true });
      continue;
    }
    const destination = await repositoryBaseBranch(w.repo);
    const base = `origin/${destination}`;
    const at = await workspaceRef(w);
    const live = at?.head === "HEAD";
    const changes = at
      ? await Promise.all([
          git(at.cwd, "log", "--format=%h%x09%an%x09%ar%x09%s", `${base}..${at.head}`),
          git(at.cwd, "diff", "--numstat", `${base}...${at.head}`),
          git(at.cwd, "diff", "--no-color", `${base}...${at.head}`),
          live ? git(at.cwd, "status", "--porcelain") : "",
          live ? git(at.cwd, "diff", "--no-color", "HEAD") : "",
        ])
      : null;
    if (!changes || (!live && changes.some((out) => out.startsWith("(git")))) {
      repos.push({ ...w, exists: false });
      continue;
    }
    const [commits, files, diff, status, uncommitted] = changes;
    const commitList = commits.trim()
      ? commits
          .trim()
          .split("\n")
          .map((l) => {
            const [hash, author, when, ...subject] = l.split("\t");
            return { hash, author, when, subject: subject.join("\t") };
          })
      : [];
    const fileList =
      files.trim() && !files.startsWith("(git")
        ? files
            .trim()
            .split("\n")
            .map((l) => {
              const [add, del, ...path] = l.split("\t");
              return {
                path: path.join("\t"),
                additions: add === "-" ? null : Number(add),
                deletions: del === "-" ? null : Number(del),
              };
            })
        : [];
    const f = prFields(source, w.repo, run.work_item_code ?? undefined, run.title);
    repos.push({
      ...w,
      exists: true,
      base,
      commits: commitList,
      files: fileList,
      diff: capped(diff),
      status: status.trim(),
      uncommitted_diff: capped(uncommitted),
      pr_preview: {
        title: f.title,
        target: destination,
        description: prDescription({
          code: run.work_item_code ?? undefined,
          runId,
          summary: f.summary,
          decisions: f.decisions,
          commits: commitList.map((c) => `${c.hash} ${c.subject}`).join("\n"),
          testExceptions,
          verificationNotes,
        }),
        will_open:
          run.selected_repositories.includes(w.repo) && commitList.length > 0 && !status.trim(),
      },
    });
  }
  const validation = steps
    .filter(
      (s) =>
        s.type === "command" ||
        (s.type === "agent" && s.output && ("approved" in s.output || "findings" in s.output)),
    )
    .map((s) => ({ key: s.key, type: s.type, status: s.status, output: s.output }));
  const prs = await q(pool, "SELECT * FROM pull_requests WHERE run_id = $1 ORDER BY id", [runId]);
  return {
    run_id: runId,
    branch: run.branch,
    pr_step: prStep
      ? { key: prStep.key, status: prStep.status, mode: prStep.config?.mode ?? "auto" }
      : null,
    repos,
    validation,
    pull_requests: prs,
  };
}
