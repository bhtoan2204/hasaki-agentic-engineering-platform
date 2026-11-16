import { test } from "node:test";
import assert from "node:assert/strict";
import { newMetrics, accumulateMetrics, addUsage } from "../src/agent/metrics.ts";
import { normalizeProviderFailure, safeDiagnostics, usageSummary } from "../src/agent/telemetry.ts";
import { parseCodexLine } from "../src/agent/codex/stream.ts";
import { telemetryGroups } from "../src/api/metrics.ts";
test("missing final Claude events and partial Codex usage never invent tokens or cost", () => {
  const m = newMetrics("claude-test");
  accumulateMetrics(m, { type: "system", subtype: "init" });
  assert.equal(m.tokens, null);
  assert.equal(m.cost_usd, null);
  accumulateMetrics(m, {
    uuid: "result1",
    type: "result",
    usage: { input_tokens: 5 },
    total_cost_usd: 0,
  });
  accumulateMetrics(m, {
    uuid: "result1",
    type: "result",
    usage: { input_tokens: 5 },
    total_cost_usd: 0,
  });
  assert.deepEqual(m.tokens, { input: 5, output: null, cache_read: null, cache_creation: null });
  assert.equal(m.cost_usd, 0);
  const ev = parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":12}}');
  assert.ok("event" in ev && ev.event.type === "turn.completed");
  assert.equal(ev.event.usage?.output_tokens, null);
  assert.equal(ev.event.usage?.reasoning_output_tokens, null);
  addUsage(m, { output_tokens: -1, input_tokens: NaN });
  assert.equal((m.tokens as any)?.output, null);
});

test("provider taxonomy prioritizes codes and redacts diagnostics", () => {
  const cases = {
    insufficient_quota: "QUOTA_EXHAUSTED",
    rate_limit_error: "RATE_LIMIT",
    invalid_api_key: "AUTHENTICATION",
    service_unavailable: "PROVIDER_UNAVAILABLE",
    context_length_exceeded: "CONTEXT_LIMIT",
    timeout: "EXECUTION_TIMEOUT",
    tool_failure: "TOOL_FAILURE",
    agent_error: "AGENT_ERROR",
    canceled: "CANCELED",
    mystery: "UNKNOWN",
  };
  for (const [code, expected] of Object.entries(cases))
    assert.equal(normalizeProviderFailure({ code }), expected);
  assert.equal(
    normalizeProviderFailure({ code: "rate_limit_error", message: "quota exceeded" }),
    "RATE_LIMIT",
  );
  assert.equal(normalizeProviderFailure("arbitrary request timed out"), "EXECUTION_TIMEOUT");
  assert.equal(
    normalizeProviderFailure({
      type: "result",
      subtype: "error_during_execution",
      errors: ["You've hit your limit · resets 5am"],
    }),
    "QUOTA_EXHAUSTED",
  );
  assert.equal(
    normalizeProviderFailure("You've hit your usage limit. Upgrade to Pro or try again later."),
    "QUOTA_EXHAUSTED",
  );
  assert.equal(
    normalizeProviderFailure({ error: "authentication_failed", message: "Login required" }),
    "AUTHENTICATION",
  );
  assert.doesNotMatch(
    safeDiagnostics({ message: "api_key=supersecret Bearer abcdefghijklmnop sk-abcdefghijklmnop" }),
    /supersecret|abcdefghijklmnop/,
  );
});

test("session attribution and null coverage include Cursor and partially reported sessions", () => {
  const result = telemetryGroups([
    {
      step_id: 1,
      provider: "claude",
      start_time: "2026-01-01Z",
      provider_sessions: {
        a: { provider: "claude", model: "old", tokens: { input: 4 }, reported_cost_usd: 0.1 },
        b: { provider: "claude", model: "new", tokens: null, reported_cost_usd: null },
      },
    },
    {
      step_id: 2,
      provider: "cursor",
      start_time: "2026-01-01Z",
      input_tokens: null,
      reported_cost_usd: null,
    },
    {
      step_id: 3,
      provider: "codex",
      start_time: "2026-01-01Z",
      input_tokens: 10,
      reported_cost_usd: null,
    },
  ]);
  assert.equal(result.by_model.find((r) => r.key === "claude/old")?.input_tokens, 4);
  assert.equal(result.by_provider.find((r) => r.key === "cursor")?.input_tokens, null);
  assert.equal(
    result.by_provider.find((r) => r.key === "claude")?.coverage.input_tokens.missing,
    1,
  );
  assert.equal(usageSummary([]).reported_cost_usd, null);
});
