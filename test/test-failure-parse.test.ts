import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnose, extractLog, parseNodeTest } from "../src/workflow/executors/testFailure.ts";

const TAP = `TAP version 13
# Subtest: passes
ok 1 - passes
  ---
  duration_ms: 0.43
  type: 'test'
  ...
# Subtest: group
    # Subtest: inner fails
    not ok 1 - inner fails
      ---
      duration_ms: 0.51
      type: 'test'
      location: '/work/repo/test/x.test.ts:4:38'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:
        1 !== 2
      code: 'ERR_ASSERTION'
      ...
    1..1
not ok 2 - group
  ---
  duration_ms: 0.73
  type: 'test'
  location: '/work/repo/test/x.test.ts:4:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...
1..2
# fail 2
`;

test("parseNodeTest returns leaf failures with their file and log, skipping parents that only fail through subtests", () => {
  const failures = parseNodeTest(TAP);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].test, "inner fails");
  assert.equal(failures[0].file, "test/x.test.ts");
  assert.match(failures[0].log, /1 !== 2/);
});

test("diagnose names node test failures instead of reporting an unparseable script error", () => {
  const d = diagnose({
    command: "npm run test:all",
    outputs: { platform: TAP },
    results: [{ repo: "platform", exit_code: 1, timed_out: false, artifact_id: 1 }],
  });
  assert.equal(d.failures.length, 1);
  assert.equal(d.failures[0].test, "inner fails");
  assert.equal(d.failures[0].package, "test/x.test.ts");
  assert.doesNotMatch(d.failures[0].reason, /no per-test failure/);
});

test("parseNodeTest handles empty inputs, non-TAP text, ANSI escapes, quoted names, and location variants", () => {
  // empty & non-TAP
  assert.deepEqual(parseNodeTest(""), []);
  assert.deepEqual(parseNodeTest("   "), []);
  assert.deepEqual(parseNodeTest("some random compiler output\nerror: failed"), []);

  // ANSI escapes and quoted test names
  const ansiTap = [
    "\x1b[31mnot ok 1 - 'quoted-test-name'\x1b[0m",
    "  ---",
    "  location: 'file:///work/repo/src/server.ts:10:5'",
    "  failureType: 'testCodeFailure'",
    "  ...",
  ].join("\n");
  const parsedAnsi = parseNodeTest(ansiTap);
  assert.equal(parsedAnsi.length, 1);
  assert.equal(parsedAnsi[0].test, "quoted-test-name");
  assert.equal(parsedAnsi[0].file, "server.ts"); // outside /test/, extracts basename

  // missing location
  const noLocTap = ["not ok 2 - test without location", "  ---", "  error: 'boom'", "  ..."].join(
    "\n",
  );
  const parsedNoLoc = parseNodeTest(noLocTap);
  assert.equal(parsedNoLoc.length, 1);
  assert.equal(parsedNoLoc[0].file, "(node test)");
});

test("extractLog extracts test failure logs, strips ANSI escapes, and caps at max", () => {
  const goOutput = [
    "=== RUN   TestPass",
    "--- PASS: TestPass (0.01s)",
    "=== RUN   TestFail",
    "    fail_test.go:42: expected true got false",
    "--- FAIL: TestFail (0.02s)",
    "FAIL",
  ].join("\n");

  const extracted = extractLog(goOutput, "TestFail", null);
  assert.match(extracted, /=== RUN {3}TestFail/);
  assert.match(extracted, /fail_test\.go:42/);
  assert.match(extracted, /--- FAIL: TestFail/);
  assert.doesNotMatch(extracted, /TestPass/);

  // build error extraction
  const buildOutput = [
    "building package...",
    "pkg/auth/login.go:15:2: undefined: Authenticate",
    "pkg/auth/login.go:16:2: cannot use nil as string",
    "other_file.go:10:1: unused import",
  ].join("\n");
  const extractedBuild = extractLog(buildOutput, null, "pkg/auth/login.go:15:2: undefined");
  assert.match(extractedBuild, /pkg\/auth\/login\.go:15:2/);
  assert.match(extractedBuild, /pkg\/auth\/login\.go:16:2/);

  // fallback to last lines when test / build error not matched
  const fallbackOutput = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const fallback = extractLog(fallbackOutput, null, null);
  assert.ok(!fallback.includes("line 10\n"));
  assert.ok(fallback.includes("line 59"));

  // ANSI escape stripping
  const colored = "\x1b[31m=== RUN   TestColor\x1b[0m\n\x1b[32m--- FAIL: TestColor (0.01s)\x1b[0m";
  const uncolored = extractLog(colored, "TestColor", null);
  assert.ok(!uncolored.includes("\x1b["));

  // length capping at max
  const longOutput = "abcdefghij\n".repeat(50);
  const capped = extractLog(longOutput, null, null, 100);
  assert.ok(capped.length <= 105);
  assert.ok(capped.endsWith("\n…"));

  // empty values
  assert.equal(extractLog("", null, null), "");
});
