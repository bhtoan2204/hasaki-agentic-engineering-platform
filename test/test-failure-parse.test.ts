import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnose, parseNodeTest } from "../src/workflow/executors/testFailure.ts";

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
