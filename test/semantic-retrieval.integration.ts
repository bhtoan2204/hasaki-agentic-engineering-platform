import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pool, one } from "../src/db/pool.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { ensureTestOwner } from "../src/auth/testOwner.ts";
import { knowledge } from "../src/knowledge/service.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, getRun } from "../src/workflow/engine.ts";
import { buildStepInput, resolveContext } from "../src/workflow/context.ts";
import { workItems } from "../src/workitems/service.ts";
import { knowledgeForTurn, searchKnowledge } from "../src/chat/knowledge.ts";
import { recallMemories } from "../src/chat/memory.ts";
import { settleBackground } from "../src/workflow/background.ts";
import type { DisclosureEntry } from "../src/context/plan.ts";

const tag = Date.now().toString(36);
const k = (name: string) => `test.sem.${tag}.${name}`;
const hash = "b".repeat(64);

/** Stub Go service: answers with `hits` (source id → similarity), optionally a stale version or a delay. */
let hits = new Map<number, number>();
let staleIds = new Set<number>();
let delayMs = 0;
let searches = 0;
const ids: Record<string, number> = {};
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", async () => {
    searches++;
    const body = JSON.parse(raw || "{}");
    const rows = await Promise.all(
      [...hits].map(async ([id, similarity]) => {
        const r = await one<{ key: string; current_version: number }>(
          pool,
          "SELECT key, current_version FROM knowledge_items WHERE id = $1",
          [id],
        );
        return {
          source_id: id,
          key: r!.key,
          source_kind: r!.key.startsWith("memory.chat.") ? "chat_memory" : "knowledge",
          version: staleIds.has(id) ? r!.current_version + 1 : r!.current_version,
          content_hash: hash,
          similarity,
          chunk: 0,
        };
      }),
    );
    const send = (r: ServerResponse) => {
      if (r.destroyed) return;
      r.writeHead(200, { "Content-Type": "application/json" });
      r.end(JSON.stringify({ model: "stub", results: rows, took_ms: 1 }));
    };
    assert.ok(Array.isArray(body.source_ids));
    if (delayMs) setTimeout(() => send(res), delayMs);
    else send(res);
  });
});

let owner = 0;
let other = 0;
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  owner = await ensureTestOwner();
  other = (
    await createUser({
      username: `sem-other-${tag}`,
      password: "local-test-password",
      role: "member",
    })
  ).id;
  const doc = async (name: string, x: Partial<Parameters<typeof knowledge.create>[0]>) => {
    const it = await knowledge.create({
      key: k(name),
      category: "domain_knowledge",
      scope_type: "GLOBAL",
      title: name,
      content: name,
      created_by: "test",
      metadata: { load: "on_demand", description: name },
      ...x,
    });
    ids[name] = Number(it.id);
  };
  await doc("refund", {
    title: "Refund window procedure",
    content: "Refund requests are accepted within 30 days.",
    metadata: { load: "on_demand", description: "refund window for orders" },
  });
  await doc("returns", {
    title: "Product return handling",
    content: "Customers may send goods back to the warehouse for credit.",
    metadata: { load: "on_demand", description: "trả hàng, đổi trả" },
  });
  await doc("hidden", {
    title: "Private refund escalation",
    content: "Private escalation contacts for refunds.",
    ownerId: other,
  });
  await doc("mem-own", {
    key: `memory.chat.${tag}.own`,
    category: "task_memory",
    title: "Preference: concise",
    content: "Answer about goods coming back to stock in bullet points.",
    metadata: { load: "on_demand", memory: { source: "chat", kind: "correction", trust: "human" } },
    ownerId: owner,
  });
  await doc("mem-other", {
    key: `memory.chat.${tag}.other`,
    category: "task_memory",
    title: "Other user's memory",
    content: "Other user note about goods coming back.",
    metadata: { load: "on_demand", memory: { source: "chat", kind: "correction", trust: "human" } },
    ownerId: other,
  });
  await definitions.create({
    key: `sem-${tag}`,
    spec: { name: "Semantic", steps: [{ key: "answer", type: "agent" }] },
  });
});
beforeEach(() => {
  Object.assign(config.retrieval.semantic, {
    enabled: false,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    timeoutMs: 800,
  });
  process.env.RETRIEVAL_INTERNAL_TOKEN = "integration-token";
  config.retrieval.internalToken = "integration-token";
  hits = new Map();
  staleIds = new Set();
  delayMs = 0;
  searches = 0;
});
after(async () => {
  config.retrieval.semantic.enabled = false;
  delete process.env.RETRIEVAL_INTERNAL_TOKEN;
  config.retrieval.internalToken = "";
  server.close();
  await settleBackground();
  await pool.end();
});

