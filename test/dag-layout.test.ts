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

test("parallel steps stack in one column between their neighbours", () => {
  const pos = autoLayout([
    { key: "a", depends_on: [] },
    { key: "b", depends_on: ["a"] },
    { key: "c", depends_on: ["a"] },
    { key: "d", depends_on: ["b", "c"] },
  ]);
  assert.equal(pos.b.x, pos.c.x);
  assert.ok(pos.c.y > pos.b.y);
  assert.ok(pos.b.x > pos.a.x);
  assert.ok(pos.d.x > pos.b.x);
  assert.equal(pos.a.y, (pos.b.y + pos.c.y) / 2);
  assert.equal(pos.d.y, pos.a.y);
});

test("a diamond inside a long chain keeps every band aligned", () => {
  const pos = autoLayout([
    { key: "select" },
    { key: "analyze", depends_on: ["select"] },
    { key: "arch", depends_on: ["analyze"] },
    { key: "sec", depends_on: ["analyze"] },
    { key: "report", depends_on: ["arch", "sec"] },
    { key: "fix", depends_on: ["report"] },
    { key: "test", depends_on: ["fix"] },
    { key: "pr", depends_on: ["test"] },
    { key: "cleanup", depends_on: ["pr"] },
    { key: "result", depends_on: ["cleanup"] },
  ]);
  const top = ["select", "analyze", "report", "fix"].map((k) => pos[k].y);
  assert.ok(top.every((y) => y === top[0]));
  assert.equal(pos.test.x, pos.fix.x);
  assert.ok(pos.test.y > pos.sec.y);
  assert.ok(["pr", "cleanup", "result"].every((k) => pos[k].y === pos.test.y));
  assert.ok(pos.result.x < pos.cleanup.x && pos.cleanup.x < pos.pr.x);
});
