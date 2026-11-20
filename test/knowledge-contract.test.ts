import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { knowledgeScanRequest, KNOWLEDGE_SCAN_VERSION } from "../src/knowledge/goKnowledge.ts";
import { discoverKnowledge } from "../src/knowledge/importer.ts";

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

test("a TypeScript discovery has the shape of a knowledge-v1 ScanResponse", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kb-contract-")));
  const repo = join(dir, "svc");
  const put = (p: string, s: string) => {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, s);
  };
  put(join(repo, "CLAUDE.md"), "# svc\n\nRules.\n");
  put(join(repo, ".claude/skills/s/SKILL.md"), "---\nname: s\n---\n# S\n");
  put(join(repo, ".claude/skills/s/references/r.md"), "# R\n");
  put(join(repo, "docs/wiki-convention.md"), "token=abcdefghijklmnop1\n");
  execFileSync("git", ["init", "-q", repo]);
  const d = discoverKnowledge([{ name: "svc", root: repo, self: false }], null);
  assert.equal(d.candidates.length, 3);
  validate("ScanResponse", {
    ...d,
    metrics: { files_read: 1, bytes_read: 1, entries: 1, took_ms: 1 },
  });
});
