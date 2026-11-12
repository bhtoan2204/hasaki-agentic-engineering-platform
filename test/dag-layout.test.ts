import { test } from "node:test";
import assert from "node:assert/strict";
import { autoLayout, edgeEnds } from "../web/src/dagLayout.ts";

const chain = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    key: String.fromCharCode(97 + i),
    depends_on: i === 0 ? [] : [String.fromCharCode(96 + i)],
  }));

test("a long chain folds into a serpentine instead of one column", () => {
  const pos = autoLayout(chain(8));
  assert.deepEqual(
    ["a", "b", "c", "d"].map((k) => pos[k]),
    [
      { x: 0, y: 0 },
      { x: 260, y: 0 },
      { x: 520, y: 0 },
      { x: 780, y: 0 },
    ],
  );
  assert.deepEqual(pos.e, { x: 780, y: 168 });
  assert.deepEqual(pos.f, { x: 520, y: 168 });
  assert.deepEqual(pos.h, { x: 0, y: 168 });
  assert.deepEqual(edgeEnds(pos.d, pos.e), {});
  assert.deepEqual(edgeEnds(pos.e, pos.f), { sourceHandle: "sl", targetHandle: "tr" });
});

test("parallel steps stay on one row and the chain resumes underneath", () => {
  const pos = autoLayout([
    { key: "a", depends_on: [] },
    { key: "b", depends_on: ["a"] },
    { key: "c", depends_on: ["a"] },
    { key: "d", depends_on: ["b", "c"] },
  ]);
  assert.equal(pos.b.y, pos.c.y);
  assert.ok(pos.b.y > pos.a.y);
  assert.ok(pos.d.y > pos.b.y);
  assert.ok(pos.c.x > pos.b.x);
});
