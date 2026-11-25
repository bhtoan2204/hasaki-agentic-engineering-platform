import { test } from "node:test";
import assert from "node:assert/strict";
import { groundFindings } from "../src/agent/codeEvidence.ts";

const call = (id: number, text: string) => ({ id, tool: "platform.search_code", text });

test("a finding is grounded only by a code-intelligence result that shows its file", () => {
  const [a, b, c] = groundFindings(
    [{ file: "pkg/discorde/client.go" }, { file: "./app/http/app.go" }, { file: "missing.go" }],
    [call(7, '{"result":"pkg/discorde/client.go:12-30 commit=abc"}'), call(9, "app/http/app.go:5")],
  );
  assert.deepEqual(a.code_evidence, { status: "verified", calls: [7] });
  assert.deepEqual(b.code_evidence, { status: "verified", calls: [9] });
  assert.equal(c.code_evidence.status, "missing");
  assert.match((c.code_evidence as { reason: string }).reason, /no code-intelligence result/);
});

test("no file, or no call at all, is never grounded", () => {
  const [noFile] = groundFindings([{ issue: "x" } as { file?: unknown }], [call(1, "anything")]);
  assert.deepEqual(noFile.code_evidence, {
    status: "missing",
    reason: "the finding names no file",
  });
  const [noCalls] = groundFindings([{ file: "ids.go" }], []);
  assert.match(
    (noCalls.code_evidence as { reason: string }).reason,
    /made no code-intelligence call/,
  );
});
