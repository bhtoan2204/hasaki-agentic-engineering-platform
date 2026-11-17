import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTemplateSpec } from "../src/workflow/definitions.ts";

test("mergeTemplateSpec applies template changes and keeps local edits", () => {
  const base = {
    a: 1,
    b: 1,
    steps: [
      { key: "x", v: 1 },
      { key: "y", v: 1 },
      { key: "gone", v: 1 },
    ],
  };
  const ours = {
    a: 2,
    b: 1,
    steps: [
      { key: "x", v: 1, ui: { x: 5, y: 5 } },
      { key: "mine", v: 1 },
    ],
  };
  const theirs = {
    a: 3,
    b: 4,
    steps: [
      { key: "x", v: 2 },
      { key: "y", v: 2 },
      { key: "gone", v: 1 },
      { key: "new", v: 1 },
    ],
  };
  assert.deepEqual(mergeTemplateSpec(base, ours, theirs), {
    a: 2,
    b: 4,
    steps: [
      { key: "x", v: 2, ui: { x: 5, y: 5 } },
      { key: "new", v: 1 },
      { key: "mine", v: 1 },
    ],
  });
  assert.deepEqual(mergeTemplateSpec(base, base, theirs), theirs);
});
