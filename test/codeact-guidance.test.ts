/**
 * CodeAct selection and recovery guidance (Milestone D): one wording on both surfaces (chat `code.execute`, workflow
 * `execute_code`) that weighs expected work and result size — not a fixed tool-count threshold — prefers direct calls
 * for a single small lookup, and tells the agent how to act on a structured failure. This checks the guidance text and
 * its size; only a live provider run can show whether a model follows it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODEACT_GUIDANCE } from "../src/codeact/guidance.ts";
import { contextTool } from "../src/agent/contextToolSchemas.ts";
import { nativeToolDefs } from "../src/chat/tools.ts";
import { withCodeActScope } from "../src/codeact/scope.ts";
import { recoveryAdvice, type FailureCategory } from "../src/codeact/execute.ts";

const chatDescription = () =>
  withCodeActScope(true, () => nativeToolDefs("INVESTIGATE")).find(
    (t) => t.name === "code.execute",
  )!.description;
const workflowDescription = () => contextTool("execute_code")!.description;

test("both surfaces carry the same selection and recovery guidance", () => {
  for (const d of [chatDescription(), workflowDescription()])
    assert.ok(d.includes(CODEACT_GUIDANCE), d);
});

test("guidance prefers direct calls for one small bounded lookup and weighs result size and correlation", () => {
  assert.match(CODEACT_GUIDANCE, /direct call/i);
  assert.match(CODEACT_GUIDANCE, /one small|single small/i);
  assert.match(CODEACT_GUIDANCE, /large/i);
  assert.match(CODEACT_GUIDANCE, /correlat/i);
  assert.match(CODEACT_GUIDANCE, /aggregat|filter/i);
  for (const d of [chatDescription(), workflowDescription()])
    assert.doesNotMatch(d, /\b\d\+\s*(deterministic )?lookups/, "no fixed tool-count threshold");
});

test("recovery guidance: read failure/recovery, retry once only what is fixable, never retry unavailable or unauthorized", () => {
  assert.match(CODEACT_GUIDANCE, /`failure`/);
  assert.match(CODEACT_GUIDANCE, /`recovery`/);
  assert.match(CODEACT_GUIDANCE, /once/);
  assert.match(CODEACT_GUIDANCE, /unavailable|unauthorized/);
  // The advice the agent receives agrees with the guidance for every category.
  const never: FailureCategory[] = [
    "sandbox_unavailable",
    "sandbox_startup_failed",
    "ipc_protocol_error",
    "canceled",
  ];
  for (const category of never)
    assert.equal(recoveryAdvice({ category, phase: "program_run" }).retry, "no");
});

test("schema overhead stays bounded: the guidance replaces, not adds to, the previous usage sentence", () => {
  // Previous descriptions: chat 738 chars, workflow 738 chars (measured before this change). Allow modest growth only.
  assert.ok(chatDescription().length <= 738 + 400, `chat ${chatDescription().length}`);
  assert.ok(workflowDescription().length <= 738 + 400, `workflow ${workflowDescription().length}`);
});
