import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Language } from "web-tree-sitter";
import { extract, ParserLoadError } from "../src/codeIntelligence/parser.ts";
import { diagnostic } from "../src/codeIntelligence/indexer.ts";

test("A failed grammar load is visible, source-safe and retryable after assets are repaired", async () => {
  const loader = mock.method(Language, "load", async () => {
    throw new Error("private source or path must not be logged");
  });
  await assert.rejects(extract("retry.go", "package retry\nfunc Recovered() {}"), ParserLoadError);
  assert.equal(
    diagnostic(new ParserLoadError("go", new Error("secret"))),
    "Parser unavailable (go); check installed WASM assets",
  );
  loader.mock.restore();
  assert.ok(
    (await extract("retry.go", "package retry\nfunc Recovered() {}"))!.symbols.some(
      (s) => s.symbol_name === "Recovered",
    ),
  );
  assert.equal(
    diagnostic(Object.assign(new Error("private filename"), { code: "EACCES" })),
    "Indexing source permission denied",
  );
});

test("Source permission errors are rejected without reading content", async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { readSource } = await import("../src/codeIntelligence/git.ts");
  const directory = mkdtempSync(join(process.env.TEST_ROOT!, "permissions-"));
  const path = join(directory, "private.go");
  writeFileSync(path, "package private");
  chmodSync(path, 0);
  try {
    await assert.rejects(readSource(directory, "private.go"), {
      code: "EACCES",
    });
  } finally {
    chmodSync(path, 0o600);
  }
});
