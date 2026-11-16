import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  notApplicableCovers,
  testEvidence,
  verificationLoop,
  verifyConfig,
  verifyWorkspaces,
  type VerifyConfig,
} from "../src/agent/verify.ts";

function repo() {
  const path = mkdtempSync(join(tmpdir(), "verify-evidence-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", path, ...a], { stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(path, "README.md"), "x");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return { path, done: () => rmSync(path, { recursive: true, force: true }) };
}
const cfg = (extra: Partial<VerifyConfig> = {}): VerifyConfig => ({
  command: "run-tests",
  maxRepairs: 0,
  timeoutMs: 30000,
  baseline: null,
  allowTestWeakening: false,
  ...extra,
});
const verify = (path: string, output: string, code: number | null, c: VerifyConfig, files: string[] = []) =>
  verifyWorkspaces([{ repo: "app", path }], [path], c, 1, new AbortController().signal, {
    run: async () => ({ code, timedOut: false, output }),
    diffTests: async () => "",
    changedFiles: async () => files,
  });

test("exit 0 without any executed test is NOT_EXECUTED, never PASSED", async () => {
  const r = repo();
  try {
    for (const output of [
      "",
      "no test runner detected",
      "no Go packages changed",
      "VERIFY_NOT_EXECUTED: package.json has no test script",
      "ok  \tapp/pkg\t0.01s [no tests to run]",
      "# tests 3\n# pass 0\n# skipped 3\n",
    ]) {
      const round = await verify(r.path, output, 0, cfg());
      assert.equal(round.passed, false, output);
      assert.equal(round.repos[0].status, "not_executed", output);
      assert.equal(round.repos[0].outcome, "NOT_EXECUTED", output);
      assert.equal(round.error, true, "not repairable by the agent");
    }
  } finally {
    r.done();
  }
});

test("a real run is PASSED and a failing run is FAILED", async () => {
  const r = repo();
  try {
    const ok = await verify(r.path, "# tests 4\n# pass 4\n# fail 0\n# skipped 0\n", 0, cfg());
    assert.equal(ok.passed, true);
    assert.equal(ok.repos[0].outcome, "PASSED");
    assert.equal(ok.repos[0].evidence?.executed, 4);
    const go = await verify(r.path, "ok  \tapp/pkg\t0.20s\n", 0, cfg());
    assert.equal(go.repos[0].outcome, "PASSED");
    const bad = await verify(r.path, "# tests 4\n# pass 3\n# fail 1\n", 1, cfg());
    assert.equal(bad.repos[0].outcome, "FAILED");
  } finally {
    r.done();
  }
});

test("NOT_APPLICABLE only comes from the workflow policy and only for covered, non-test files", async () => {
  const r = repo();
  try {
    const policy = { allowedPaths: ["docs/**", "*.md"], reason: "docs only" };
    const ok = await verify(r.path, "", 0, cfg({ notApplicable: policy }), ["docs/a/b.md", "README.md"]);
    assert.equal(ok.repos[0].outcome, "NOT_APPLICABLE");
    assert.equal(ok.passed, true);
    for (const files of [["src/a.ts"], ["docs/a.md", "src/a.ts"], ["docs/x.test.ts"], []]) {
      const bad = await verify(r.path, "", 0, cfg({ notApplicable: policy }), files);
      assert.equal(bad.repos[0].outcome, "NOT_EXECUTED", files.join());
    }
    // No policy: rejected even for docs. The agent claiming it in its own output is ignored.
    const none = await verify(r.path, "NOT_APPLICABLE: docs only", 0, cfg(), ["README.md"]);
    assert.equal(none.repos[0].outcome, "NOT_EXECUTED");
    assert.equal(notApplicableCovers(undefined, ["README.md"]), false);
  } finally {
    r.done();
  }
});

test("verifyConfig reads not_applicable from the definition only when complete", () => {
  assert.deepEqual(
    verifyConfig({ verify: { not_applicable: { allowed_paths: ["docs/**"], reason: "docs" } } }, "x")?.notApplicable,
    { allowedPaths: ["docs/**"], reason: "docs" },
  );
  assert.equal(verifyConfig({ verify: { not_applicable: { allowed_paths: ["docs/**"] } } }, "x")?.notApplicable, undefined);
});

test("the verification loop stops without a repair when nothing was executed", async () => {
  const r = repo();
  try {
    let repairs = 0;
    const loop = await verificationLoop({
      cfg: cfg({ maxRepairs: 2 }),
      signal: new AbortController().signal,
      verify: () => verify(r.path, "", 0, cfg()).then((x) => ({ ...x, round: 1 })),
      repair: async () => (repairs++, undefined),
    });
    assert.equal(loop.outcome, "error");
    assert.equal(repairs, 0);
  } finally {
    r.done();
  }
});

test("testEvidence parses node:test, Go and markers", () => {
  assert.equal(testEvidence("ℹ tests 2\nℹ pass 2\nℹ skipped 0\n").executed, 2);
  assert.equal(testEvidence("Tests:       5 passed, 5 total").executed, 5);
  assert.equal(testEvidence("--- PASS: TestA (0.00s)\n").executed, 1);
  assert.equal(testEvidence("hello").executed, null);
  assert.equal(testEvidence("no matching test files; targeted suite skipped").marker, true);
});

test("testEvidence reads go test -json events and ignores package-level events", () => {
  const pass = '{"Time":"t","Action":"pass","Package":"p","Test":"TestA","Elapsed":0}\n{"Time":"t","Action":"pass","Package":"p","Elapsed":0.1}\n';
  assert.deepEqual(testEvidence(pass), { executed: 1, skipped: 0, marker: false });
  const none = '{"Time":"t","Action":"skip","Package":"p","Elapsed":0}\n';
  assert.equal(testEvidence(none).executed, null);
  const skipped = '{"Action":"skip","Package":"p","Test":"TestB","Elapsed":0}\n';
  assert.deepEqual(testEvidence(skipped), { executed: 0, skipped: 1, marker: false });
});
