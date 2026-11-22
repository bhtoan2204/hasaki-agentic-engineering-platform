/**
 * Grading semantics (P0, T03): identifier lists whose order carries no meaning are compared as sets, duplicates are
 * rejected on their own, ranked lists stay ordered, and every mismatch comes with a structured diagnosis (expected,
 * actual, missing, unexpected, duplicates, ordering, count consistency). Both variants use the same rules. Pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeAnswer, TASKS } from "../src/eval/codeactTasks.ts";

// T03's reference, reconstructed from the fixture data (printed by referenceAnswer; checked in the integration test).
const T03 = {
  order_ids: [
    "ORD-101",
    "ORD-113",
    "ORD-125",
    "ORD-137",
    "ORD-149",
    "ORD-17",
    "ORD-29",
    "ORD-41",
    "ORD-5",
    "ORD-53",
    "ORD-65",
    "ORD-77",
    "ORD-89",
  ],
  count: 13,
};
const t03 = TASKS.find((t) => t.id === "T03-trace-log-correlation")!;
const grade = (answer: Record<string, unknown> | null) => gradeAnswer(T03, answer, t03.grading);
const natural = [...T03.order_ids].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));

test("before: the old exact-JSON grader rejected the right orders listed in natural numeric order", () => {
  // Same membership, same count, different (equally 'sorted') order: the old rule (no grading spec) says wrong.
  const old = gradeAnswer(T03, { order_ids: natural, count: 13 });
  assert.equal(old.correct, false);
  assert.equal(old.fields.order_ids, false);
});

test("after: lexicographic and natural numeric orderings of the right set are both correct", () => {
  for (const ids of [T03.order_ids, natural, [...natural].reverse()]) {
    const g = grade({ order_ids: ids, count: 13 });
    assert.equal(g.correct, true, JSON.stringify(g.diagnostics));
  }
  assert.equal(grade({ order_ids: natural, count: 13 }).diagnostics.order_ids.order_differs, true);
});

test("missing, extra and duplicate ids are rejected, each with its own diagnosis", () => {
  const missing = grade({ order_ids: T03.order_ids.slice(1), count: 12 });
  assert.equal(missing.correct, false);
  assert.deepEqual(missing.diagnostics.order_ids.missing, ["ORD-101"]);
  const extra = grade({ order_ids: [...T03.order_ids, "ORD-3"], count: 14 });
  assert.equal(extra.correct, false);
  assert.deepEqual(extra.diagnostics.order_ids.unexpected, ["ORD-3"]);
  const dup = grade({ order_ids: [...T03.order_ids, "ORD-5"], count: 13 });
  assert.equal(dup.correct, false, "a duplicate is wrong even when the set matches");
  assert.deepEqual(dup.diagnostics.order_ids.duplicates, ["ORD-5"]);
  const swapped = grade({ order_ids: [...T03.order_ids.slice(1), "ORD-3"], count: 13 });
  assert.equal(swapped.correct, false, "right count, wrong membership");
  assert.deepEqual(
    [swapped.diagnostics.order_ids.missing, swapped.diagnostics.order_ids.unexpected],
    [["ORD-101"], ["ORD-3"]],
  );
});

test("count is checked against the reference and against the answer's own list", () => {
  const wrongCount = grade({ order_ids: T03.order_ids, count: 12 });
  assert.equal(wrongCount.correct, false);
  assert.deepEqual(wrongCount.diagnostics.count, {
    expected: 13,
    actual: 12,
    consistent_with: { field: "order_ids", distinct: 13, consistent: false },
  });
});

test("empty intersections are graded exactly: [] matches only []", () => {
  const empty = { order_ids: [], count: 0 };
  assert.equal(gradeAnswer(empty, { order_ids: [], count: 0 }, t03.grading).correct, true);
  assert.equal(gradeAnswer(empty, { order_ids: ["ORD-1"], count: 1 }, t03.grading).correct, false);
  assert.equal(gradeAnswer(empty, { order_ids: null, count: 0 }, t03.grading).correct, false);
});

test("ranked lists stay ordered (T05 top): a reordered ranking is wrong", () => {
  const t05 = TASKS.find((t) => t.id === "T05-common-failures")!;
  const exp = {
    top: [
      { message: "a", count: 3 },
      { message: "b", count: 2 },
    ],
  };
  assert.equal(gradeAnswer(exp, exp, t05.grading).correct, true);
  const g = gradeAnswer(exp, { top: [exp.top[1], exp.top[0]] }, t05.grading);
  assert.equal(g.correct, false);
  assert.equal(g.diagnostics.top.order_differs, true);
});

test("the output contract states the ordering semantics of every list field, and grading follows it", () => {
  for (const t of TASKS) {
    for (const [field, rule] of Object.entries(t.grading ?? {})) {
      if (rule.kind === "set") assert.match(t.question, /any order/, `${t.id}.${field}`);
      if (rule.kind === "ordered") assert.match(t.question, /ordered by/, `${t.id}.${field}`);
    }
    assert.doesNotMatch(t.question, /\[sorted /, `${t.id}: "sorted" without a defined order`);
  }
});

test("unparseable or absent answers stay wrong; non-null claims where the reference is null are unsupported", () => {
  assert.equal(grade(null).answered, false);
  const g = gradeAnswer({ slowest_operation: null }, { slowest_operation: "refund.db.update" });
  assert.equal(g.correct, false);
  assert.equal(g.unsupported, 1);
});
