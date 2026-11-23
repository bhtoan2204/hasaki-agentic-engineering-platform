import { test } from "node:test";
import assert from "node:assert/strict";
import { stallGuard, visibleAnswer } from "../src/chat/streaming.ts";
import { codexProgress, type CodexItem } from "../src/agent/codex/stream.ts";
import { mayFallback } from "../src/chat/admission.ts";
import { applyChatEvent, seedFromTurn, type LiveTurn } from "../web/src/pages/chatStream.ts";

test("visible answer: tool-call blocks and their prefixes never stream as text; plain answers pass through", () => {
  assert.equal(visibleAnswer('Looking.\n```chat-tool\n{"calls":[]}', true), "Looking.");
  assert.equal(visibleAnswer("Looking.\n```chat-to", true), "Looking.\n");
  assert.equal(visibleAnswer('{"cal', true), "");
  assert.equal(visibleAnswer('  {"calls": [{"tool":"x"}]}', true), "");
  assert.equal(visibleAnswer("```go\nx := 1\n```", true), "```go\nx := 1\n");
  assert.equal(visibleAnswer("```chat-tool", false), "```chat-tool");
  assert.equal(visibleAnswer("Plain answer", true), "Plain answer");
});

test("stall guard: no first response or a long silence aborts with a fallback-eligible failure; activity keeps it alive", async () => {
  const first = stallGuard(30, 1000);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(first.signal.aborted, true);
  assert.equal(first.failure?.code, "FIRST_RESPONSE_TIMEOUT");
  assert.equal(mayFallback(first.failure!, "auto", true), true);
  assert.equal(
    mayFallback(first.failure!, "manual", false),
    false,
    "a manual choice without fallback is respected",
  );

  const idle = stallGuard(1000, 40);
  idle.touch();
  await new Promise((r) => setTimeout(r, 25));
  idle.touch();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(idle.signal.aborted, false, "activity resets the idle timer");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(idle.failure?.code, "IDLE_TIMEOUT");

  const done = stallGuard(20, 20);
  done.dispose();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(done.signal.aborted, false);
});

test("codex progress: real reasoning items, commands and messages map to stream events; nothing is invented", () => {
  const item = (type: string, extra: Partial<CodexItem> = {}): CodexItem => ({
    id: "1",
    type,
    raw: {},
    ...extra,
  });
  assert.deepEqual(codexProgress({ type: "thread.started", thread_id: "t", raw: {} }), {
    type: "started",
  });
  assert.deepEqual(
    codexProgress({ type: "item.completed", item: item("reasoning", { text: "Plan" }), raw: {} }),
    { type: "reasoning", delta: "Plan\n\n" },
  );
  assert.deepEqual(
    codexProgress({
      type: "item.started",
      item: item("command_execution", { command: "rg  foo\n src" }),
      raw: {},
    }),
    { type: "activity", label: "command: rg foo src" },
  );
  assert.deepEqual(
    codexProgress({ type: "item.completed", item: item("agent_message", { text: "Hi" }), raw: {} }),
    { type: "text", text: "Hi" },
  );
  assert.equal(codexProgress({ type: "item.started", item: item("agent_message"), raw: {} }), null);
  assert.equal(codexProgress({ type: "turn.completed", usage: null, raw: {} }), null);
});

test("client stream state: ordered deltas, revisions, new calls, tool steps and missed events recovered from the checkpoint", () => {
  const ev = (kind: string, data: Record<string, unknown>) => ({ kind, turn_id: 7, data });
  const delta = (offset: number, text: string, step = 0) =>
    ev("response.delta", { attempt: 0, step, offset, text });
  let l: LiveTurn | null = null;
  l = applyChatEvent(l, ev("reasoning.delta", { text: "a" }));
  l = applyChatEvent(l, ev("reasoning.delta", { text: "b" }));
  assert.deepEqual([l!.trace, l!.status], [[{ k: "reasoning", text: "ab" }], "thinking"]);
  l = applyChatEvent(l, delta(0, "Hello"));
  l = applyChatEvent(l, delta(5, " world"));
  assert.deepEqual([l!.text, l!.status], ["Hello world", "generating"]);
  l = applyChatEvent(l, delta(6, "there"));
  assert.equal(l!.text, "Hello there", "a provider revision replaces from its offset");
  l = applyChatEvent(l, ev("tool.started", { tool_call_id: 3, seq: 2, tool: "code.read_file" }));
  assert.deepEqual([l!.text, l!.held, l!.status], ["Hello there", true, "reading"]);
  l = applyChatEvent(l, ev("tool.completed", { tool_call_id: 3, status: "ok", duration_ms: 12 }));
  assert.deepEqual(l!.trace.at(-1), {
    k: "tool",
    id: 3,
    seq: 2,
    tool: "code.read_file",
    status: "ok",
    ms: 12,
  });
  l = applyChatEvent(l, delta(0, "New", 1));
  assert.equal(l!.text, "New");
  assert.equal(applyChatEvent(l, ev("turn.completed", {})), l, "unrelated events keep the state");

  // Joined mid-turn: deltas past the end wait until the checkpoint catches up.
  let j: LiveTurn | null = applyChatEvent(null, delta(10, " end"));
  j = applyChatEvent(j, delta(14, "!"));
  assert.equal(j!.text, "");
  j = seedFromTurn(j, { id: 7, draft: "0123456789", trace: [] });
  assert.equal(j.text, "0123456789 end!");
  assert.equal(
    seedFromTurn(j, { id: 7, draft: "0123" }).text,
    "0123456789 end!",
    "an older checkpoint never rewinds",
  );
});

test("client stream state: an assistant message after a tool call that shares a prefix with the earlier one still streams", () => {
  const ev = (kind: string, data: Record<string, unknown>) => ({ kind, turn_id: 8, data });
  const delta = (offset: number, text: string) =>
    ev("response.delta", { attempt: 0, step: 0, offset, text });
  let l: LiveTurn | null = null;
  l = applyChatEvent(l, delta(0, "Mình sẽ kiểm tra"));
  l = applyChatEvent(l, ev("tool.started", { tool_call_id: 1, seq: 1, tool: "code.search" }));
  assert.equal(l!.held, true);
  // The server diffs against what it already sent: the second message shares "Mình " with the first.
  l = applyChatEvent(l, delta(5, "đã thấy kết quả"));
  assert.equal(l!.text, "Mình đã thấy kết quả");
  assert.deepEqual([l!.held, l!.pending.length, l!.status], [false, 0, "generating"]);
});
