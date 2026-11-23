import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAfterProof } from "../src/agent/verify.ts";
import {
  enforceRootCauseReview,
  normalizeRemediation,
  proofProblem,
  type RegressionProof,
} from "../src/agent/rootCause.ts";
import type { VerdictOutput } from "../src/agent/independentReview.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    encoding: "utf8",
  }).trim();

/** Disposable repo: base on main (origin/main), then the fix and its regression test committed on top. */
function repo(fix: string, testBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "src/phone.js"), "export const normalize = (p) => p;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(dir, "src/phone.js"), fix);
  writeFileSync(
    join(dir, "test/phone.test.js"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { normalize } from "../src/phone.js";\ntest("phone", () => { ${testBody} });\n`,
  );
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "fix");
  return dir;
}
const shell = async (command: string, cwd: string) => {
  try {
    // A nested `node --test` must not report to this test runner (NODE_TEST_CONTEXT) but print its own reporter output.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    return {
      code: 0,
      output: execSync(command, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    };
  } catch (e) {
    const x = e as { status: number; stdout?: string; stderr?: string };
    return { code: x.status, output: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
};
const FIX = 'export const normalize = (p) => p.replace(/^\\+84/, "0");\n';
const ASSERT = 'assert.equal(normalize("+84900000000"), "0900000000");';

test("the same test fails on the pre-fix source and passes on the fix: verified, bound to base and head; the worktree is untouched", async () => {
  const dir = repo(FIX, ASSERT);
  const head = git(dir, "rev-parse", "HEAD");
  const proof = await beforeAfterProof(
    { repo: "r", path: dir, baseBranch: "main" },
    "r::test/phone.test.js",
    shell,
  );
  assert.equal(proof.status, "verified", proof.reason);
  assert.deepEqual([proof.before, proof.after], ["failed", "passed"]);
  assert.equal(proof.head_sha, head);
  assert.equal(proof.base_sha, git(dir, "rev-parse", "origin/main"));
  assert.deepEqual(proof.reverted_files, ["src/phone.js"]);
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
  assert.equal(git(dir, "worktree", "list").split("\n").length, 1, "temporary worktree removed");
});

test("a test that passes without the fix proves nothing; a build/infrastructure failure before is not a reproduction", async () => {
  const always = repo(FIX, "assert.equal(1, 1);");
  const p1 = await beforeAfterProof(
    { repo: "r", path: always, baseBranch: "main" },
    "r::test/phone.test.js",
    shell,
  );
  assert.equal(p1.status, "invalid");
  assert.match(p1.reason, /already passes without the fix/);
  const dir = repo(FIX, ASSERT);
  let n = 0;
  const brokenBefore = async (command: string, cwd: string) =>
    n++ === 0 ? { code: 1, output: "SyntaxError: build failed" } : shell(command, cwd);
  const p2 = await beforeAfterProof(
    { repo: "r", path: dir, baseBranch: "main" },
    "r::test/phone.test.js",
    brokenBefore,
  );
  assert.equal(p2.status, "invalid");
  assert.match(p2.reason, /build or infrastructure failure is not a reproduction/);
  const p3 = await beforeAfterProof(
    { repo: "r", path: dir, baseBranch: "main" },
    "TestNotExecutable please",
    shell,
  );
  assert.equal(p3.status, "unmeasured");
});

test("attribution: a pre-fix LOAD failure (the test imports what only the fix adds) is not a reproduction", async () => {
  // The regression test imports a symbol the fix introduces: on the pre-fix source the file cannot even load.
  const dir = repo(
    'export const normalize = (p) => p;\nexport const normalizeV2 = (p) => p.replace(/^\\+84/, "0");\n',
    'assert.equal(normalizeV2("+84900000000"), "0900000000");',
  );
  writeFileSync(
    join(dir, "test/phone.test.js"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { normalizeV2 } from "../src/phone.js";\ntest("phone", () => { assert.equal(normalizeV2("+84900000000"), "0900000000"); });\n`,
  );
  git(dir, "commit", "-qam", "test imports the new symbol");
  const proof = await beforeAfterProof({ repo: "r", path: dir, baseBranch: "main" }, "r::test/phone.test.js", shell);
  assert.equal(proof.status, "invalid", "previously counted as 'fails before' → verified");
  assert.equal(proof.before, "not_executed");
  assert.match(proof.reason, /load, build or infrastructure failure is not a reproduction/);
});

test("attribution: a pre-fix failure that does not repeat (flaky) is not attributable to the defect", async () => {
  const dir = repo(FIX, ASSERT);
  let n = 0;
  // Second pre-fix run reports a pass (as a flaky test would).
  const flaky = async (command: string, cwd: string) => {
    if (n++ !== 1) return shell(command, cwd);
    const file = /'([^']+\.test\.js)'$/.exec(command)![1];
    return { code: 0, output: JSON.stringify({ type: "platform:test-summary", file, complete: true, passed: 1, failed: 0, skipped: 0 }) };
  };
  const proof = await beforeAfterProof({ repo: "r", path: dir, baseBranch: "main" }, "r::test/phone.test.js", flaky);
  assert.equal(proof.status, "invalid");
  assert.deepEqual([proof.before, proof.before_repeat], ["failed", "passed"]);
  assert.match(proof.reason, /flaky failure is not attributable/);
  const stable = await beforeAfterProof({ repo: "r", path: dir, baseBranch: "main" }, "r::test/phone.test.js", shell);
  assert.equal(stable.status, "verified", stable.reason);
  assert.equal(stable.before_repeat, "failed");
});

