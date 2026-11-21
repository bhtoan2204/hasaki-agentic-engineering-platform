import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { knowledgeScanRequest, KNOWLEDGE_SCAN_VERSION } from "../src/knowledge/goKnowledge.ts";

const schema = JSON.parse(
  readFileSync(new URL("../go/contracts/knowledge-v1.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ strict: false });
ajv.addSchema(schema);
const validate = (def: string, v: unknown) =>
  assert.ok(ajv.validate(`knowledge-v1#/$defs/${def}`, v), `${def}: ${ajv.errorsText()}`);

test("the TypeScript importer sends knowledge-v1 ScanRequests, at the version Go implements", () => {
  validate(
    "ScanRequest",
    knowledgeScanRequest(
      [
        { name: "svc", root: "/repos/svc", self: false },
        { name: "platform", root: "/repos/platform", self: true },
      ],
      "/home/u/.claude/skills",
    ),
  );
  validate("ScanRequest", knowledgeScanRequest([], null));
  const go = readFileSync(new URL("../go/internal/knowledge/http.go", import.meta.url), "utf8");
  assert.equal(/const ScanVersion = "([^"]+)"/.exec(go)![1], KNOWLEDGE_SCAN_VERSION);
});
