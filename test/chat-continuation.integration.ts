import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { pool, q } from "../src/db/pool.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { execution } from "../src/auth/execution.ts";
import { chat } from "../src/chat/service.ts";
import { setChatProviders } from "../src/chat/runtime.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import { registerBuiltinTools } from "../src/agent/toolRegistry.ts";
import { clearKafkaCookie, setKafkaCookie } from "../src/integrations/kafka.ts";
import type { Actor } from "../src/authz/access.ts";
import type { Continuation } from "../src/chat/types.ts";
import type { AgentProvider } from "../src/agent/provider.ts";
import type { CompletionRunner } from "../src/agent/complete.ts";
import { settleBackground } from "../src/workflow/background.ts";

const PROVIDERS: AgentProvider[] = ["claude", "cursor", "codex", "antigravity", "copilot"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch;
const savedKafka = { ...config.kafka };
const published: unknown[] = [];
let owner: Actor;

before(async () => {
  registerBuiltinTools();
  Object.assign(config.kafka, {
    cluster: "qc-main",
    publishAllow: [{ cluster: "qc-main", topics: ["warranty.create"] }],
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(config.kafka.baseUrl)) return realFetch(input, init);
    const path = new URL(url).pathname;
    if (init?.method === "POST")
      return (published.push(JSON.parse(String(init.body))), new Response("", { status: 200 }));
    if (path === "/api/clusters") return Response.json([{ name: "qc-main", status: "ONLINE" }]);
    if (path === "/api/authorization") return Response.json({ userInfo: { username: "qc" } });
    if (path.endsWith("/topics"))
      return Response.json({
        topics: [{ name: "warranty.create", partitionCount: 3 }],
        pageCount: 1,
      });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  setChatHealthProbe(async () =>
    PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })),
  );
  const u = await createUser({
    username: `chat-cont-${Date.now()}`,
    password: "local-test-password",
    role: "member",
  });
  owner = { id: u.id, username: u.username, role: u.role as Actor["role"], active: u.active };
});
after(async () => {
  globalThis.fetch = realFetch;
  Object.assign(config.kafka, savedKafka);
  setChatProviders(undefined);
  setChatHealthProbe(undefined);
  await settleBackground();
  await pool.end();
});

async function settle(id: number) {
  for (let i = 0; i < 200; i++) {
    const d = await chat.get(owner, id);
    if (!d.active_turn && d.turns.every((t) => !["queued", "running"].includes(t.status))) return d;
    await sleep(25);
  }
  throw new Error("turn did not finish");
}
/** Scripted provider: each reply sees the prompt; records prompts for assertions. */
function script(replies: Array<string | ((prompt: string) => string)>, prompts: string[] = []) {
  let i = 0;
  const r: CompletionRunner = async (prompt) => {
    prompts.push(prompt);
    const next = replies[Math.min(i++, replies.length - 1)];
    return { text: typeof next === "function" ? next(prompt) : next, tokens: null };
  };
  setChatProviders(
    Object.fromEntries(PROVIDERS.map((p) => [p, r])) as Record<AgentProvider, CompletionRunner>,
  );
  return prompts;
}
const call = (name: string, args: unknown) =>
  "```chat-tool\n" +
  JSON.stringify({ calls: [{ tool: "tools.call", arguments: { name, arguments: args } }] }) +
  "\n```";
const say = async (conversationId: number, content: string, id: string) => {
  const m = await chat.postMessage(owner, conversationId, { content, client_message_id: id });
  const d = await settle(conversationId);
  return { d, turn: d.turns.find((t) => t.id === m.turn.id)! };
};
const continuationOf = async (id: number) =>
  (
    await q<{ continuation: Continuation | null }>(
      pool,
      "SELECT continuation FROM chat_conversations WHERE id = $1",
      [id],
    )
  )[0].continuation!;

test("routing receives the preceding turn, not the current one", async () => {
  const c = await chat.create(owner, { mode: "AUTO", provider: "claude" });
  script(["Có 2 repository."]);
  const first = await say(
    c.id,
    "repository oms-api có những service nào trong source code?",
    "cont-prev-1",
  );
  assert.equal(first.turn.route, "REPOSITORY_QUERY");
  const second = await say(c.id, "còn oms-background?", "cont-prev-2");
  assert.equal(second.turn.route, "REPOSITORY_QUERY", JSON.stringify(second.turn.routing));
  assert.match(
    String((second.turn.routing as { reason?: string }).reason),
    /follow-up reuses prior route/,
  );
});

