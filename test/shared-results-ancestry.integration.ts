/**
 * C4 (REVIEW.md): the default "is the new commit a descendant of the old one" check, with real git history.
 * history:  A - B (main)
 *            \\
 *             C (a branch from A)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { repositories } from "../src/repos/service.ts";
import { isDescendant } from "../src/sharing/ancestry.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";

const name = `ancestry-${process.pid}`;
const sha: Record<string, string> = {};
before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  const dir = join(config.reposRoot, name);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync(
      "git",
      ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...a],
      {
        encoding: "utf8",
      },
    ).trim();
  git("init", "-q", "-b", "main");
  const commit = (label: string) => {
    writeFileSync(join(dir, "f.txt"), label);
    git("add", ".");
    git("commit", "-qm", label);
    sha[label] = git("rev-parse", "HEAD");
  };
  commit("A");
  commit("B");
  git("checkout", "-q", "-b", "side", sha.A);
  commit("C");
  git("checkout", "-q", "main");
  await repositories.upsert(name, { default_branch: "main" });
});
after(() => pool.end());

test("descendant: true; the other way round and a divergent branch: false", async () => {
  assert.equal(await isDescendant(name, sha.A, sha.B), true);
  assert.equal(await isDescendant(name, sha.B, sha.A), false, "rewind");
  assert.equal(await isDescendant(name, sha.C, sha.B), false, "divergent");
  assert.equal(await isDescendant(name, sha.A, sha.C), true);
});

test("cannot be told: unknown commit, unknown repository, a repository with no checkout: null (so nothing is marked stale)", async () => {
  assert.equal(await isDescendant(name, sha.A, "f".repeat(40)), null);
  assert.equal(await isDescendant(name, "e".repeat(40), sha.B), null);
  assert.equal(await isDescendant("no-such-repository", sha.A, sha.B), null);
  await repositories.upsert(`${name}-nocheckout`, { default_branch: "main" });
  assert.equal(await isDescendant(`${name}-nocheckout`, sha.A, sha.B), null);
});
