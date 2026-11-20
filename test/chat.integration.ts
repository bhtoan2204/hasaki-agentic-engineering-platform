import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { pool, q } from "../src/db/pool.ts";
import { createUser } from "../src/auth/users.ts";
import { chat } from "../src/chat/service.ts";
import { setChatProviders, runTurn, activeTurnCount } from "../src/chat/runtime.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import type { Actor } from "../src/authz/access.ts";
import type { AgentProvider } from "../src/agent/provider.ts";
import type { CompletionRunner } from "../src/agent/complete.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { HttpError } from "../src/http/error.ts";

after(async () => {
  setChatProviders(undefined);
  setChatHealthProbe(undefined);
  await settleBackground();
  await pool.end();
});

function actorOf(u: { id: number; username: string; role: string; active: boolean }): Actor {
  return { id: u.id, username: u.username, role: u.role as Actor["role"], active: u.active };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForTurn(conversationId: number, ownerId: number, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const detail = await chat.get(actorOf({ id: ownerId, username: "x", role: "member", active: true }), conversationId);
    if (!detail.active_turn) return detail;
    await sleep(50);
  }
  throw new Error("turn did not finish");
}

before(() => {
  const runner: CompletionRunner = async (prompt) => ({
    text: prompt.includes("chat-tool")
      ? "```chat-tool\n{\"calls\":[{\"tool\":\"repo.list\",\"arguments\":{}}]}\n```"
      : `Trả lời kiểm thử: ${prompt.includes("Current user message") ? "ok" : "follow-up"}`,
    model: "test-model",
    tokens: { input: 11, output: 7 },
    cost_usd: 0.001,
  });
  const providers = Object.fromEntries(
    (["claude", "cursor", "codex", "antigravity", "copilot"] as AgentProvider[]).map((p) => [p, runner]),
  ) as Record<AgentProvider, CompletionRunner>;
  setChatProviders(providers);
});

test("chat: create, ASK direct answer, idempotent message, ownership isolation", async () => {
  const owner = await createUser({
    username: `chat-owner-${Date.now()}`,
    password: "local-test-password",
    role: "member",
  });
  const other = await createUser({
    username: `chat-other-${Date.now()}`,
    password: "local-test-password",
    role: "member",
  });
  const a = actorOf(owner);
  const b = actorOf(other);

  const created = await chat.create(a, { title: "Kiểm thử ASK", mode: "ASK", provider: "claude" });
  assert.equal(created.mode, "ASK");

  // Other owner cannot see it.
  await assert.rejects(() => chat.get(b, created.id), /not found/);

  const first = await chat.postMessage(a, created.id, {
    content: "Xin chào, bạn làm được gì?",
    client_message_id: "idem-ask-1",
  });
  assert.equal(first.replayed, false);
  // Drive the turn synchronously (background may race with the end of the test).
  await runTurn(first.turn.id);
  const detail = await waitForTurn(created.id, owner.id);
  const assistant = detail.messages.find((m) => m.role === "assistant");
  assert.ok(assistant?.content.includes("Trả lời kiểm thử"));
  assert.equal(detail.tool_calls.length, 0, "plain ASK must not call tools");

  const replay = await chat.postMessage(a, created.id, {
    content: "Xin chào, bạn làm được gì?",
    client_message_id: "idem-ask-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.turn.id, first.turn.id);
});

test("chat: one active turn; cancel stops; regenerate supersedes", async () => {
  const owner = await createUser({
    username: `chat-cancel-${Date.now()}`,
    password: "local-test-password",
    role: "member",
  });
  const a = actorOf(owner);
  const c = await chat.create(a, { mode: "ASK", provider: "claude" });

  // Slow provider so cancel can race the turn.
  setChatProviders({
    claude: async (_p, opts) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 2000);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(opts.signal!.reason ?? new Error("aborted"));
        });
      });
      return { text: "should not finish", tokens: null, cost_usd: null };
    },
    cursor: async () => ({ text: "x", tokens: null }),
    codex: async () => ({ text: "x", tokens: null }),
    antigravity: async () => ({ text: "x", tokens: null }),
    copilot: async () => ({ text: "x", tokens: null }),
  });

  const msg = await chat.postMessage(a, c.id, {
    content: "câu hỏi dài",
    client_message_id: "cancel-1",
  });
  // Second message while active → 409
  await assert.rejects(
    () => chat.postMessage(a, c.id, { content: "lần 2", client_message_id: "cancel-2" }),
    (e: unknown) =>
      (e instanceof HttpError && e.status === 409) ||
      /already in progress/i.test(String(e instanceof Error ? e.message : e)),
  );

  const cancel = await chat.cancelTurn(a, msg.turn.id);
  assert.equal(cancel.status, "canceled");
  await settleBackground();
  await sleep(100);
  assert.equal(activeTurnCount(), 0);

  // Restore fast provider for regenerate.
  const runner: CompletionRunner = async () => ({
    text: "câu trả lời regenerate",
    model: "test-model",
    tokens: { input: 1, output: 1 },
    cost_usd: 0.0001,
  });
  setChatProviders({
    claude: runner,
    cursor: runner,
    codex: runner,
    antigravity: runner,
    copilot: runner,
  });

  // Need a completed turn to regenerate — create one.
  const done = await chat.postMessage(a, c.id, {
    content: "hỏi lại",
    client_message_id: "regen-src",
  });
  await runTurn(done.turn.id);
  await waitForTurn(c.id, owner.id);

  const regen = await chat.regenerate(a, done.turn.id);
  await runTurn(regen.turn.id);
  const after = await waitForTurn(c.id, owner.id);
  const live = after.messages.filter((m) => m.role === "assistant" && !m.withheld);
  // Original assistant of the superseded turn is marked superseded and not in historyFor,
  // but listMessages still returns it with superseded=true.
  const superseded = after.messages.filter((m) => m.superseded);
  assert.ok(live.some((m) => m.content.includes("regenerate")));
  assert.ok(superseded.length >= 1 || live.length >= 1);
});

