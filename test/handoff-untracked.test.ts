import test from "node:test";
import assert from "node:assert/strict";
import { classifyHandoffUntracked, handoffBlockReason } from "../src/agent/handoff.ts";

test("repair cache does not count toward the handoff untracked limit", () => {
  const names = [
    ...Array.from({ length: 150 }, (_, i) => `.repair-tmp/go-build/b${i}/vet.cfg`),
    "pkg/foo.go",
    "repair-api.log",
  ];
  const plan = classifyHandoffUntracked("oms-api", names);
  assert.deepEqual(plan.source, ["pkg/foo.go", "repair-api.log"]);
  assert.equal(plan.scratchOmitted, 150);
});

test("real untracked files still stop the next agent", () => {
  const names = Array.from({ length: 101 }, (_, i) => `pkg/f${i}.go`);
  assert.throws(() => classifyHandoffUntracked("oms-api", names), /oms-api has 101 untracked files/);
});

test("handoff block reasons stay readable", () => {
  assert.equal(
    handoffBlockReason(new Error("oms-api has 101 untracked files")),
    "Workspace inspection failed: oms-api has 101 untracked files",
  );
  assert.equal(
    handoffBlockReason(new Error("Workspace inspection failed: already wrapped")),
    "Workspace inspection failed: already wrapped",
  );
});
