import { test } from "node:test";
import assert from "node:assert/strict";
import { developerQuestionIssue } from "../src/agent/contextToolSchemas.ts";
import { describeOwnedTool } from "../src/agent/platformTools.ts";

test("ask_user rejects a schema probe and describe_tool returns its schema", () => {
  assert.match(developerQuestionIssue("test") ?? "", /schema probe/);
  assert.equal(
    developerQuestionIssue("Splunk không kết nối được, chạy SPL này và dán kết quả"),
    null,
  );

  const described = describeOwnedTool("ask_user");
  assert.ok(described);
  assert.match(described.description, /schema probe/);
  assert.equal(described.input_schema.properties.questions.items.properties.question.type, "string");
  assert.match(
    String(described.input_schema.properties.questions.items.properties.question.description),
    /Not a schema probe/,
  );
  assert.equal(describeOwnedTool("splunk_search"), null);
});
