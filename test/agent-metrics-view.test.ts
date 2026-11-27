import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentAttemptsPerRun,
  agentMs,
  agentSessions,
  defaultModelKey,
  explainedByAi,
} from "../web/src/agentMetrics.ts";
import { messages } from "../shared/i18n/messages.ts";

test("the new agent_* fields win and the old claude_* fields still work", () => {
  assert.equal(agentMs({ agent_ms: 1500, claude_ms: 1500 }), 1500);
  assert.equal(agentMs({ claude_ms: 900 }), 900);
  assert.equal(agentMs({ agent_ms: 0, claude_ms: 900 }), 0);
  assert.equal(agentMs({}), 0);
  assert.equal(agentSessions({ agent_sessions: 2 }), 2);
  assert.equal(agentSessions({ claude_sessions: 3 }), 3);
  assert.equal(
    agentAttemptsPerRun({ agent_attempts_per_run: "1.5", claude_attempts_per_run: "9" }),
    "1.5",
  );
  assert.equal(agentAttemptsPerRun({ claude_attempts_per_run: "2.0" }), "2.0");
});

test("an explanation is AI-written for every provider, and rules-only otherwise", () => {
  for (const by of ["claude", "codex", "copilot", "antigravity", "cursor"])
    assert.equal(explainedByAi(by), true, by);
  assert.equal(explainedByAi("rules"), false);
  assert.equal(explainedByAi(""), false);
  assert.equal(explainedByAi(undefined), false);
});

test("every provider but Claude shows its own default-model label, and each label exists", () => {
  assert.equal(defaultModelKey("claude"), null);
  for (const p of ["codex", "copilot", "antigravity", "cursor"] as const) {
    assert.equal(defaultModelKey(p), `run.${p}.defaultModel`, p);
    assert.ok(messages.vi[`run.${p}.defaultModel` as keyof typeof messages.vi], `vi ${p}`);
    assert.ok(messages.en[`run.${p}.defaultModel` as keyof typeof messages.en], `en ${p}`);
  }
});

test("no run-view label names Claude where any provider can be meant", () => {
  for (const locale of ["vi", "en"] as const) {
    assert.doesNotMatch(
      messages[locale]["rv.barAgent" as keyof (typeof messages)["vi"]] ?? "",
      /Claude/,
    );
    assert.doesNotMatch(
      messages[locale]["ins.col.agent" as keyof (typeof messages)["vi"]] ?? "",
      /Claude/,
    );
    assert.ok(
      messages[locale]["rv.barAgent" as keyof (typeof messages)["vi"]],
      `${locale} rv.barAgent`,
    );
    assert.ok(
      messages[locale]["ins.col.agent" as keyof (typeof messages)["vi"]],
      `${locale} ins.col.agent`,
    );
  }
});
