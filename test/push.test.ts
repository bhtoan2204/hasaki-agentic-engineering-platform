import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushBranch } from "../src/git.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const commit = (cwd: string, file: string) => (writeFileSync(join(cwd, file), file), sh(cwd, "add", "."), sh(cwd, "commit", "-qm", file));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "push-"));
  const origin = join(root, "origin.git"), wt = join(root, "wt");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["clone", "-q", origin, wt]);
  sh(wt, "checkout", "-qb", "release/prod"); commit(wt, "base"); sh(wt, "push", "-q", "origin", "release/prod");
  sh(wt, "checkout", "-qb", "TASK-1"); commit(wt, "feat"); commit(wt, "test");
  return { root, origin, wt };
}

test("pushBranch re-pushes the run's own rewritten branch with a lease", async () => {
  const { wt, origin } = fixture();
  await pushBranch(wt, "TASK-1");
  sh(wt, "rebase", "-q", "--onto", "HEAD~2", "HEAD~1", "TASK-1"); // drop the feat commit, like the agent did
  const r = await pushBranch(wt, "TASK-1");
  assert.match(r.note ?? "", /rewritten locally/);
  assert.match(r.note ?? "", /feat/);
  assert.equal(execFileSync("git", ["--git-dir", origin, "rev-parse", "TASK-1"], { encoding: "utf8" }).trim(), sh(wt, "rev-parse", "HEAD"));
});

test("pushBranch refuses to overwrite commits someone else pushed", async () => {
  const { root, origin, wt } = fixture();
  await pushBranch(wt, "TASK-1");
  const other = join(root, "other");
  execFileSync("git", ["clone", "-q", "-b", "TASK-1", origin, other]);
  commit(other, "colleague"); sh(other, "push", "-q", "origin", "TASK-1");
  commit(wt, "mine");
  await assert.rejects(pushBranch(wt, "TASK-1"), /never had.*\n.*colleague/s);
  assert.match(execFileSync("git", ["--git-dir", origin, "log", "-1", "--format=%s", "TASK-1"], { encoding: "utf8" }), /colleague/);
});
