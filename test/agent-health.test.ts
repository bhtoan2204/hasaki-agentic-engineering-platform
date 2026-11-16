import test from "node:test";
import assert from "node:assert/strict";
import {
  isUsableAgent,
  nextHealthyProvider,
  type AgentHealth,
} from "../src/agent/health.ts";

const row = (provider: AgentHealth["provider"], patch: Partial<AgentHealth> = {}): AgentHealth => ({
  provider,
  connected: true,
  quota: "unknown",
  ...patch,
});

test("the next healthy provider skips a disconnected or exhausted agent", () => {
  const health = [
    row("claude", { connected: false, reason: "not connected" }),
    row("codex", { quota: "exhausted" }),
    row("cursor"),
    row("antigravity", { connected: false }),
  ];
  assert.equal(isUsableAgent(health[0]), false);
  assert.equal(isUsableAgent(health[2]), true);
  assert.equal(
    nextHealthyProvider(["claude", "codex", "cursor", "antigravity"], new Set(["claude"]), health),
    "cursor",
  );
});

test("no healthy provider is left when every later agent is down", () => {
  assert.equal(
    nextHealthyProvider(
      ["claude", "codex"],
      new Set(["claude"]),
      [row("claude", { connected: false }), row("codex", { connected: false })],
    ),
    null,
  );
});
