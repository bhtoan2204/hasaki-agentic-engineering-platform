import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DECISION_ACTIONS, DECISION_KINDS } from "../src/workflow/decisions.ts";

const sql = readFileSync(
  join(import.meta.dirname, "..", "migrations", "067_execution_decisions.sql"),
  "utf8",
);
const listIn = (column: string) =>
  [
    ...new RegExp(`${column} TEXT NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)`)
      .exec(sql)![1]
      .matchAll(/'([^']+)'/g),
  ].map((m) => m[1]);

test("the decision vocabulary in code matches the table constraints", () => {
  assert.deepEqual([...DECISION_KINDS].sort(), listIn("kind").sort());
  assert.deepEqual([...DECISION_ACTIONS].sort(), listIn("action").sort());
  assert.deepEqual(listIn("outcome").sort(), ["applied", "failed", "planned", "rejected"]);
});
