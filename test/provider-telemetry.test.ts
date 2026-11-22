/**
 * Provider telemetry for CodeAct evaluation: one SDK completion is not one model turn. Internal assistant turns,
 * provider tool-use events, the API-reported model (alias resolution), cache tokens and cost are taken from the
 * provider's own events, deduplicated, and left null when not reported. Deterministic SDK message fixtures; no paid
 * provider call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { accumulateMetrics, newMetrics, providerTelemetry } from "../src/agent/metrics.ts";
import { addUsage, mergeUsage } from "../src/chat/runtime.ts";

type Msg = Parameters<typeof accumulateMetrics>[1];
const init = (model: string): Msg => ({ type: "system", subtype: "init", uuid: "i", model });
const assistant = (
  uuid: string,
  id: string,
  model: string,
  content: Array<Record<string, unknown>>,
): Msg => ({
  type: "assistant",
  uuid,
  message: {
    id,
    model,
    usage: { input_tokens: 3, cache_read_input_tokens: 100 },
    content,
  } as never,
});
const result = (o: Record<string, unknown> = {}): Msg => ({
  type: "result",
  subtype: "success",
  uuid: "r",
  num_turns: 3,
  duration_ms: 4200,
  usage: {
    input_tokens: 10,
    output_tokens: 500,
    cache_read_input_tokens: 9000,
    cache_creation_input_tokens: 1200,
  },
  total_cost_usd: 0.05,
  ...o,
});

/** One completion with a native tool loop: tool_use → tool_result → tool_use → tool_result → final text. */
function nativeLoop(requested = "opus", api = "claude-opus-5-5-20261101") {
  const m = newMetrics(requested);
  const msgs: Msg[] = [
    init("claude-opus-5-5"),
    assistant("a1", "msg_1", api, [
      { type: "tool_use", name: "mcp__platform__tools_call", input: { name: "x" } },
    ]),
    { type: "user", uuid: "u1", message: { content: [{ type: "tool_result" }] } as never },
    assistant("a2", "msg_2", api, [
      { type: "tool_use", name: "mcp__platform__code_execute", input: { code: "1" } },
    ]),
    {
      type: "user",
      uuid: "u2",
      message: { content: [{ type: "tool_result", is_error: true }] } as never,
    },
    assistant("a3", "msg_3", api, [{ type: "text" }]),
    result(),
  ];
  for (const msg of msgs) accumulateMetrics(m, msg);
  return m;
}

test("native tool calls inside one SDK completion: internal turns and tool uses are counted, not 1", () => {
  const t = providerTelemetry(nativeLoop(), { completed: true });
  assert.deepEqual(t, {
    model_turns: 3,
    assistant_messages: 3,
    provider_tool_uses: 2,
    provider_tool_errors: 1,
    session_model: "claude-opus-5-5",
    api_models: ["claude-opus-5-5-20261101"],
    provider_duration_ms: 4200,
    reasoning_tokens: null,
  });
});

test("several streamed events of one assistant message count once; replayed events are ignored", () => {
  const m = newMetrics("opus");
  accumulateMetrics(m, init("claude-opus-5-5"));
  // Partial streaming: each content block arrives as its own event with the same API message id.
  accumulateMetrics(m, assistant("a1", "msg_1", "claude-opus-5-5", [{ type: "thinking" }]));
  accumulateMetrics(m, assistant("a2", "msg_1", "claude-opus-5-5", [{ type: "text" }]));
  // A replayed result (same uuid) must not double turns, tokens or cost.
  accumulateMetrics(m, result({ num_turns: 1 }));
  accumulateMetrics(m, result({ num_turns: 1 }));
  const t = providerTelemetry(m, { completed: true });
  assert.equal(t.assistant_messages, 1);
  assert.equal(t.model_turns, 1);
  assert.equal(m.cost_usd, 0.05);
  assert.deepEqual(m.tokens, { input: 10, output: 500, cache_read: 9000, cache_creation: 1200 });
});

test("cache tokens unavailable stay null; missing cost stays null", () => {
  const m = newMetrics("x");
  accumulateMetrics(m, init("claude-sonnet-5-5"));
  accumulateMetrics(m, {
    type: "result",
    uuid: "r",
    num_turns: 1,
    usage: { input_tokens: 4, output_tokens: 9 },
  });
  assert.deepEqual(m.tokens, { input: 4, output: 9, cache_read: null, cache_creation: null });
  assert.equal(m.cost_usd, null);
});

test("model alias resolution: the requested alias, the session model and the API model are kept apart", () => {
  const t = providerTelemetry(nativeLoop("opus", "claude-opus-5-5-20261101"), { completed: true });
  assert.equal(t.session_model, "claude-opus-5-5");
  assert.deepEqual(t.api_models, ["claude-opus-5-5-20261101"]);
  const unresolved = providerTelemetry(newMetrics("opus"), { completed: false });
  assert.equal(
    unresolved.session_model,
    null,
    "the requested alias is never reported as the provider's model",
  );
  assert.deepEqual(unresolved.api_models, []);
});

test("provider interruption: no result event means turns and duration are unknown, not zero", () => {
  const m = newMetrics("opus");
  accumulateMetrics(m, init("claude-opus-5-5"));
  accumulateMetrics(
    m,
    assistant("a1", "msg_1", "claude-opus-5-5", [{ type: "tool_use", name: "t", input: {} }]),
  );
  const t = providerTelemetry(m, { completed: false });
  assert.equal(t.model_turns, null);
  assert.equal(t.provider_duration_ms, null);
  assert.equal(t.assistant_messages, 1, "what was observed is still reported");
  assert.equal(m.cost_usd, null);
});

test("chat usage: SDK calls and model turns are separate; one completion without telemetry makes turns unknown", () => {
  const telemetry = providerTelemetry(nativeLoop(), { completed: true });
  const u = {
    completions: 0,
    tool_calls: 0,
    provider_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0,
    model_turns: 0,
    provider_tool_uses: 0,
  };
  addUsage(u, { provider_execution_ms: 10, cost_usd: 0.05, tokens: null, telemetry });
  assert.deepEqual([u.completions, u.model_turns, u.provider_tool_uses], [1, 3, 2]);
  addUsage(u, { provider_execution_ms: 10, cost_usd: 0.01, tokens: null });
  assert.deepEqual([u.completions, u.model_turns, u.provider_tool_uses], [2, null, null]);
  const merged = mergeUsage({}, u);
  assert.equal(merged.model_turns, null);
  assert.equal(merged.completions, 2);
});
