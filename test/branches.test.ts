import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { branchFor, detectBranchDirectives, normalizeBranchMap } from "../src/workflow/branches.ts";
import { prepareBranch } from "../src/git.ts";

const REPOS = ["oms-api", "oms-background", "oms-frontend"];

test("detect: the real HSK-05484B7S description continues HSK-QA679L33 in oms-background only", () => {
  const text =
    "Làm tiếp từ branch HSK-QA679L33 ở oms-background, không checkout sang branch mới mà làm tiếp trong branch HSK-QA679L33\n\nĐây là payload mẫu phía Ecom đẩy xuống, xử lý thêm phần installment phía OMS";
  assert.deepEqual(detectBranchDirectives(text, REPOS, "release/prod"), {
    "oms-background": "HSK-QA679L33",
  });
});

test("detect: no repo named → every repository; English phrasing; quoted names", () => {
  assert.deepEqual(
    detectBranchDirectives(
      "Please continue on branch `feature/zip-code` — it already has the migration.",
      REPOS,
      "release/prod",
    ),
    { "*": "feature/zip-code" },
  );
  assert.deepEqual(
    detectBranchDirectives(
      "Tiếp tục nhánh HSK-1A2B3C4D cho oms-api và oms-frontend.",
      REPOS,
      "release/prod",
    ),
    { "oms-api": "HSK-1A2B3C4D", "oms-frontend": "HSK-1A2B3C4D" },
  );
});

test("detect: conservative — mentions without a continue intent, the base branch and 'new branch' are ignored", () => {
  assert.deepEqual(
    detectBranchDirectives(
      "Branch HSK-QA679L33 đã merge vào release/prod tuần trước.",
      REPOS,
      "release/prod",
    ),
    {},
  );
  assert.deepEqual(
    detectBranchDirectives("Làm tiếp trên branch release/prod của oms-api.", REPOS, "release/prod"),
    {},
  );
  assert.deepEqual(detectBranchDirectives("Không tạo branch mới.", REPOS, "release/prod"), {});
  assert.deepEqual(detectBranchDirectives("", REPOS, "release/prod"), {});
});

test("explicit inputs.branches: validated; base branch and unsafe names refused", () => {
  assert.deepEqual(normalizeBranchMap({ "oms-background": " HSK-QA679L33 " }, "release/prod"), {
    "oms-background": "HSK-QA679L33",
  });
  assert.equal(normalizeBranchMap({}, "release/prod"), null);
  assert.equal(normalizeBranchMap("HSK-1", "release/prod"), null);
  assert.throws(() => normalizeBranchMap({ "*": "release/prod" }, "release/prod"), /base branch/);
  assert.throws(() => normalizeBranchMap({ x: "a..b" }, "release/prod"), /invalid branch/);
  assert.throws(() => normalizeBranchMap({ x: "-rf" }, "release/prod"), /invalid branch/);
});

test("branchFor: per-repo override, then '*', then the run branch", () => {
  const run = {
    branch: "HSK-05484B7S",
    inputs: { branches: { "oms-background": "HSK-QA679L33", "*": "shared-x" } },
  };
  assert.deepEqual(branchFor(run, "oms-background"), { branch: "HSK-QA679L33", existing: true });
  assert.deepEqual(branchFor(run, "oms-api"), { branch: "shared-x", existing: true });
  assert.deepEqual(branchFor({ branch: "HSK-05484B7S", inputs: {} }, "oms-api"), {
    branch: "HSK-05484B7S",
    existing: false,
  });
});

test("prepareBranch: a requested existing branch is checked out (tracking origin), never re-created from the base", async () => {
  const sh = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-C", cwd, ...a], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).trim();
  const name = `brtest-${Date.now()}`;
  const repo = join(config.reposRoot, name);
  const origin = join(config.reposRoot, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", config.baseBranch);
  writeFileSync(join(repo, "a.txt"), "base\n");
  (sh(repo, "add", "."),
    sh(repo, "commit", "-qm", "base"),
    sh(repo, "remote", "add", "origin", origin),
    sh(repo, "push", "-q", "origin", config.baseBranch));
  // someone's feature branch exists only on origin
  sh(repo, "checkout", "-qb", "HSK-QA679L33");
  writeFileSync(join(repo, "feature.txt"), "earlier work\n");
  (sh(repo, "add", "."),
    sh(repo, "commit", "-qm", "earlier work"),
    sh(repo, "push", "-q", "origin", "HSK-QA679L33"));
  (sh(repo, "checkout", "-q", config.baseBranch), sh(repo, "branch", "-q", "-D", "HSK-QA679L33"));

  const b = await prepareBranch("HSK-NEWTASK", name, "HSK-QA679L33", name, { mustExist: true });
  assert.equal(b.branch, "HSK-QA679L33");
  assert.equal(b.createdFrom, "origin/HSK-QA679L33");
  assert.ok(existsSync(join(b.path, "feature.txt")), "worktree continues the earlier work");
  assert.equal(sh(b.path, "branch", "--show-current"), "HSK-QA679L33");

  await assert.rejects(
    prepareBranch("HSK-OTHER", name, "HSK-DOES-NOT-EXIST", name, { mustExist: true }),
    /does not exist locally or on origin/,
  );
  assert.equal(
    sh(repo, "branch", "--list", "HSK-DOES-NOT-EXIST"),
    "",
    "nothing created from the base",
  );
  // without a directive the old behaviour is unchanged: a new branch from origin/<base>
  const fresh = await prepareBranch("HSK-FRESH", name, "HSK-FRESH", name);
  assert.equal(fresh.createdFrom, `origin/${config.baseBranch}`);
});

test("branch directive: filler words after 'branch' are skipped — the branch-like name is taken (run #53 regression)", () => {
  assert.deepEqual(
    detectBranchDirectives(
      "Tiếp tục từ branch task cha: HSK-OO04123R\n\nThêm một API ...",
      ["oms-background"],
      "release/prod",
    ),
    { "*": "HSK-OO04123R" },
  );
  assert.deepEqual(
    detectBranchDirectives(
      "keep working on the existing branch task",
      ["oms-background"],
      "release/prod",
    ),
    {},
    "a plain word is never taken as a branch",
  );
  assert.deepEqual(
    detectBranchDirectives("reuse branch `develop` for this", ["oms-background"], "release/prod"),
    { "*": "develop" },
    "a quoted plain name is explicit",
  );
});