async function context(title: string) {
  const wi = await workItems.createManual({ title, ownerId: owner });
  const created = await startRun({
    definitionKey: `sem-${tag}`,
    workItemId: wi.id,
    repositories: [],
    title,
    profile: "STANDARD",
    ownerId: owner,
    start: false,
  });
  const run = await getRun(created.id);
  const step = run.steps.find((s) => s.key === "answer")!;
  return resolveContext(
    pool,
    run as never,
    step as never,
    await buildStepInput(pool, run as never, step as never),
  );
}
const plannedOf = (ctx: Awaited<ReturnType<typeof context>>, name: string) =>
  ctx.disclosure.find((d) => d.key === k(name));

test("workflow context: flag off keeps the lexical plan and never calls the service", async () => {
  hits = new Map([[ids.returns, 0.9]]);
  const ctx = await context("Refund policy for returned goods");
  assert.equal(searches, 0);
  assert.ok(ctx.disclosure.every((d) => d.fused === undefined && d.semantic_rank === undefined));
});

test("workflow context: flag on fuses semantic rank, ignores items the owner cannot see and stale hits", async () => {
  const lexical = await context("Refund policy for returned goods");
  config.retrieval.semantic.enabled = true;
  hits = new Map([
    [ids.hidden, 0.99],
    [ids.returns, 0.9],
    [ids.refund, 0.8],
  ]);
  staleIds = new Set([ids.refund]);
  const ctx = await context("Refund policy for returned goods");
  assert.ok(searches > 0);
  assert.ok(!ctx.knowledge.some((x) => x.key === k("hidden")));
  assert.ok(!ctx.disclosure.some((d) => d.key === k("hidden")));
  assert.equal(plannedOf(ctx, "returns")!.semantic_rank, 1);
  assert.match(plannedOf(ctx, "returns")!.why, /semantic similarity rank 1/);
  assert.equal(plannedOf(ctx, "refund")!.semantic_rank, undefined, "stale version is dropped");
  assert.deepEqual(
    ctx.disclosure.map((d) => d.key).sort(),
    lexical.disclosure.map((d) => d.key).sort(),
    "semantic ranking never adds or removes items",
  );
  const snap = await one<{ content: { prompt_plan: { knowledge: DisclosureEntry[] } } }>(
    pool,
    "SELECT content FROM context_snapshots WHERE id = $1",
    [ctx.snapshot_id],
  );
  const recorded = snap!.content.prompt_plan.knowledge.find((d) => d.key === k("returns"));
  assert.equal(recorded!.semantic_rank, 1);
  assert.equal(typeof recorded!.fused, "number");
});

test("workflow context: a timed-out service leaves the lexical plan and the step context resolves", async () => {
  const lexical = await context("Refund policy for returned goods");
  config.retrieval.semantic.enabled = true;
  config.retrieval.semantic.timeoutMs = 50;
  delayMs = 500;
  hits = new Map([[ids.returns, 0.9]]);
  const ctx = await context("Refund policy for returned goods");
  assert.deepEqual(
    ctx.disclosure.map((d) => [d.key, d.disclosure, d.why]),
    lexical.disclosure.map((d) => [d.key, d.disclosure, d.why]),
  );
});

const scope = (text: string) => ({ ownerId: owner, repositories: [], text });

test("chat knowledge: flag off is lexical only; flag on adds semantic matches from the visible set only", async () => {
  hits = new Map([
    [ids.returns, 0.9],
    [ids.hidden, 0.99],
  ]);
  const query = "merchandise reversal";
  const offSearch = await searchKnowledge(scope(query), query);
  const offTurn = await knowledgeForTurn(scope(query));
  assert.equal(searches, 0);
  assert.ok(!offSearch.some((h) => h.key === k("returns")));
  assert.ok(!offTurn.some((t) => t.item.key === k("returns")));

  config.retrieval.semantic.enabled = true;
  const onSearch = await searchKnowledge(scope(query), query);
  const returns = onSearch.find((h) => h.key === k("returns"));
  assert.ok(returns, "semantic paraphrase found");
  assert.equal(returns.semantic_similarity, 0.9);
  assert.ok(!onSearch.some((h) => h.key === k("hidden")));
  const onTurn = await knowledgeForTurn(scope(query));
  assert.ok(onTurn.some((t) => t.item.key === k("returns")));
  assert.ok(!onTurn.some((t) => t.item.key === k("hidden")));

  delayMs = 500;
  config.retrieval.semantic.timeoutMs = 50;
  assert.deepEqual(await searchKnowledge(scope(query), query), offSearch);
});

test("chat memory: recall stays within the owner's memories, with and without the service", async () => {
  hits = new Map([
    [ids["mem-own"], 0.8],
    [ids["mem-other"], 0.95],
  ]);
  const off = await recallMemories(owner, "restock question");
  assert.ok(!off.some((m) => m.key === `memory.chat.${tag}.own`));
  config.retrieval.semantic.enabled = true;
  const on = await recallMemories(owner, "restock question");
  assert.ok(on.some((m) => m.key === `memory.chat.${tag}.own`));
  assert.ok(!on.some((m) => m.key === `memory.chat.${tag}.other`));
});
