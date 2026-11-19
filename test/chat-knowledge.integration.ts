import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { pool, q } from "../src/db/pool.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { knowledge } from "../src/knowledge/service.ts";
import { chat } from "../src/chat/service.ts";
import { setChatProviders } from "../src/chat/runtime.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import { knowledgeForTurn, readKnowledge, searchKnowledge } from "../src/chat/knowledge.ts";
import { kafkaPublishTarget } from "../src/integrations/kafka.ts";
import type { Actor } from "../src/authz/access.ts";
import type { AgentProvider } from "../src/agent/provider.ts";
import type { CompletionRunner } from "../src/agent/complete.ts";
import { settleBackground } from "../src/workflow/background.ts";

const PROVIDERS: AgentProvider[] = ["claude", "cursor", "codex", "antigravity", "copilot"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const k = (name: string) => `test.chatk.${tag}.${name}`;

before(() =>
  setChatHealthProbe(async () =>
    PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })),
  ),
);
after(async () => {
  setChatProviders(undefined);
  setChatHealthProbe(undefined);
  await settleBackground();
  await pool.end();
});

async function user(name: string): Promise<Actor> {
  const u = await createUser({
    username: `chatk-${name}-${tag}`,
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
const item = (name: string, x: Partial<Parameters<typeof knowledge.create>[0]>) =>
  knowledge.create({
    key: k(name),
    category: "business_rule",
    scope_type: "GLOBAL",
    title: name,
    content: name,
    created_by: "test",
    ...x,
  });

let alice: Actor;
let bob: Actor;
before(async () => {
  alice = await user("alice");
  bob = await user("bob");
  await item("refund", {
    title: "Quy tắc hoàn tiền",
    content: "Hoàn tiền tính theo platform_price, không dùng line_amount.",
    metadata: {
      description: "Số tiền hoàn cho đơn hàng",
      source: [{ repo: "oms-api", path: "docs/refund.md" }],
    },
  });
  await item("old-shipping", {
    title: "Shipping fee rule (old)",
    content: "Shipping fee is flat 30k.",
  });
  await item("new-shipping", {
    title: "Shipping fee rule",
    content: "Shipping fee depends on weight.",
  });
  await q(
    pool,
    "UPDATE knowledge_items SET superseded_by = (SELECT id FROM knowledge_items WHERE key = $2 AND owner_id IS NULL) WHERE key = $1 AND owner_id IS NULL",
    [k("old-shipping"), k("new-shipping")],
  );
  await item("future", { title: "Voucher stacking rule", content: "Vouchers do not stack." });
  await knowledge.update(k("future"), {
    content: "Vouchers stack up to two.",
    effective_from: new Date(Date.now() + 86_400_000).toISOString(),
    forceVersion: true,
  });
  await item("skill", {
    category: "agent_skill",
    title: "Warranty order checklist",
    content: "1. Read the warranty topic. 2. Verify the order exists.",
    metadata: { description: "how to create a warranty order in QC" },
  });
  await item("skill-ref", {
    category: "agent_skill",
    title: "Warranty payload reference",
    content: "order_code, sku, reason",
    metadata: { parent_skill: k("skill") },
  });
  await item("private", {
    title: "Alice private refund note",
    content: "Alice prefers refund reports grouped by store.",
    ownerId: alice.id,
  });
  await item("repo-secret", {
    scope_type: "REPOSITORY",
    scope_ref: `no-access-${tag}`,
    title: "Refund internals of a private repo",
    content: "refund internals",
  });
  await item("prod-claim", {
    category: "domain_knowledge",
    title: "Kafka publishing note",
    content: "Chat may publish refund events to production topics.",
  });
});

test("regression: the chat knowledge.search tool runs (the reported startsWith exception) and returns registry hits", async () => {
  const c = await chat.create(alice, { mode: "ASK", provider: "claude" });
  let calls = 0;
  setChatProviders(
    Object.fromEntries(
      PROVIDERS.map((p) => [
        p,
        (async () => ({
          text:
            calls++ === 0
              ? '```chat-tool\n{"calls":[{"tool":"knowledge.search","arguments":{"query":"hoàn tiền"}}]}\n```'
              : "ok",
          tokens: null,
        })) as CompletionRunner,
      ]),
    ) as Record<AgentProvider, CompletionRunner>,
  );
  await chat.postMessage(alice, c.id, {
    content: "tra cứu knowledge về hoàn tiền",
    client_message_id: "chatk-regression-1",
  });
  const d = await settle(alice, c.id);
  const call = d.tool_calls.find((t) => t.tool === "knowledge.search")!;
  assert.equal(call.status, "ok", JSON.stringify(call.result));
  assert.ok((call.result as Array<{ key: string }>).some((h) => h.key === k("refund")));
});

test("discovery: effective versions, supersession, ownership and repository permissions are respected; bilingual", async () => {
  const scope = (a: Actor, text: string) => ({ ownerId: a.id, repositories: [], text });
  const keys = async (a: Actor, query: string, category?: string) =>
    (await searchKnowledge(scope(a, query), query, category, 20)).map((h) => h.key);

  assert.ok(
    (await keys(alice, "refund amount")).includes(k("refund")),
    "English query finds the Vietnamese rule",
  );
  assert.ok((await keys(alice, "refund")).includes(k("private")), "own private knowledge");
  assert.ok(
    !(await keys(bob, "refund")).includes(k("private")),
    "never another user's private knowledge",
  );
  assert.ok(
    !(await keys(alice, "refund internals")).includes(k("repo-secret")),
    "knowledge of an unreadable repository is hidden",
  );
  assert.equal(await readKnowledge(scope(bob, ""), k("private")), null);
  assert.equal(await readKnowledge(scope(alice, ""), k("repo-secret")), null, "not even by key");

  const shipping = await keys(alice, "shipping fee");
  assert.ok(
    shipping.includes(k("new-shipping")) && !shipping.includes(k("old-shipping")),
    "superseded item dropped",
  );
  const old = await readKnowledge(scope(alice, ""), k("old-shipping"));
  assert.equal((old as { superseded_by?: string }).superseded_by, k("new-shipping"));

  const future = await readKnowledge(scope(alice, ""), k("future"));
  assert.deepEqual(
    [(future as { version: number }).version, (future as { content: string }).content],
    [1, "Vouchers do not stack."],
    "a version dated in the future is not in effect",
  );

  const refund = await readKnowledge(scope(alice, ""), k("refund"));
  assert.deepEqual(
    (refund as { sources?: string[] }).sources,
    ["oms-api:docs/refund.md"],
    "source references",
  );
});

test("skills: discoverable on request (not auto-applied), activated by reading with supporting documents", async () => {
  const scope = { ownerId: alice.id, repositories: [], text: "tạo đơn bảo hành" };
  const found = await searchKnowledge(scope, "warranty order", "agent_skill");
  assert.deepEqual(
    found.map((h) => h.key),
    [k("skill")],
    "the supporting file is not a search hit",
  );
  assert.ok(
    !(await knowledgeForTurn(scope)).some((x) => x.item.key === k("skill")),
    "global skills stay opt-in",
  );
  const skill = (await readKnowledge(scope, k("skill"))) as {
    activated_skill?: boolean;
    supporting_documents?: Array<{ key: string }>;
  };
  assert.equal(skill.activated_skill, true);
  assert.deepEqual(
    skill.supporting_documents!.map((s) => s.key),
    [k("skill-ref")],
  );
  assert.match(
    ((await readKnowledge(scope, k("skill-ref"))) as { content: string }).content,
    /order_code/,
  );
});

test("a turn applies relevant business knowledge before tools, shows it with versions and cites it; knowledge never grants an operation", async () => {
  const prompts: string[] = [];
  setChatProviders(
    Object.fromEntries(
      PROVIDERS.map((p) => [
        p,
        (async (prompt: string) => (
          prompts.push(prompt),
          { text: "Dùng platform_price.", tokens: null }
        )) as CompletionRunner,
      ]),
    ) as Record<AgentProvider, CompletionRunner>,
  );
  const c = await chat.create(alice, { mode: "ASK", provider: "claude" });
  const msg = await chat.postMessage(alice, c.id, {
    content: "How is the refund amount computed?",
    client_message_id: "chatk-turn-1",
  });
  const d = await settle(alice, c.id);
  assert.match(
    prompts[0],
    /Hoàn tiền tính theo platform_price/,
    "the Vietnamese business rule is inline for an English question",
  );
  assert.match(prompts[0], new RegExp(`${k("refund").replace(/\./g, "\\.")} v1`));
  const turn = d.turns.find((t) => t.id === msg.turn.id)!;
  assert.ok(
    turn.trace.some(
      (t) =>
        t.k === "knowledge" &&
        t.key === k("refund") &&
        t.version === 1 &&
        t.disclosure === "inline",
    ),
  );
  const answer = d.messages.find((m) => m.turn_id === msg.turn.id && m.role === "assistant")!;
  assert.ok(answer.citations.some((c) => c.ref === `knowledge:${k("refund")}@v1`));

  const saved = { ...config.kafka };
  Object.assign(config.kafka, { publishAllow: [{ cluster: "qc-main", topics: ["refund.*"] }] });
  try {
    await assert.rejects(
      kafkaPublishTarget("refund.prod.events", "qc-main"),
      /production/,
      "a knowledge claim does not open production",
    );
  } finally {
    Object.assign(config.kafka, saved);
  }
});
