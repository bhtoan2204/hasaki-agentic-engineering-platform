/** CRASH / MONEY classification: the vectors are shared with go/internal/proderrors/classify_test.go. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { isCrash, isMoney } from "../src/prodErrors/severity.ts";

const vectors = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../go/internal/proderrors/testdata/classify-vectors.json"),
    "utf8",
  ),
) as Array<{ name: string; text: string; crash: boolean; money: boolean }>;

test("crash and money vectors (shared with the Go port)", () => {
  assert.ok(vectors.length > 30);
  for (const v of vectors) {
    assert.equal(isCrash(v.text), v.crash, `crash: ${v.name}`);
    assert.equal(isMoney(v.text), v.money, `money: ${v.name}`);
  }
});
