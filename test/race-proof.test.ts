import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAfterProof, requiredTestTargets } from "../src/agent/verify.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    encoding: "utf8",
  }).trim();
const shell = async (command: string, cwd: string) => {
  try {
    return { code: 0, output: execSync(command, { cwd, encoding: "utf8", stdio: "pipe" }) };
  } catch (e) {
    const x = e as { status: number; stdout?: string; stderr?: string };
    return { code: x.status, output: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
};

const RACY = `package racy

type Counter struct{ n int }

func (c *Counter) Inc() { c.n++ }
func (c *Counter) N() int { return c.n }
`;
const FIXED = `package racy

import "sync"

type Counter struct {
	mu sync.Mutex
	n  int
}

func (c *Counter) Inc() { c.mu.Lock(); c.n++; c.mu.Unlock() }
func (c *Counter) N() int { c.mu.Lock(); defer c.mu.Unlock(); return c.n }
`;
const TEST = `package racy

import (
	"sync"
	"testing"
)

func TestIncConcurrent(t *testing.T) {
	var c Counter
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); c.Inc() }()
	}
	wg.Wait()
	if c.N() != 8 {
		t.Fatalf("count %d", c.N())
	}
}
`;

/** Base commit with the racy counter on origin/main; the fix and its concurrent test committed on top. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "race-proof-"));
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "go.mod"), "module racy\n\ngo 1.20\n");
  writeFileSync(join(dir, "counter.go"), RACY);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(dir, "counter.go"), FIXED);
  writeFileSync(join(dir, "counter_test.go"), TEST);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "fix");
  return dir;
}

test("a race-mode required test runs go test -race; others do not", async () => {
  const dir = repo();
  const ws = [{ repo: "r", path: dir }];
  const plain = await requiredTestTargets(ws, ["racy/TestIncConcurrent"]);
  const raced = await requiredTestTargets(ws, ["racy/TestIncConcurrent"], false, [
    "racy/TestIncConcurrent",
  ]);
  assert.doesNotMatch(plain.targets.get("r")![0].command, /-race/);
  assert.match(raced.targets.get("r")![0].command, /^go test -json -race -run /);
  assert.equal(raced.targets.get("r")![0].race, true);
});

test("a data-race fix is proven only under the race detector", async () => {
  const dir = repo();
  const w = { repo: "r", path: dir, baseBranch: "main" };
  const plain = await beforeAfterProof(w, "racy/TestIncConcurrent", shell);
  assert.equal(
    plain.status,
    "invalid",
    "without -race the racy code passes the test: nothing is proven",
  );
  const raced = await beforeAfterProof(w, "racy/TestIncConcurrent", shell, true);
  assert.equal(raced.status, "verified", raced.reason);
  assert.match(String(raced.command), /-race/);
  assert.equal(git(dir, "status", "--porcelain"), "", "the worktree is untouched");
});
