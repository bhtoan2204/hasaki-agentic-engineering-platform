import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { bwrapArguments } from "../src/platform/selfDevelopment.ts";
import { gitMounts } from "../src/agent/isolation.ts";
import { platformEnvironmentError } from "../src/agent/verify.ts";

const bwrapWorks =
  spawnSync("bwrap", [
    "--die-with-parent",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "true",
  ]).status === 0;

test("a git failure inside the verification environment is a platform error, not a code failure", () => {
  const out = "fatal: not a git repository: /data/repositories/x/checkout/.git/worktrees/8\n";
  assert.match(
    platformEnvironmentError(128, out)!,
    /could not read the worktree's git metadata.*not a code failure/,
  );
  assert.equal(platformEnvironmentError(1, out), null, "only git's own exit code");
  assert.equal(
    platformEnvironmentError(128, "fatal: bad revision 'origin/main...HEAD'\n"),
    null,
    "a real git error stays a failure",
  );
});

test(
  "verification sandbox: a worktree whose checkout lives under the masked dataDir can still run git; shared metadata stays read-only",
  { skip: bwrapWorks ? false : "bubblewrap cannot create namespaces here" },
  async () => {
    const root = join(config.dataDir, `sandbox-git-${process.pid}`);
    const checkout = join(root, "repositories", "repo", "checkout");
    const worktree = join(root, "worktrees", "141", "8");
    mkdirSync(checkout, { recursive: true });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        encoding: "utf8",
      });
    git(checkout, "init", "-q", "-b", "main");
    writeFileSync(join(checkout, "a.go"), "package a\n");
    git(checkout, "add", ".");
    git(checkout, "commit", "-qm", "base");
    git(checkout, "worktree", "add", "-q", "-b", "feature", worktree);
    writeFileSync(join(worktree, "b.go"), "package a\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-qm", "change");

    const inSandbox = (mounts: Awaited<ReturnType<typeof gitMounts>>, script: string) =>
      spawnSync("bwrap", [...bwrapArguments(worktree, null, mounts), "bash", "-c", script], {
        cwd: worktree,
        encoding: "utf8",
      });

    const without = inSandbox([], "git diff --name-only main...HEAD");
    assert.equal(
      without.status,
      128,
      "reproduces the reported failure without the metadata mounts",
    );
    assert.match(without.stderr, /not a git repository/);

    const mounts = await gitMounts([worktree]);
    assert.equal(mounts.length, 1);
    const fixed = inSandbox(
      mounts,
      "git diff --name-only main...HEAD && git status --porcelain >/dev/null && echo ok",
    );
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.match(fixed.stdout, /b\.go\nok/);

    const write = inSandbox(mounts, `touch '${join(mounts[0].commonDir, "planted")}'`);
    assert.notEqual(write.status, 0, "shared objects and refs are not writable from verification");
    writeFileSync(join(config.dataDir, "instance-secret"), "s3cr3t");
    const masked = inSandbox(mounts, `cat '${join(config.dataDir, "instance-secret")}'`);
    assert.notEqual(masked.status, 0, "the rest of dataDir stays masked");
    assert.doesNotMatch(masked.stdout, /s3cr3t/);
  },
);
