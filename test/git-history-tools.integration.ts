/**
 * git.file_history, git.blame and git.commit: per-file history, line authorship and the files of a commit (merges
 * included) from the local checkout. Fixture repositories and authors are fake.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { execution } from "../src/auth/execution.ts";
import { repositories } from "../src/repos/service.ts";
import { callTool, registerBuiltinTools } from "../src/agent/toolRegistry.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";

const REPO = "history-tools-fixture";
const root = () => join(config.reposRoot, REPO);
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root(), ...args], { stdio: "pipe" })
    .toString()
    .trim();
const AN = { name: "Nguyễn Văn An", email: "an@example.test" };
const BINH = { name: "Trần Bình", email: "binh@example.test" };
function commit(files: Record<string, string>, message: string, who: typeof AN, at: string) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(root(), f, ".."), { recursive: true });
    writeFileSync(join(root(), f), text);
  }
  git("add", "-A");
  execFileSync("git", ["-C", root(), "commit", "-qm", message], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
      GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email,
      GIT_COMMITTER_DATE: at,
    },
  });
}
let user = 0;
let mergeSha = "";
let firstSha = "";
before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  registerBuiltinTools();
  mkdirSync(root(), { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", AN.email);
  git("config", "user.name", AN.name);
  commit(
    { "app/order.go": "one\ntwo\nthree\n", ".env": "SECRET=not-a-real-secret\n" },
    "feat: order",
    AN,
    "2026-11-10T09:00:00+07:00",
  );
  firstSha = git("rev-parse", "HEAD");
  commit(
    { "app/order.go": "one\nTWO\nthree\n" },
    "fix: second line",
    BINH,
    "2026-11-11T09:00:00+07:00",
  );
  git("mv", "app/order.go", "app/orders.go");
  commit({}, "refactor: rename order file", AN, "2026-11-12T09:00:00+07:00");
  git("checkout", "-qb", "feature");
  commit(
    { "app/gift.go": "gift\n", "app/orders.go": "one\nTWO\nthree\nfour\n" },
    "feat: gift lines",
    BINH,
    "2026-11-13T09:00:00+07:00",
  );
  commit({ "docs/gift.md": "docs\n" }, "docs: gift", BINH, "2026-11-13T10:00:00+07:00");
  git("checkout", "-q", "main");
  commit({ "app/other.go": "other\n" }, "chore: other", AN, "2026-11-14T09:00:00+07:00");
  execFileSync(
    "git",
    ["-C", root(), "merge", "--no-ff", "-m", "Merge branch 'feature' into main", "feature"],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-11-14T12:00:00+07:00",
        GIT_COMMITTER_DATE: "2026-11-14T12:00:00+07:00",
        GIT_COMMITTER_NAME: AN.name,
        GIT_COMMITTER_EMAIL: AN.email,
      },
    },
  );
  mergeSha = git("rev-parse", "HEAD");
  await repositories.upsert(REPO, { projects: ["HIST"] });
  user = (
    await createUser({
      username: `hist-tools-${Date.now()}`,
      password: "history-pass",
      role: "member",
    })
  ).id;
});
after(() => pool.end());

const call = (tool: string, args: Record<string, unknown>, allowed = [REPO]) =>
  execution.run({ userId: user, kind: "user" }, () =>
    callTool(tool, args, { runId: null, allowedRepositories: allowed, mode: "analysis" }),
  );

test("git.file_history lists the commits of one file, following the rename, newest first", async () => {
  const r = await call("git.file_history", { repo: REPO, path: "app/orders.go" });
  assert.equal(r.ok, true, r.error ?? "");
  const out = r.result as {
    commits: Array<{ subject: string; author: string; sha: string }>;
    more: boolean;
  };
  assert.deepEqual(
    out.commits.map((c) => c.subject),
    ["feat: gift lines", "refactor: rename order file", "fix: second line", "feat: order"],
  );
  assert.equal(out.commits[2].author, BINH.name);
  assert.equal(out.more, false);
  const limited = (await call("git.file_history", { repo: REPO, path: "app/orders.go", limit: 2 }))
    .result as typeof out;
  assert.equal(limited.commits.length, 2);
  assert.equal(limited.more, true);
});

test("git.blame names the last commit of each line, with each commit's details once", async () => {
  const r = await call("git.blame", {
    repo: REPO,
    path: "app/orders.go",
    start_line: 1,
    end_line: 4,
  });
  assert.equal(r.ok, true, r.error ?? "");
  const out = r.result as {
    lines: Array<{ line: number; sha: string; text: string }>;
    commits: Record<string, { author: string; summary: string; date: string }>;
  };
  assert.deepEqual(
    out.lines.map((l) => [l.line, l.text]),
    [
      [1, "one"],
      [2, "TWO"],
      [3, "three"],
      [4, "four"],
    ],
  );
  const by = (n: number) => out.commits[out.lines[n - 1].sha];
  assert.equal(by(1).summary, "feat: order");
  assert.equal(by(2).summary, "fix: second line");
  assert.equal(by(2).author, BINH.name);
  assert.equal(by(4).summary, "feat: gift lines");
  assert.match(by(2).date, /^2026-11-11T09:00:00\+07:00$/);
  assert.equal(Object.keys(out.commits).length, 3);
  const old = (
    await call("git.blame", {
      repo: REPO,
      path: "app/order.go",
      rev: firstSha,
      start_line: 1,
      end_line: 3,
    })
  ).result as typeof out;
  assert.deepEqual(
    [...new Set(old.lines.map((l) => old.commits[l.sha].summary))],
    ["feat: order"],
    "an old revision reads the file as it was then, under its old name",
  );
});

test("git.commit lists the files of a commit and, for a merge, what it brought in", async () => {
  const merge = (await call("git.commit", { repo: REPO, sha: mergeSha })).result as {
    merge: boolean;
    compared_with: string;
    parents: string[];
    files: Array<{ status: string; path: string }>;
    files_total: number;
    merged_commits: string[];
    insertions: number;
  };
  assert.equal(merge.merge, true);
  assert.equal(merge.compared_with, "first parent");
  assert.equal(merge.parents.length, 2);
  assert.deepEqual(merge.files.map((f) => `${f.status} ${f.path}`).sort(), [
    "A app/gift.go",
    "A docs/gift.md",
    "M app/orders.go",
  ]);
  assert.equal(merge.files_total, 3);
  assert.deepEqual(
    merge.merged_commits.map((l) => l.replace(/^\w+ /, "")),
    ["docs: gift", "feat: gift lines"],
  );
  assert.ok(merge.insertions >= 3);
  const rename = (await call("git.commit", { repo: REPO, sha: "HEAD~2" })).result as {
    files: Array<{ status: string; path: string; old_path?: string }>;
  };
  assert.ok(
    rename.files.some(
      (f) => f.status === "R" && f.old_path === "app/order.go" && f.path === "app/orders.go",
    ),
  );
});

test("git.commits no longer shows a merge commit as empty", async () => {
  const r = await call("git.commits", { since: "2026-11-14", until: "2026-11-15" });
  const commits = (
    r.result as { repositories: Array<{ commits: Array<{ merge: boolean; files: number }> }> }
  ).repositories[0].commits;
  const merge = commits.find((c) => c.merge);
  assert.ok(merge);
  assert.equal(merge.files, 3);
});

test("secret files, option-like input, ranges and foreign repositories are refused", async () => {
  assert.match((await call("git.blame", { repo: REPO, path: ".env" })).error ?? "", /secret file/);
  for (const args of [
    { path: "--output=/tmp/x" },
    { path: "../etc/passwd" },
    { path: "/etc/passwd" },
    { path: "app/orders.go", rev: "--all" },
    { path: "app/orders.go", rev: "main..feature" },
  ]) {
    const r = await call("git.file_history", { repo: REPO, ...args });
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.match(r.error ?? "", /invalid/, JSON.stringify(args));
  }
  assert.equal((await call("git.commit", { repo: REPO, sha: "-p" })).ok, false);
  assert.equal((await call("git.commit", { repo: REPO, sha: "deadbeefdeadbeef" })).ok, false);
  assert.match(
    (await call("git.blame", { repo: "someone-elses-repo", path: "a.go" })).error ?? "",
    /outside/,
  );
  assert.equal(
    (await call("git.blame", { repo: REPO, path: "app/orders.go", start_line: 5, end_line: 2 })).ok,
    false,
  );
});
