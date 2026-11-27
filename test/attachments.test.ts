import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { downloadAttachments } from "../src/agent/attachments.ts";
import { tinyDocx } from "./fixtures/documents.ts";

test("a downloaded docx attachment gets a plain-text copy the agent can read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-"));
  const realFetch = globalThis.fetch;
  const base = config.fileBaseUrl;
  config.fileBaseUrl = "https://files.example/hr";
  const docx = tinyDocx("Return receipt", "Printed at the store", [["Field", "Value"]]);
  globalThis.fetch = (async () => new Response(new Uint8Array(docx))) as typeof fetch;
  try {
    const out = await downloadAttachments("k", { note_files: ["task/26/11/27/spec.docx"] }, dir);
    const txt = out.find((p) => p.endsWith("spec.docx.txt"));
    assert.ok(out.some((p) => p.endsWith("spec.docx")));
    assert.ok(txt, "text copy listed next to the original");
    const text = readFileSync(txt!, "utf8");
    assert.match(text, /Return receipt/);
    assert.match(text, /Printed at the store/);
    assert.match(text, /Field/);
  } finally {
    globalThis.fetch = realFetch;
    config.fileBaseUrl = base;
    rmSync(dir, { recursive: true, force: true });
  }
});
