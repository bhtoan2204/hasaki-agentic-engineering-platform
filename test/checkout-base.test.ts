import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alignCheckoutToBase } from "../src/repos/checkoutBase.ts";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const files = (cwd: string) => run(cwd, "ls-files").split("\n").filter(Boolean);

/**
 * A remote whose HEAD is `main`, plus a `release/prod` that carries a file `main` lacks — the shape that left
 * platform clones on `main` while the index base was `release/prod`.
 */
let dir: string, remote: string, clone: string, prodCommit: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "checkout-base-"));
  const seed = join(dir, "seed");
  mkdirSync(seed);
  run(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "main.go"), "package main\n");
  run(seed, "add", ".");
  run(seed, "commit", "-qm", "main");
  run(seed, "checkout", "-qb", "release/prod");
  mkdirSync(join(seed, "worker/sqs"), { recursive: true });
  writeFileSync(join(seed, "worker/sqs/sqs.go"), "package sqs\n");
  run(seed, "add", ".");
  run(seed, "commit", "-qm", "sqs");
  prodCommit = run(seed, "rev-parse", "HEAD");
  run(seed, "checkout", "-q", "main");
  remote = join(dir, "remote.git");
  run(dir, "clone", "-q", "--bare", seed, remote);
  clone = join(dir, "clone");
  run(dir, "clone", "-q", remote, clone);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("alignCheckoutToBase", () => {
  test("moves a clone left on the remote HEAD to the base branch, detached", async () => {
    assert.equal(run(clone, "branch", "--show-current"), "main");
    assert.ok(!files(clone).includes("worker/sqs/sqs.go"));

    assert.deepEqual(await alignCheckoutToBase(clone, "release/prod"), {
      status: "moved",
      commit: prodCommit,
    });
    assert.equal(run(clone, "rev-parse", "HEAD"), prodCommit);
    assert.equal(run(clone, "branch", "--show-current"), "", "detached HEAD");
    assert.ok(files(clone).includes("worker/sqs/sqs.go"));
    assert.ok(existsSync(join(clone, "worker/sqs/sqs.go")));
  });

  test("is a no-op once aligned, and follows the base after a fetch", async () => {
    await alignCheckoutToBase(clone, "release/prod");
    assert.equal((await alignCheckoutToBase(clone, "release/prod")).status, "aligned");

    const pusher = join(dir, "pusher");
    run(dir, "clone", "-q", "-b", "release/prod", remote, pusher);
    writeFileSync(join(pusher, "worker/sqs/handle_order_change.go"), "package sqs\n");
    run(pusher, "add", ".");
    run(pusher, "commit", "-qm", "order change");
    run(pusher, "push", "-q", "origin", "release/prod");
    const next = run(pusher, "rev-parse", "HEAD");

    run(clone, "fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*");
    assert.deepEqual(await alignCheckoutToBase(clone, "release/prod"), {
      status: "moved",
      commit: next,
    });
    assert.ok(files(clone).includes("worker/sqs/handle_order_change.go"));
  });

  test("does not conflict with a worktree that holds the base branch name", async () => {
    run(
      clone,
      "worktree",
      "add",
      "-q",
      join(dir, "wt"),
      "-b",
      "release/prod",
      "origin/release/prod",
    );
    assert.equal((await alignCheckoutToBase(clone, "release/prod")).status, "moved");
    assert.equal(run(join(dir, "wt"), "branch", "--show-current"), "release/prod");
  });

  test("never discards local changes", async () => {
    writeFileSync(join(clone, "main.go"), "package main // edited\n");
    const r = await alignCheckoutToBase(clone, "release/prod");
    assert.equal(r.status, "skipped");
    assert.equal(run(clone, "branch", "--show-current"), "main");
    assert.equal(run(clone, "diff", "--name-only"), "main.go");
  });

  test("skips instead of overwriting an untracked file the base branch tracks", async () => {
    mkdirSync(join(clone, "worker/sqs"), { recursive: true });
    writeFileSync(join(clone, "worker/sqs/sqs.go"), "local scratch\n");
    assert.equal((await alignCheckoutToBase(clone, "release/prod")).status, "skipped");
    assert.equal(run(clone, "branch", "--show-current"), "main");
  });

  test("falls back to the remote HEAD when the base branch is absent, like the index base", async () => {
    const r = await alignCheckoutToBase(clone, "no-such-branch");
    assert.equal(r.status, "moved");
    assert.equal(run(clone, "rev-parse", "HEAD"), run(clone, "rev-parse", "origin/main"));
  });

  test("rejects an invalid branch name without touching the checkout", async () => {
    assert.equal((await alignCheckoutToBase(clone, "--upload-pack=x")).status, "skipped");
    assert.equal(run(clone, "branch", "--show-current"), "main");
  });
});
