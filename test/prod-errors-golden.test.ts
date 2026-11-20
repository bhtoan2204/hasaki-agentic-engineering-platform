import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GOLDEN_PATH, goldenOutput } from "./fixtures/prodErrorsGolden.ts";

test("the Go grouping golden matches TypeScript's mergeSourceRows + toGroups (regenerate with --write)", () => {
  assert.deepEqual(
    JSON.parse(readFileSync(GOLDEN_PATH, "utf8")),
    JSON.parse(JSON.stringify(goldenOutput())),
  );
});
