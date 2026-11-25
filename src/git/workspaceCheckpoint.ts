import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { realpath, open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { encryptSecret } from "../auth/crypto.ts";
import { allWorkspacesOf, workspacesOf, type Workspace } from "./provider.ts";
import type { RunRow, StepRow } from "../workflow/types.ts";
import { childEnv } from "../platform/childEnv.ts";

const exec = promisify(execFile);
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");

/** Agent repair caches are left in the worktree. They are not the change the next agent must preserve. */
export function isHandoffScratch(name: string) {
  return name === ".repair-tmp" || name.startsWith(".repair-tmp/");
}

/** Source untracked files stay inside the checkpoint bound. Scratch cache does not block the next agent. */
export function classifyHandoffUntracked(repo: string, names: string[]) {
  const scratch = names.filter(isHandoffScratch);
  const source = names.filter((name) => !isHandoffScratch(name));
  if (source.length > 100) {
    const groups = new Map<string, number>();
    for (const name of source) {
      const top = name.split("/")[0] || name;
      groups.set(top, (groups.get(top) ?? 0) + 1);
    }
    const largest = [...groups.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([dir, count]) => `${dir} (${count})`)
      .join(", ");
    throw new Error(
      `${repo} has ${source.length} untracked files, above the 100-file checkpoint limit, so the next agent cannot start. Largest groups: ${largest}. Commit, gitignore, or remove them, then reinspect. ${scratch.length} .repair-tmp cache files were ignored and stay on disk.`,
    );
  }
  return { source, scratchOmitted: scratch.length };
}

async function inspectWorkspace(workspaces: Workspace[], capture = false, bindMode = false) {
  const deadline = AbortSignal.timeout(30000);
  if (workspaces.length > 30) throw new Error("Workspace count exceeds bounded handoff inspection");
  const state = [];
  const content: Array<{
    repository: string;
    branch: string;
    head: string;
    tracked_patch: string;
    index_patch: string;
    untracked: Array<{ path: string; mode: number; base64: string }>;
  }> = [];
  let capturedBytes = 0;
  let scratchOmitted = 0;
  for (const w of workspaces) {
    const root = await realpath(w.path);
    const git = async (...args: string[]) =>
      (
        await exec(
          "git",
          ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", root, ...args],
          {
            signal: deadline,
            timeout: 10000,
            maxBuffer: 5 * 1024 * 1024,
            env: { ...childEnv(), GIT_OPTIONAL_LOCKS: "0" },
          },
        )
      ).stdout;
    if ((await realpath((await git("rev-parse", "--show-toplevel")).trim())) !== root)
      throw new Error("Worktree root changed");
    const branch = (await git("symbolic-ref", "--short", "HEAD")).trim();
    if (branch !== w.branch) throw new Error(`Worktree branch changed: ${w.repo}`);
    if (
      (await git("diff", "--no-ext-diff", "--no-textconv", "--name-only", "--diff-filter=U")).trim()
    )
      throw new Error(`Unresolved Git conflicts: ${w.repo}`);
    const head = (await git("rev-parse", "HEAD")).trim();
    const diff = await git("diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD");
    const index = await git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--cached",
      "--binary",
      "HEAD",
    );
    const status = await git("status", "--porcelain=v1");
    const names = (await git("ls-files", "--others", "--exclude-standard", "-z"))
      .split("\0")
      .filter(Boolean);
    const plan = classifyHandoffUntracked(w.repo, names);
    scratchOmitted += plan.scratchOmitted;
    let bytes = 0;
    const untracked = [];
    const files: (typeof content)[number]["untracked"] = [];
    for (const name of plan.source) {
      const path = resolve(root, name);
      const rel = relative(root, await realpath(path));
      if (rel.startsWith("..") || isAbsolute(rel) || (bindMode && rel !== name))
        throw new Error("Untracked path escapes worktree");
      const stat = await lstat(path);
      bytes += stat.size;
      if (!stat.isFile() || bytes > 5 * 1024 * 1024)
        throw new Error("Untracked state cannot be inspected safely within handoff bounds");
      deadline.throwIfAborted();
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let file: Buffer;
      try {
        const before = await fd.stat();
        if (
          !before.isFile() ||
          before.ino !== stat.ino ||
          before.dev !== stat.dev ||
          before.size !== stat.size ||
          before.mode !== stat.mode
        )
          throw new Error("Untracked file changed during inspection");
        file = Buffer.alloc(before.size);
        const { bytesRead } = await fd.read(file, 0, file.length, 0);
        const after = await fd.stat();
        if (
          bytesRead !== file.length ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          after.size !== before.size
        )
          throw new Error("Untracked file changed during inspection");
      } finally {
        await fd.close();
      }
      untracked.push({
        path: name,
        hash: hash(file),
        ...(bindMode ? { mode: stat.mode & 0o777 } : {}),
      });
      if (capture)
        files.push({ path: name, mode: stat.mode & 0o777, base64: file.toString("base64") });
    }
    if (capture && (diff || index || files.length)) {
      capturedBytes += bytes + Buffer.byteLength(diff) + Buffer.byteLength(index);
      if (capturedBytes > 2 * 1024 * 1024)
        throw new Error("Workspace recovery artifact exceeds 2 MiB");
      content.push({
        repository: w.repo,
        branch,
        head,
        tracked_patch: diff,
        index_patch: index,
        untracked: files,
      });
    }
    state.push({
      repository: w.repo,
      branch,
      path: root,
      head,
      status: status.slice(0, 12000),
      diff_summary: (await git("diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD")).slice(
        0,
        12000,
      ),
      diff_hash: hash(diff),
      index_hash: hash(index),
      untracked,
    });
  }
  return { fingerprint: hash(JSON.stringify(state)), workspaces: state, scratchOmitted, content };
}

export async function inspectHandoffWorkspace(runId: number) {
  const { fingerprint, workspaces, scratchOmitted } = await inspectWorkspace(
    await workspacesOf(runId),
  );
  return { fingerprint, workspaces, scratchOmitted };
}

/** Select only worktrees this step may write. Read-only agents can observe but never archive workspace bytes. */
export async function executionWorkspace(run: RunRow, step: StepRow, capture = false) {
  const allowed = new Set(
    run.selected_repositories.length ? run.selected_repositories : run.allowed_repositories,
  );
  const rows = (await allWorkspacesOf(run.id)).filter(
    (w) => allowed.has(w.repo) && w.subtask_id === (step.subtask_id ?? null),
  );
  if (!rows.length) return;
  const { fingerprint, content } = await inspectWorkspace(rows, capture, true);
  if (!content.length) return { fingerprint };
  const payload = JSON.stringify({
    version: 1,
    run_id: run.id,
    step_id: step.id,
    generation: step.generation,
    fingerprint,
    workspaces: content,
  });
  if (Buffer.byteLength(payload) > 3 * 1024 * 1024)
    throw new Error("Workspace recovery payload exceeds 3 MiB");
  return { fingerprint, encryptedContent: encryptSecret(payload) };
}
