import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DECISION_ACTIONS, DECISION_KINDS } from "../src/workflow/decisions.ts";

const dir = join(import.meta.dirname, "..", "migrations");
const migrations = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(dir, f), "utf8"));
// The newest definition is the one in force: 067 creates the columns, later migrations replace the constraints.
const listIn = (column: string) => {
  const patterns = [
    new RegExp(`execution_decisions_${column}_check CHECK \\(${column} IN \\(([^)]*)\\)`),
    new RegExp(`${column} TEXT NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)`),
  ];
  const sql = migrations.findLast(
    (m) => patterns.some((p) => p.test(m)) && m.includes("execution_decisions"),
  )!;
  const match = patterns.map((p) => p.exec(sql)).find(Boolean)!;
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

test("the decision vocabulary in code matches the table constraints", () => {
  assert.deepEqual([...DECISION_KINDS].sort(), listIn("kind").sort());
  assert.deepEqual([...DECISION_ACTIONS].sort(), listIn("action").sort());
  assert.deepEqual(listIn("outcome").sort(), ["applied", "failed", "planned", "rejected"]);
});
