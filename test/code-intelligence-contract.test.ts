import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { config } from "../src/config.ts";
import { goIndexRequest } from "../src/codeIntelligence/indexer.ts";
import { parserVersion } from "../src/codeIntelligence/parser.ts";
import { goSearchRequest } from "../src/codeIntelligence/goSearch.ts";

const schema = JSON.parse(
  readFileSync(
    new URL("../go/contracts/code-intelligence-v1.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv2020({ strict: false });
ajv.addSchema(schema);
const validate = (def: string, v: unknown) =>
  assert.ok(ajv.validate(`code-intelligence-v1#/$defs/${def}`, v), `${def}: ${ajv.errorsText()}`);

test("the TypeScript indexer sends code-intelligence-v1 IndexRequests", () => {
  const base = "a".repeat(40);
  validate("IndexRequest", goIndexRequest(7, "/repos/x", "/repos/x", base, undefined, undefined));
  validate(
    "IndexRequest",
    goIndexRequest(7, "/repos/x", "/data/wt/x", base, 42, { id: 3, token: 9 }),
  );
});

test("the request carries this platform's index version, which Go must reproduce", () => {
  const go = readFileSync(
    new URL("../go/internal/codeintelligence/extract.go", import.meta.url),
    "utf8",
  );
  const extractor = /const ExtractorVersion = "([^"]+)"/.exec(go)![1];
  assert.ok(
    parserVersion().startsWith(extractor + "/"),
    "INDEX_VERSION changed: update the Go extractor and its parity golden, then ExtractorVersion",
  );
  assert.equal(
    goIndexRequest(1, "/r", "/r", "b".repeat(40), undefined, undefined).limits.max_symbols,
    config.codeIntelligence.maxSymbols,
  );
});

test("code search sends code-intelligence-v1 SearchRequests for every operation", () => {
  const resolved = {
    repositories: [
      {
        name: "a",
        repository_id: 1,
        root: "/repos/a",
        primary: "/repos/a",
        default_branch: "main",
        run_id: null,
      },
      {
        name: "b",
        repository_id: 2,
        root: "/data/wt/b",
        primary: "/repos/b",
        default_branch: "dev",
        run_id: 4,
      },
    ],
    unavailable: [{ name: "c", error: "Repository unavailable or unauthorized" }],
  };
  const roots = ["/repos", "/data"];
  validate(
    "SearchRequest",
    goSearchRequest("symbols", { text: "searchSymbols", limit: 30 }, resolved, roots),
  );
  validate(
    "SearchRequest",
    goSearchRequest(
      "dependencies",
      { symbol: "fresh", depth: 2, direction: "in" },
      resolved,
      roots,
    ),
  );
  validate(
    "SearchRequest",
    goSearchRequest("exact", { pattern: "fresh(", limit: 20, any_file: true }, resolved, roots),
  );
  validate(
    "SearchRequest",
    goSearchRequest("context", { text: "buildCodeContext" }, resolved, roots),
  );
  assert.ok(
    !ajv.validate(
      "code-intelligence-v1#/$defs/SearchRequest",
      goSearchRequest("exact", { limit: 999 }, resolved, roots),
    ),
  );
});
