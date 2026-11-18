import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolLoopDetector, decide, type PolicyContext } from "../src/agent/toolPolicy.ts";

test("ToolLoopDetector detects consecutive identical tool calls", () => {
  const detector = new ToolLoopDetector({ consecutiveThreshold: 3 });

  // 1st call
  assert.equal(detector.check("Read", { file_path: "a.ts" }).isLoop, false);
  detector.record("Read", { file_path: "a.ts" });

  // 2nd call
  assert.equal(detector.check("Read", { file_path: "a.ts" }).isLoop, false);
  detector.record("Read", { file_path: "a.ts" });

  // 3rd call
  assert.equal(detector.check("Read", { file_path: "a.ts" }).isLoop, false);
  detector.record("Read", { file_path: "a.ts" });

  // 4th call: already 3 consecutive identical recorded!
  const check = detector.check("Read", { file_path: "a.ts" });
  assert.equal(check.isLoop, true);
  assert.ok(check.reason?.includes("Repeated tool call loop detected"));
});

test("ToolLoopDetector detects alternating cyclic tool calls (A-B-A-B-A-B)", () => {
  const detector = new ToolLoopDetector({ consecutiveThreshold: 5, cycleThreshold: 3 });

  const callA = { tool: "Read", input: { file_path: "foo.ts" } };
  const callB = { tool: "Grep", input: { pattern: "bar" } };

  // Cycle 1: A then B
  detector.record(callA.tool, callA.input);
  detector.record(callB.tool, callB.input);

  // Cycle 2: A then B
  detector.record(callA.tool, callA.input);
  detector.record(callB.tool, callB.input);

  // Cycle 3: A then B
  detector.record(callA.tool, callA.input);
  detector.record(callB.tool, callB.input);

  // Next call would be A again: alternating pattern repeated 3 times
  const check = detector.check(callA.tool, callA.input);
  assert.equal(check.isLoop, true);
  assert.ok(check.reason?.includes("Cyclic tool call loop detected"));
});

test("ToolLoopDetector does not flag progressive calls with varying arguments", () => {
  const detector = new ToolLoopDetector({ consecutiveThreshold: 3 });

  // Read with different offsets
  detector.record("Read", { file_path: "a.ts", offset: 0 });
  detector.record("Read", { file_path: "a.ts", offset: 100 });
  detector.record("Read", { file_path: "a.ts", offset: 200 });

  assert.equal(detector.check("Read", { file_path: "a.ts", offset: 300 }).isLoop, false);

  // Grep with different patterns
  detector.record("Grep", { pattern: "one", path: "src" });
  detector.record("Grep", { pattern: "two", path: "src" });
  detector.record("Grep", { pattern: "three", path: "src" });

  assert.equal(detector.check("Grep", { pattern: "four", path: "src" }).isLoop, false);
});

test("decide records each call and blocks a looping one", () => {
  const loopDetector = new ToolLoopDetector({ consecutiveThreshold: 2 });
  const policy: PolicyContext = {
    mode: "coding",
    baseBranch: "main",
    workspaces: ["/wt/repo"],
    loopDetector,
  };

  // decide() records every decided call itself, for every provider.
  assert.equal(decide("Read", { file_path: "/wt/repo/file.ts" }, policy).allow, true);
  assert.equal(decide("Read", { file_path: "/wt/repo/file.ts" }, policy).allow, true);

  // 3rd call exceeds threshold of 2
  const decision = decide("Read", { file_path: "/wt/repo/file.ts" }, policy);
  assert.equal(decision.allow, false);
  assert.ok(decision.reason?.includes("Repeated tool call loop detected"));
});

test("loop detection normalizes platform aliases and argument ordering and permits changed observations", () => {
  const detector = new ToolLoopDetector({ consecutiveThreshold: 2 });
  detector.record("mcp__platform__search_code", { query: "refund", limit: 2 }, "ok", "old result");
  detector.record("platform.search_code", { limit: 2, query: "refund" }, "ok", "old result");
  assert.equal(detector.check("search_code", { query: "refund", limit: 2 }).isLoop, true);
  detector.record("search_code", { query: "refund", limit: 2 }, "ok", "new result");
  assert.equal(detector.check("search_code", { limit: 2, query: "refund" }).isLoop, false);
});