test("integrity: the proof is measured on the committed HEAD — an uncommitted fix in the worktree does not count, and stays untouched", async () => {
  const dir = repo("export const normalize = (p) => p; // touched, not fixed\n", ASSERT);
  // The real fix exists only as an uncommitted edit in the run's worktree.
  writeFileSync(join(dir, "src/phone.js"), FIX);
  const proof = await beforeAfterProof({ repo: "r", path: dir, baseBranch: "main" }, "r::test/phone.test.js", shell);
  assert.equal(proof.status, "invalid", "previously the 'after' run used the dirty worktree and verified a commit without the fix");
  assert.match(proof.reason, /does not pass with the fix on the committed source/);
  assert.equal(git(dir, "status", "--porcelain"), "M src/phone.js", "the uncommitted edit is left as it was");
  assert.equal(git(dir, "worktree", "list").split("\n").length, 1, "temporary worktrees removed");
});

test("validity: installed dependencies are available to both runs, and the run's node_modules survives cleanup", async () => {
  const dir = repo(FIX, ASSERT);
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  git(dir, "add", ".gitignore");
  git(dir, "commit", "-qm", "ignore deps");
  mkdirSync(join(dir, "node_modules/phone-dep"), { recursive: true });
  writeFileSync(join(dir, "node_modules/phone-dep/package.json"), JSON.stringify({ name: "phone-dep", type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules/phone-dep/index.js"), "export const PREFIX = '+84';\n");
  writeFileSync(
    join(dir, "test/phone.test.js"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { PREFIX } from "phone-dep";\nimport { normalize } from "../src/phone.js";\ntest("phone", () => { assert.equal(normalize(PREFIX + "900000000"), "0900000000"); });\n`,
  );
  git(dir, "commit", "-qam", "test uses an installed dependency");
  const proof = await beforeAfterProof({ repo: "r", path: dir, baseBranch: "main" }, "r::test/phone.test.js", shell);
  assert.equal(proof.status, "verified", proof.reason);
  assert.ok(existsSync(join(dir, "node_modules/phone-dep/index.js")), "linked, never removed");
});

const pass: VerdictOutput = { verdict: "PASS", findings: [], summary: "ok" };
const check = {
  remediation_kind: "ROOT_CAUSE_FIX",
  addresses_root_cause: true,
  symptom_only_changes: [],
  justified_signals: [],
  observability_reduced: false,
  regression_test_demonstrates_fix: true,
};
const upstream = (proof: RegressionProof | null, tested = "h1") => ({
  implement: {
    status: "COMPLETED",
    output: {
      verification: { passed: true },
      tested_heads: { r: tested },
      remediation: normalizeRemediation(
        {
          kind: "ROOT_CAUSE_FIX",
          root_cause: "phone not normalised at the source",
          causal_link: "normalises before the provider call",
          regression_test: {
            name: "r::test/phone.test.js",
            fails_before: true,
            passes_after: true,
          },
        },
        "strict",
      ),
      ...(proof ? { regression_proof: proof } : {}),
    },
  },
});
const verified: RegressionProof = {
  status: "verified",
  reason: "ok",
  repo: "r",
  head_sha: "h1",
  base_sha: "b0",
  before: "failed",
  after: "passed",
};

test("strict gate: author booleans are not evidence; an invalid or stale proof never passes; a verified one does", () => {
  const strict = (proof: RegressionProof | null, tested?: string) =>
    enforceRootCauseReview(pass, check, upstream(proof, tested) as never, "strict");
  assert.equal(strict(null).verdict, "BLOCKED");
  assert.match(String(strict(null).blocked_reason), /no platform-run regression proof/);
  assert.equal(
    strict({ ...verified, status: "unmeasured", reason: "not an executable test id" }).verdict,
    "BLOCKED",
  );
  const invalid = strict({
    ...verified,
    status: "invalid",
    reason: "already passes without the fix",
    before: "passed",
  });
  assert.equal(invalid.verdict, "FAIL");
  assert.equal(
    strict(verified, "h2").verdict,
    "BLOCKED",
    "proof of another commit than the one tested",
  );
  assert.equal(strict(verified).verdict, "PASS");
  assert.equal(proofProblem(verified, { r: "h1" }), null);
  // standard depth keeps its existing rule (a documented limitation or the reviewer's demonstration), but a measured
  // contradiction still fails
  assert.equal(
    enforceRootCauseReview(pass, check, upstream(null) as never, "standard").verdict,
    "PASS",
  );
  assert.equal(
    enforceRootCauseReview(
      pass,
      check,
      upstream({ ...verified, status: "invalid", reason: "x" }) as never,
      "standard",
    ).verdict,
    "FAIL",
  );
});
