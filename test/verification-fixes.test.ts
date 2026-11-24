import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  failureSignature,
  fixRegressionTest,
  repairPrompt,
  type RepoVerification,
  type VerificationRound,
} from "../src/agent/verify.ts";

const goRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "fix-test-"));
  writeFileSync(join(dir, "go.mod"), "module fixfix\n\ngo 1.20\n");
  return [{ repo: "r", path: dir }];
};
const fix = (name: string, kind = "ROOT_CAUSE_FIX") =>
  ({ kind, regression_test: { name, fails_before: true, passes_after: true } }) as never;

test("a fix's regression test becomes a required test, including a malformed id (it must fail verification, not vanish)", async () => {
  const ws = goRepo();
  for (const kind of ["ROOT_CAUSE_FIX", "PARTIAL_FIX"])
    for (const name of [
      "fixfix/TestCapped",
      "TestCapped",
      "r::pkg/x_test.go TestCapped",
      "other/TestCapped",
    ])
      assert.equal(await fixRegressionTest(ws, fix(name, kind)), name, `${kind} ${name}`);
});

test("no required test without a fix claim, a named test, or when only a foreign runner could run it (documented limitation stays valid)", async () => {
  const ws = goRepo();
  assert.equal(await fixRegressionTest(ws, null), null);
  assert.equal(await fixRegressionTest(ws, fix("fixfix/TestCapped", "MITIGATION")), null);
  assert.equal(await fixRegressionTest(ws, fix("")), null);
  assert.equal(
    await fixRegressionTest(ws, { kind: "ROOT_CAUSE_FIX", regression_test: null }),
    null,
  );
  const js = mkdtempSync(join(tmpdir(), "fix-js-"));
  writeFileSync(join(js, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
  mkdirSync(join(js, "src"));
  writeFileSync(join(js, "src/a.test.ts"), "");
  assert.equal(
    await fixRegressionTest([{ repo: "web", path: js }], fix("web::src/a.test.ts")),
    null,
    "jest cannot run under the structured runner",
  );
  assert.equal(
    await fixRegressionTest([{ repo: "web", path: js }], fix("web::src/a b.test.ts")),
    "web::src/a b.test.ts",
    "a malformed id is never excused as a foreign runner",
  );
});

const failedRound = (note: string): VerificationRound =>
  ({
    round: 1,
    passed: false,
    error: false,
    needs_review: false,
    signature: "",
    duration_ms: 1,
    repos: [
      {
        repo: "r",
        status: "failed",
        passed: false,
        exit_code: 0,
        timed_out: false,
        regressions: [],
        pre_existing: 0,
        weakened: [],
        suspected: [],
        excerpt: "",
        note,
      } as unknown as RepoVerification,
    ],
  }) as unknown as VerificationRound;
const CFG = { command: "go test ./...", maxRepairs: 2 } as never;

test("the repair prompt tells the agent why required tests failed and where to correct the id", () => {
  const note =
    "Required test ownership could not be established: TestCapped: test has no authorized repository owner";
  const prompt = repairPrompt(failedRound(note), 1, CFG, "en");
  assert.ok(prompt.includes(note));
  assert.match(prompt, /remediation\.regression_test\.name/);
  assert.doesNotMatch(
    repairPrompt(failedRound("exit 1 without a parseable test failure"), 1, CFG, "en"),
    /Required tests are executable test ids/,
  );
});

test("different required-test failures are not 'the same failure twice'", () => {
  const owner = failureSignature(
    failedRound("Required test ownership could not be established: x").repos,
  );
  const failing = failureSignature(
    failedRound('Required tests lack passing structured evidence: {"fixfix/TestCapped":"failed"}')
      .repos,
  );
  assert.notEqual(owner, failing);
  assert.equal(
    owner,
    failureSignature(failedRound("Required test ownership could not be established: x").repos),
  );
});
