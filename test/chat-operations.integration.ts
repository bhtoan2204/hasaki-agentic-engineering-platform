import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { pool, q } from "../src/db/pool.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { execution } from "../src/auth/execution.ts";
import { chat } from "../src/chat/service.ts";
import { setChatProviders } from "../src/chat/runtime.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import { proposeOperation } from "../src/chat/operations.ts";
import { registerBuiltinTools } from "../src/agent/toolRegistry.ts";
import { setKafkaCookie } from "../src/integrations/kafka.ts";
import type { Actor } from "../src/authz/access.ts";
import type { AgentProvider } from "../src/agent/provider.ts";
import type { CompletionRunner } from "../src/agent/complete.ts";
import { settleBackground } from "../src/workflow/background.ts";

const PROVIDERS: AgentProvider[] = ["claude", "cursor", "codex", "antigravity", "copilot"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const published: Array<{ url: string; body: Record<string, unknown> }> = [];
const realFetch = globalThis.fetch;
const savedKafka = { ...config.kafka };

before(() => {
  registerBuiltinTools();
  Object.assign(config.kafka, {
    cluster: "qc-main",
    publishAllow: [{ cluster: "qc-main", topics: ["warranty.create"] }],
  });
  // Kafka UI (QC) stand-in: only its URLs are intercepted; nothing leaves the process.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(config.kafka.baseUrl)) return realFetch(input, init);
    const path = new URL(url).pathname;
    if (init?.method === "POST" && /\/topics\/[^/]+\/messages$/.test(path)) {
      published.push({ url: path, body: JSON.parse(String(init.body)) });
      return new Response("", { status: 200 });
    }
    if (path === "/api/clusters")
      return Response.json([{ name: "qc-main", status: "ONLINE", brokerCount: 1, topicCount: 1 }]);
    if (path === "/api/authorization") return Response.json({ userInfo: { username: "qc-user" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  setChatHealthProbe(async () =>
    PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })),
  );
});
after(async () => {
  globalThis.fetch = realFetch;
  Object.assign(config.kafka, savedKafka);
  setChatProviders(undefined);
  setChatHealthProbe(undefined);
  await settleBackground();
  await pool.end();
});

async function user(tag: string): Promise<Actor> {
  const u = await createUser({
    username: `chat-op-${tag}-${Date.now()}`,
    password: "local-test-password",
    role: "member",
  });
  return { id: u.id, username: u.username, role: u.role as Actor["role"], active: u.active };
}
async function settle(a: Actor, id: number) {
  for (let i = 0; i < 200; i++) {
    const d = await chat.get(a, id);
    if (!d.active_turn && d.turns.every((t) => !["queued", "running"].includes(t.status))) return d;
    await sleep(25);
  }
  throw new Error("turn did not finish");
}
const scripted = (replies: string[], prompts: string[] = []) => {
  let i = 0;
  const r: CompletionRunner = async (prompt) => {
    prompts.push(prompt);
    return { text: replies[Math.min(i++, replies.length - 1)], tokens: null };
  };
  return Object.fromEntries(PROVIDERS.map((p) => [p, r])) as Record<
    AgentProvider,
    CompletionRunner
  >;
};
const toolCall = (name: string, args: unknown) =>
  "```chat-tool\n" +
  JSON.stringify({ calls: [{ tool: "tools.call", arguments: { name, arguments: args } }] }) +
  "\n```";
const audits = (id: number) =>
  q<{ action: string }>(
    pool,
    "SELECT action FROM audit_log WHERE resource_type = 'chat_operation' AND resource_id = $1 ORDER BY id",
    [String(id)],
  );

let owner: Actor;
let other: Actor;
before(async () => {
  owner = await user("owner");
  other = await user("other");
  await execution.run({ userId: owner.id, kind: "user" }, () =>
    setKafkaCookie("SESSION=qc-session"),
  );
});

test("QC operation: chat proposes, nothing is published until the owner confirms; one publish, platform-written outcome, audit", async () => {
  const c = await chat.create(owner, { mode: "ASK", provider: "claude" });
  setChatProviders(
    scripted([
      toolCall("kafka.publish", {
        topic: "warranty.create",
        value: { order_code: "WR-1001", sku: "A1" },
      }),
      "Đã chuẩn bị thao tác, vui lòng xác nhận.",
    ]),
  );
  await chat.postMessage(owner, c.id, {
    content: "tạo đơn bảo hành WR-1001 bằng event kafka trên QC",
    client_message_id: "op-propose-1",
  });
  let d = await settle(owner, c.id);
  assert.equal(d.operations.length, 1);
  const op = d.operations[0];
  assert.deepEqual(
    [op.status, op.target],
    ["pending", { cluster: "qc-main", topic: "warranty.create" }],
  );
  assert.equal(published.length, 0, "proposing never publishes");

  await assert.rejects(
    chat.decideOperation(other, op.id, "confirm"),
    /not found/,
    "another user cannot confirm",
  );
  const [first, second] = await Promise.all([
    chat.decideOperation(owner, op.id, "confirm"),
    chat.decideOperation(owner, op.id, "confirm"),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.ok(statuses.includes("succeeded"), statuses.join());
  assert.equal(published.length, 1, "a double confirm publishes once");
  const body = published[0].body;
  assert.equal(body.value, JSON.stringify({ order_code: "WR-1001", sku: "A1" }));
  assert.equal((body.headers as Record<string, string>)["x-idempotency-key"].length, 64);
  assert.equal(
    (await chat.decideOperation(owner, op.id, "confirm")).status,
    "succeeded",
    "a later click returns the state",
  );
  assert.equal(published.length, 1);

  d = await chat.get(owner, c.id);
  const note = d.messages.find((m) => m.role === "assistant" && m.turn_id == null);
  assert.match(note!.content, /published\. Downstream processing is NOT verified/);
  assert.deepEqual(
    (await audits(op.id)).map((a) => a.action),
    ["chat.operation.propose", "chat.operation.execute", "chat.operation.succeeded"],
  );
});

test("duplicate prevention: the same event is never proposed or published again, across conversations", async () => {
  const c = await chat.create(owner, { mode: "ASK", provider: "claude" });
  const binding = { userId: owner.id, conversationId: c.id, turnId: null as unknown as number };
  const args = { topic: "warranty.create", value: { sku: "A1", order_code: "WR-1001" } };
  const again = await proposeOperation(binding, "kafka.publish", args);
  assert.equal(again.status, "duplicate");
  const fresh = await proposeOperation(binding, "kafka.publish", {
    ...args,
    value: { order_code: "WR-1002" },
  });
  const same = await proposeOperation(binding, "kafka.publish", {
    ...args,
    value: { order_code: "WR-1002" },
  });
  assert.equal(fresh.operation_id, same.operation_id, "an identical pending proposal is reused");
  await chat.decideOperation(owner, fresh.operation_id!, "reject");
  assert.equal(published.length, 1, "rejecting publishes nothing");
});

test("production and non-allowlisted mutations are refused before a confirmation exists; an expired proposal never runs", async () => {
  const c = await chat.create(owner, { mode: "ASK", provider: "claude" });
  const binding = { userId: owner.id, conversationId: c.id, turnId: null as unknown as number };
  await assert.rejects(
    proposeOperation(binding, "kafka.publish", { topic: "warranty.prod.create", value: "{}" }),
    /production/,
  );
  await assert.rejects(
    proposeOperation(binding, "kafka.publish", {
      topic: "warranty.create",
      cluster: "prod",
      value: "{}",
    }),
    /production/,
  );
  await assert.rejects(
    proposeOperation(binding, "kafka.publish", { topic: "payments.refund", value: "{}" }),
    /allowlist/,
  );
  await assert.rejects(
    proposeOperation(binding, "kafka.publish", { topic: "warranty.create", value: 42 }),
    /invalid arguments/,
  );
  assert.equal(
    (await q(pool, "SELECT 1 FROM chat_operations WHERE conversation_id = $1", [c.id])).length,
    0,
  );

  // Through the chat loop the refusal reaches the model as a tool error, not a pending operation.
  setChatProviders(
    scripted([
      toolCall("kafka.publish", { topic: "orders.prod", value: "{}" }),
      "Không thể publish lên production.",
    ]),
  );
  await chat.postMessage(owner, c.id, {
    content: "bắn event kafka lên topic orders.prod",
    client_message_id: "op-prod-1",
  });
  const d = await settle(owner, c.id);
  assert.equal(d.operations.length, 0);
  assert.ok(d.tool_calls.some((t) => t.tool === "tools.call" && t.status !== "ok"));

  const op = await proposeOperation(binding, "kafka.publish", {
    topic: "warranty.create",
    value: { order_code: "WR-EXP" },
  });
  await q(
    pool,
    "UPDATE chat_operations SET expires_at = now() - interval '1 second' WHERE id = $1",
    [op.operation_id],
  );
  assert.equal((await chat.decideOperation(owner, op.operation_id!, "confirm")).status, "expired");
  assert.equal(published.length, 1);

  // An allowlist removed after the proposal is re-checked at confirmation.
  const later = await proposeOperation(binding, "kafka.publish", {
    topic: "warranty.create",
    value: { order_code: "WR-LATE" },
  });
  const saved = config.kafka.publishAllow;
  config.kafka.publishAllow = [];
  try {
    assert.equal(
      (await chat.decideOperation(owner, later.operation_id!, "confirm")).status,
      "failed",
    );
  } finally {
    config.kafka.publishAllow = saved;
  }
  assert.equal(published.length, 1);
});

test("memory: learned from the user's own words after the turn, deduplicated, owner-private, recalled only for its owner; rules become proposals", async () => {
  await settleBackground();
  const prompts: string[] = [];
  const mine = await chat.create(owner, { mode: "ASK", provider: "claude" });
  setChatProviders(scripted(["ok"], prompts));
  await chat.postMessage(owner, mine.id, {
    content: "Nhớ là luôn trả lời ngắn gọn kèm link Jira.",
    client_message_id: "mem-owner-1",
  });
  await settle(owner, mine.id);
  await settleBackground();
  await chat.postMessage(owner, mine.id, {
    content: "nhớ là   luôn trả lời NGẮN gọn kèm link Jira",
    client_message_id: "mem-owner-2",
  });
  await settle(owner, mine.id);
  await settleBackground();
  const memories = await chat.memories(owner);
  const pref = memories.filter(
    (m) => (m.metadata as { memory?: { kind?: string } }).memory?.kind === "preference",
  );
  assert.equal(pref.length, 1, "deduplicated");
  assert.equal((pref[0].metadata as { memory: { count: number } }).memory.count, 2);
  assert.ok(
    prompts.at(-1)!.includes("luôn trả lời ngắn gọn"),
    "recalled into the owner's next prompt",
  );

  const procedure = memories.find(
    (m) => (m.metadata as { memory?: { kind?: string } }).memory?.kind === "procedure",
  );
  assert.ok(procedure, "the confirmed publish taught a procedure");
  assert.match(procedure!.content, /payload fields: order_code, sku/);
  assert.doesNotMatch(procedure!.content, /WR-1001/, "values are never stored");

  const theirs = await chat.create(other, { mode: "ASK", provider: "claude" });
  const otherPrompts: string[] = [];
  setChatProviders(scripted(["ok"], otherPrompts));
  await chat.postMessage(other, theirs.id, {
    content: "Xin chào, trả lời giúp mình.",
    client_message_id: "mem-other-1",
  });
  await settle(other, theirs.id);
  assert.equal((await chat.memories(other)).length, 0);
  assert.ok(
    !otherPrompts.join("\n").includes("link Jira"),
    "another user's memory never reaches this prompt",
  );

  setChatProviders(scripted(["ok"]));
  await chat.postMessage(owner, mine.id, {
    content: "Rule: warranty orders need the original order_code.",
    client_message_id: "mem-rule-1",
  });
  await settle(owner, mine.id);
  await settleBackground();
  const proposals = await q<{ status: string; owner_id: number | null }>(
    pool,
    "SELECT status, owner_id FROM knowledge_proposals WHERE source_kind = 'chat' AND proposed->>'content' = $1",
    ["warranty orders need the original order_code."],
  );
  assert.deepEqual(
    proposals,
    [{ status: "pending", owner_id: null }],
    "shared rules go through review, not memory",
  );

  await chat.postMessage(owner, mine.id, {
    content: "Remember my api key is sk_live_51Habcdefghijklmnop.",
    client_message_id: "mem-secret-1",
  });
  await settle(owner, mine.id);
  await settleBackground();
  assert.ok(
    !(await chat.memories(owner)).some((m) => /api key/i.test(m.content)),
    "credentials are never learned",
  );
});
