import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushBranch } from "../src/git.ts";
import { finalPublishProblems, worktreeFingerprint } from "../src/agent/scopeGuard.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
const commit = (cwd: string, file: string) => (writeFileSync(join(cwd, file), file), sh(cwd, "add", "."), sh(cwd, "commit", "-qm", file));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pubint-"));
  const origin = join(root, "origin.git");
  const wt = join(root, "wt");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["clone", "-q", origin, wt]);
  sh(wt, "checkout", "-qb", "main");
  commit(wt, "base");
  sh(wt, "push", "-q", "origin", "main");
  sh(wt, "checkout", "-qb", "TASK-1");
  commit(wt, "feat");
  return { root, origin, wt };
}
const remoteTip = (origin: string, b: string) => execFileSync("git", ["--git-dir", origin, "rev-parse", b], { encoding: "utf8" }).trim();
const state = async (wt: string) => ({ ...(await worktreeFingerprint(wt)), branchTip: sh(wt, "rev-parse", "refs/heads/TASK-1") });

test("successful publication pushes exactly the verified commit (first push to an absent branch)", async () => {
  const { origin, wt } = fixture();
  const verified = await state(wt);
  assert.deepEqual(finalPublishProblems({ repo: "app", verified, now: await state(wt), ownershipLost: false }), []);
  await pushBranch(wt, "TASK-1", "main", verified.head);
  assert.equal(remoteTip(origin, "TASK-1"), verified.head);
});

test("a workspace edit or an untracked file after verification is a fingerprint mismatch", async () => {
  const { wt } = fixture();
  const verified = await state(wt);
  writeFileSync(join(wt, "extra.txt"), "unverified");
  const problems = finalPublishProblems({ repo: "app", verified, now: await state(wt), ownershipLost: false });
  assert.match(problems.join("\n"), /fingerprint mismatch/);
});

test("a moved HEAD / branch tip is reported", async () => {
  const { wt } = fixture();
  const verified = await state(wt);
  commit(wt, "late");
  const problems = finalPublishProblems({ repo: "app", verified, now: await state(wt), ownershipLost: false }).join("\n");
  assert.match(problems, /HEAD moved/);
  assert.match(problems, /branch tip moved/);
});

test("ownership loss and unreadable state fail closed", async () => {
  const { wt } = fixture();
  const verified = await state(wt);
  assert.match(finalPublishProblems({ repo: "app", verified, now: verified, ownershipLost: true }).join(), /no longer owns/);
  assert.match(finalPublishProblems({ repo: "app", verified, now: null, ownershipLost: false }).join(), /could not be read/);
});

test("pushBranch refuses when HEAD is not the verified commit and pushes nothing", async () => {
  const { origin, wt } = fixture();
  const verified = await state(wt);
  commit(wt, "unverified");
  await assert.rejects(pushBranch(wt, "TASK-1", "main", verified.head), /re-run verification/);
  assert.throws(() => remoteTip(origin, "TASK-1"));
});

test("a branch tip moved on the remote by someone else is never overwritten", async () => {
  const { root, origin, wt } = fixture();
  await pushBranch(wt, "TASK-1", "main");
  const other = join(root, "other");
  execFileSync("git", ["clone", "-q", "-b", "TASK-1", origin, other]);
  commit(other, "colleague");
  sh(other, "push", "-q", "origin", "TASK-1");
  const colleague = remoteTip(origin, "TASK-1");
  commit(wt, "mine");
  await assert.rejects(pushBranch(wt, "TASK-1", "main", sh(wt, "rev-parse", "HEAD")), /never had/);
  assert.equal(remoteTip(origin, "TASK-1"), colleague);
});