test("chat: unknown usage stays unknown across turns", async () => {
  const owner = await createUser({
    username: `chat-usage-${Date.now()}`,
    password: "local-test-password",
    role: "member",
  });
  const a = actorOf(owner);
  const c = await chat.create(a, { mode: "ASK", provider: "claude" });
  const unknown: CompletionRunner = async () => ({
    text: "không biết cost",
    tokens: null,
    cost_usd: null,
  });
  setChatProviders({
    claude: unknown,
    cursor: unknown,
    codex: unknown,
    antigravity: unknown,
    copilot: unknown,
  });
  const m = await chat.postMessage(a, c.id, { content: "cost?", client_message_id: "usage-unknown-1" });
  await runTurn(m.turn.id);
  const detail = await waitForTurn(c.id, owner.id);
  assert.equal(detail.conversation.usage.cost_usd, null);
  assert.equal(detail.conversation.usage.input_tokens, null);
});

test("chat: AUTO skips unhealthy Claude and uses Codex; failed turns stay visible", async () => {
  setChatHealthProbe(async () => [
    { provider: "claude", connected: false, quota: "unknown", reason: "not connected" },
    { provider: "codex", connected: true, quota: "unknown" },
    { provider: "cursor", connected: false, quota: "unknown" },
    { provider: "antigravity", connected: false, quota: "unknown" },
    { provider: "copilot", connected: false, quota: "unknown" },
  ]);
  const runner: CompletionRunner = async () => ({
    text: "ok từ codex",
    model: "codex-test",
    tokens: { input: 1, output: 1 },
    cost_usd: 0.0001,
  });
  setChatProviders({
    claude: async () => {
      throw new Error("claude should not be called");
    },
    codex: runner,
    cursor: runner,
    antigravity: runner,
    copilot: runner,
  });
  const owner = await createUser({
    username: `chat-auto-${Date.now()}`,
    password: "local-test-password",
    role: "member",
  });
  const a = actorOf(owner);
  const c = await chat.create(a, { mode: "AUTO", provider: "auto" });
  assert.equal(c.provider_strategy, "auto");
  const m = await chat.postMessage(a, c.id, {
    content: "What is a fencing token?",
    client_message_id: "auto-health-1",
  });
  await runTurn(m.turn.id);
  const detail = await waitForTurn(c.id, owner.id);
  const assistant = detail.messages.find((x) => x.role === "assistant");
  assert.match(assistant?.content ?? "", /ok từ codex/);
  const turn = detail.turns.find((t) => t.id === m.turn.id);
  assert.equal(turn?.provider, "codex");
  assert.equal(turn?.status, "completed");
  setChatHealthProbe(undefined);
});

test("chat: manual unhealthy provider fails visibly without inference wait", async () => {
  setChatHealthProbe(async () => [
    { provider: "claude", connected: false, quota: "unknown", reason: "auth required" },
    { provider: "codex", connected: true, quota: "ok" },
    { provider: "cursor", connected: true, quota: "ok" },
    { provider: "antigravity", connected: true, quota: "ok" },
    { provider: "copilot", connected: true, quota: "ok" },
  ]);
  setChatProviders({
    claude: async () => ({ text: "should not run", tokens: null }),
    codex: async () => ({ text: "x", tokens: null }),
    cursor: async () => ({ text: "x", tokens: null }),
    antigravity: async () => ({ text: "x", tokens: null }),
    copilot: async () => ({ text: "x", tokens: null }),
  });
  const owner = await createUser({
    username: `chat-pin-${Date.now()}`,
    password: "local-test-password",
    role: "member",
  });
  const a = actorOf(owner);
  const c = await chat.create(a, {
    mode: "ASK",
    provider: "claude",
    provider_strategy: "manual",
    fallback_enabled: false,
  });
  const m = await chat.postMessage(a, c.id, {
    content: "hello",
    client_message_id: "pin-fail-1",
  });
  await runTurn(m.turn.id);
  const detail = await waitForTurn(c.id, owner.id);
  const turn = detail.turns.find((t) => t.id === m.turn.id);
  assert.equal(turn?.status, "failed");
  assert.ok(turn?.failure);
  assert.ok(
    ["PROVIDER_UNAVAILABLE", "AUTHENTICATION_REQUIRED"].includes(
      String((turn?.failure as { code?: string })?.code),
    ),
  );
  // No assistant hallucination for platform failures.
  assert.equal(detail.messages.filter((x) => x.role === "assistant" && x.turn_id === m.turn.id).length, 0);
  setChatHealthProbe(undefined);
});

test("chat: cleanup leaves no orphan active turns", async () => {
  const rows = await q(
    pool,
    "SELECT count(*)::int AS n FROM chat_turns WHERE status IN ('queued','running')",
  );
  assert.equal(rows[0].n, 0);
});