test("reconnect and resume: a blocked request continues after 'kết nối rồi, làm lại đi', with refreshed sessions and no repeated instructions", async () => {
  await execution.run({ userId: owner.id, kind: "user" }, () => clearKafkaCookie());
  const c = await chat.create(owner, { mode: "AUTO", provider: "claude" });
  script([
    call("kafka.list_topics", { query: "warranty" }),
    "Kafka UI chưa được kết nối nên mình chưa đọc được topic.",
  ]);
  const blocked = await say(
    c.id,
    "kiểm tra topic kafka warranty trên QC giúp mình",
    "cont-resume-1",
  );
  assert.equal(blocked.d.tool_calls.at(-1)!.status !== "ok", true);
  const cont = await continuationOf(c.id);
  assert.equal(cont.status, "blocked");
  assert.equal(cont.blockers[0].tool, "kafka.list_topics");

  // The user reconnects Kafka UI elsewhere (Integrations page); the chat only hears "connected now, redo".
  await execution.run({ userId: owner.id, kind: "user" }, () =>
    setKafkaCookie("SESSION=qc-session"),
  );
  const prompts = script([
    call("kafka.list_topics", { query: "warranty" }),
    "Topic warranty.create có 3 partition.",
  ]);
  const resumed = await say(c.id, "kết nối rồi, làm lại đi", "cont-resume-2");
  assert.equal(resumed.turn.status, "completed", JSON.stringify(resumed.turn.failure));
  assert.equal((resumed.turn.routing as { continued?: boolean }).continued, true);
  assert.equal(resumed.turn.route, "PLATFORM_QUERY");
  assert.match(prompts[0], /Unfinished request .*kiểm tra topic kafka warranty/);
  assert.match(
    prompts[0],
    /kafka\.list_topics: .*NOW AVAILABLE/,
    "the blocker was re-checked after refreshing sessions",
  );
  assert.equal(resumed.d.tool_calls.at(-1)!.status, "ok");
  assert.equal(await continuationOf(c.id), null, "finished: the request is closed");
});

test("dynamic escalation: a direct answer that needs platform data asks for tools within the same turn", async () => {
  const c = await chat.create(owner, { mode: "AUTO", provider: "claude" });
  const prompts = script([
    "```chat-escalate```",
    "```chat-tool\n" + JSON.stringify({ calls: [{ tool: "repo.list", arguments: {} }] }) + "\n```",
    "Bạn chưa có repository nào.",
  ]);
  const r = await say(c.id, "mình có gì?", "cont-escalate-1");
  assert.equal(r.turn.route, "DIRECT_ANSWER");
  assert.match(prompts[0], /reply with exactly ```chat-escalate```/);
  // Claude gets the tools as native tool calls (the prompt says so); other providers get the chat-tool catalog.
  assert.match(
    prompts[1],
    /```chat-tool|available as native tool calls/,
    "the tools are offered after the escalation",
  );
  assert.doesNotMatch(prompts[0], /available as native tool calls/, "not before it");
  assert.equal((r.turn.metrics as { escalated?: boolean }).escalated, true);
  assert.deepEqual(
    r.d.tool_calls.filter((t) => t.turn_id === r.turn.id).map((t) => [t.tool, t.status]),
    [["repo.list", "ok"]],
  );
  assert.doesNotMatch(r.d.messages.at(-1)!.content, /chat-escalate/);
});

test("topic change: an unrelated request does not resume the unfinished one, which stays open", async () => {
  await execution.run({ userId: owner.id, kind: "user" }, () => clearKafkaCookie());
  const c = await chat.create(owner, { mode: "AUTO", provider: "claude" });
  script([call("kafka.list_topics", { query: "warranty" }), "Chưa kết nối Kafka."]);
  await say(c.id, "kiểm tra topic kafka warranty trên QC giúp mình", "cont-topic-1");
  const prompts = script(["Repository oms-api dùng Go."]);
  const other = await say(
    c.id,
    "giải thích kiến trúc của repository oms-api và các service chính trong source code",
    "cont-topic-2",
  );
  assert.notEqual((other.turn.routing as { continued?: boolean }).continued, true);
  assert.doesNotMatch(prompts[0], /Unfinished request/);
  assert.equal(
    (await continuationOf(c.id)).status,
    "blocked",
    "the earlier request is still resumable",
  );
});

test("resume never duplicates a side effect: re-proposing the pending publish reuses it, and it runs once", async () => {
  await execution.run({ userId: owner.id, kind: "user" }, () =>
    setKafkaCookie("SESSION=qc-session"),
  );
  const c = await chat.create(owner, { mode: "AUTO", provider: "claude" });
  const publish = call("kafka.publish", {
    topic: "warranty.create",
    value: { order_code: "WR-77" },
  });
  script([publish, "Đã tạo thao tác, chờ bạn xác nhận."]);
  await say(c.id, "bắn event kafka tạo đơn bảo hành WR-77 trên QC", "cont-dup-1");
  const first = await chat.get(owner, c.id);
  assert.equal(first.operations.length, 1);
  assert.equal(
    (await continuationOf(c.id)).blockers.some((b: { reason: string }) =>
      /is pending/.test(b.reason),
    ),
    true,
  );

  const prompts = script([publish, "Thao tác vẫn đang chờ bạn xác nhận."]);
  const again = await say(c.id, "thử lại đi", "cont-dup-2");
  assert.equal((again.turn.routing as { continued?: boolean }).continued, true);
  assert.match(prompts[0], new RegExp(`#${first.operations[0].id} kafka\\.publish pending`));
  const after = await chat.get(owner, c.id);
  assert.equal(after.operations.length, 1, "the same pending operation, not a second one");
  await chat.decideOperation(owner, first.operations[0].id, "confirm");
  await chat.decideOperation(owner, first.operations[0].id, "confirm");
  assert.equal(published.length, 1);
});
