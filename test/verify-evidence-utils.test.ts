import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, emptyStats, firstDifference } from "../src/agent/verifyEvidence.ts";

describe("canonicalJson", () => {
  test("recursively sorts object keys alphabetically", () => {
    const unordered = {
      z: 1,
      a: {
        d: 4,
        b: 2,
        c: 3,
      },
      m: "middle",
    };
    const expected = '{"a":{"b":2,"c":3,"d":4},"m":"middle","z":1}';
    assert.equal(canonicalJson(unordered), expected);
  });

  test("preserves array element order and handles mixed structures", () => {
    const objWithArray = {
      b: [
        { z: 1, a: 2 },
        { y: 3, x: 4 },
      ],
      a: "first",
    };
    const expected = '{"a":"first","b":[{"a":2,"z":1},{"x":4,"y":3}]}';
    assert.equal(canonicalJson(objWithArray), expected);
  });

  test("handles primitives, null, and empty structures", () => {
    assert.equal(canonicalJson(null), "null");
    assert.equal(canonicalJson(42), "42");
    assert.equal(canonicalJson("hello"), '"hello"');
    assert.equal(canonicalJson({}), "{}");
    assert.equal(canonicalJson([]), "[]");
  });
});

describe("firstDifference", () => {
  test("returns 'none_found' when both evidence parts are identical", () => {
    const parts = {
      head: "commit1",
      command: "go test",
      timeout: "30s",
    };
    assert.equal(firstDifference(parts, { ...parts }), "none_found");
  });

  test("prioritizes standard keys according to the declared priority order", () => {
    // Declared order: head > workspace_fingerprint > base_tip > contract_revision > command > ...
    const prev = {
      head: "h1",
      command: "cmd1",
      timeout: "10s",
    };
    const next = {
      head: "h2", // differs
      command: "cmd2", // also differs
      timeout: "20s", // also differs
    };
    // 'head' comes before 'command' and 'timeout'
    assert.equal(firstDifference(prev, next), "head");

    const prev2 = {
      head: "h1",
      workspace_fingerprint: "wf1",
      command: "cmd1",
    };
    const next2 = {
      head: "h1",
      workspace_fingerprint: "wf2", // differs
      command: "cmd2", // also differs
    };
    // 'workspace_fingerprint' comes before 'command'
    assert.equal(firstDifference(prev2, next2), "workspace_fingerprint");
  });

  test("detects differences in custom keys not in the standard order", () => {
    const prev = {
      head: "h1",
      custom_flag: "false",
    };
    const next = {
      head: "h1",
      custom_flag: "true",
    };
    assert.equal(firstDifference(prev, next), "custom_flag");
  });

  test("treats missing and empty string properties equivalently", () => {
    const prev = { head: "h1", timeout: "" };
    const next = { head: "h1" }; // timeout is missing
    assert.equal(firstDifference(prev, next), "none_found");

    const nextDifferent = { head: "h1", timeout: "30s" };
    assert.equal(firstDifference(prev, nextDifferent), "timeout");
  });
});

describe("emptyStats", () => {
  test("returns initial stats with zeroes and empty arrays", () => {
    const stats = emptyStats();
    assert.equal(stats.hits, 0);
    assert.equal(stats.misses, 0);
    assert.equal(stats.reused, 0);
    assert.equal(stats.duplicates_avoided, 0);
    assert.equal(stats.saved_ms, 0);
    assert.deepEqual(stats.invalidations, []);
    assert.deepEqual(stats.not_stored, []);
    assert.deepEqual(stats.store_errors, []);
  });
});
