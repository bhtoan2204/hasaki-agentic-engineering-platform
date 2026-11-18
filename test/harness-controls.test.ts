import { test } from "node:test";
import assert from "node:assert/strict";
import { CI_PATHS, decide, verifyPathTokens, type PolicyContext } from "../src/agent/toolPolicy.ts";
import { validateOutputContract } from "../src/agent/contract.ts";

const ws = "/data/worktrees/run-1/oms-api";
const coding: PolicyContext = {
  mode: "coding",
  workspaces: [ws],
  baseBranch: "main",
  protectedPaths: [
    ...CI_PATHS,
    ...verifyPathTokens("./scripts/verify.sh && node_modules/.bin/tsc"),
  ],
};

test("verification command paths are protected; flags, variables and globs are not paths", () => {
  assert.deepEqual(
    verifyPathTokens(
      `set -e; ./scripts/check.sh "$X" --flag=1 'test/*.ts' && go test ./... && python tools/lint.py`,
    ),
    ["scripts/check.sh", "tools/lint.py"],
  );
});

test("edits to CI configuration and verification scripts are denied, other edits are not", () => {
  const edit = (file: string, ctx = coding) =>
    decide("Edit", { file_path: `${ws}/${file}`, old_string: "a", new_string: "b" }, ctx).allow;
  assert.equal(edit(".github/workflows/ci.yml"), false);
  assert.equal(edit("scripts/verify.sh"), false);
  assert.equal(edit(".gitlab-ci.yml"), false);
  assert.equal(edit("src/service.go"), true);
  assert.equal(edit("scripts/verify.sh", { ...coding, protectedPaths: [] }), true);
});

test("shell writes to protected paths are denied, reads are not", () => {
  const bash = (command: string) => decide("Bash", { command }, coding, ws).allow;
  assert.equal(bash("sed -i 's/x/y/' .github/workflows/ci.yml"), false);
  assert.equal(bash("echo exit 0 > scripts/verify.sh"), false);
  assert.equal(bash(`rm ${ws}/scripts/verify.sh`), false);
  assert.equal(bash("cat .github/workflows/ci.yml"), true);
  assert.equal(bash("sed -i 's/x/y/' src/main.go"), true);
});

test("merging, rebasing and pulling are denied; merge-base still reads", () => {
  const bash = (command: string) => decide("Bash", { command }, coding, ws).allow;
  assert.equal(bash("git merge origin/main"), false);
  assert.equal(bash("git -C /x rebase main"), false);
  assert.equal(bash("git pull --rebase"), false);
  assert.equal(bash("git merge-base origin/main HEAD"), true);
});

test("string output contracts check primitive unions, number arrays and patterned strings", () => {
  const contract =
    "{ in_scope: boolean|null, searches: number[], ref: 'S<search id>:<n>', verdict: 'PASS'|'FAIL' }";
  assert.equal(
    validateOutputContract(contract, {
      in_scope: null,
      searches: [1, 2],
      ref: "S1:2",
      verdict: "PASS",
    }).valid,
    true,
  );
  const bad = validateOutputContract(contract, {
    in_scope: "yes",
    searches: ["1"],
    ref: 3,
    verdict: "MAYBE",
  });
  assert.equal(bad.valid, false);
  assert.equal(bad.errors.length, 4);
});
