import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { knowledge } from "../src/knowledge/service.ts";
import { chat } from "../src/chat/service.ts";
import { setChatProviders } from "../src/chat/runtime.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import { latestDelivery, recordDelivery, sessionContextTokens } from "../src/context/delivery.ts";
import type { Actor } from "../src/authz/access.ts";
import type { AgentProvider } from "../src/agent/provider.ts";
import type { CompletionRunner } from "../src/agent/complete.ts";
import type { ContextPack } from "../src/context/pack.ts";
import { settleBackground } from "../src/workflow/background.ts";

const PROVIDERS: AgentProvider[] = ["claude", "cursor", "codex", "antigravity", "copilot"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
let owner: Actor;

before(async () => {
  setChatHealthProbe(async () =>
    PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })),
  );
  const u = await createUser({
    username: `tokens-${tag}`,
    password: "local-test-password",
    role: "member",
  });
  owner = { id: u.id, username: u.username, role: u.role as Actor["role"], active: u.active };
  for (const k of ["a", "b", "c"])
    await knowledge.create({
      key: `tok.${tag}.${k}`,
      category: "domain_knowledge",
      scope_type: "GLOBAL",
      title: `Refund handbook ${k}`,
      content:
        `Refund handbook ${k}. ` +
        Array.from({ length: 300 }, (_, i) => `rule ${i}: refunds keep platform_price`).join(". "),
      ownerId: owner.id,
      created_by: "test",
    });
});
after(async () => {
  delete config.agent.deltaContext;
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

const get = (k: string) =>
  "```chat-tool\n" +
  JSON.stringify({ calls: [{ tool: "knowledge.get", arguments: { key: `tok.${tag}.${k}` } }] }) +
  "\n```";
const SCRIPT = [get("a"), get("b"), get("c"), "Refunds keep platform_price."];

/** A provider with Claude-like sessions: keeps what it was sent, resumes by id, refuses an unknown id. */
function provider(o: { sessions: boolean; forget?: boolean }) {
  const sent: string[] = [];
  const known = new Set<string>();
  let i = 0;
  const r: CompletionRunner = async (prompt, opts) => {
    if (opts.session?.resume && (o.forget || !known.has(opts.session.resume)))
      throw new Error("No conversation found with session ID");
    sent.push(prompt);
    const id = opts.session?.resume ?? `s-${sent.length}`;
    if (o.sessions && opts.session?.keep) known.add(id);
    return {
      text: SCRIPT[Math.min(i++, SCRIPT.length - 1)],
      tokens: { input: Math.ceil(prompt.length / 4), output: 10 },
      session_id: o.sessions && opts.session?.keep ? id : null,
    };
  };
  setChatProviders(
    Object.fromEntries(PROVIDERS.map((p) => [p, r])) as Record<AgentProvider, CompletionRunner>,
  );
  return sent;
}

async function turn(name: string) {
  const c = await chat.create(owner, { mode: "ASK", provider: "claude" });
  const m = await chat.postMessage(owner, c.id, {
    content: "đọc 3 tài liệu refund handbook a, b, c và tóm tắt quy tắc hoàn tiền",
    client_message_id: `tok-${name}-${tag}`,
  });
  const d = await settle(c.id);
  const t = d.turns.find((x) => x.id === m.turn.id)!;
  assert.equal(t.status, "completed", JSON.stringify(t.failure));
  return {
    d,
    t,
    steps: (t.metrics as { steps: Array<{ sent: string; estimated_tokens: number }> }).steps,
  };
}
const total = (xs: string[]) => xs.reduce((n, s) => n + s.length, 0);

test("a kept provider session receives only deltas after the first step; the same turn sends far less than full resends", async () => {
  config.agent.deltaContext = false;
  const baseline = provider({ sessions: true });
  const a = await turn("baseline");
  assert.deepEqual(
    a.steps.map((s) => s.sent),
    ["full", "full", "full", "full"],
  );

  config.agent.deltaContext = true;
  const candidate = provider({ sessions: true });
  const b = await turn("delta");
  assert.deepEqual(
    b.steps.map((s) => s.sent),
    ["full", "delta", "delta", "delta"],
  );
  for (const p of candidate.slice(1)) {
    assert.doesNotMatch(
      p,
      /Platform policy|Current user message/,
      "policy, history and the request are already in the session",
    );
    assert.ok(p.length < 8000);
  }
  assert.match(candidate[3], /Refund handbook c/, "the newest result is delivered");
  assert.doesNotMatch(candidate[3], /Refund handbook a/, "earlier results are not replayed");
  const reduction = 1 - total(candidate) / total(baseline);
  assert.ok(
    reduction >= 0.3,
    `exact prompt characters sent: ${total(baseline)} → ${total(candidate)} (${Math.round(reduction * 100)}%)`,
  );
  assert.equal(b.d.messages.at(-1)!.content, "Refunds keep platform_price.");
});

test("a provider that lost the session gets the full prompt again; the turn does not fail", async () => {
  config.agent.deltaContext = true;
  const sent = provider({ sessions: true, forget: true });
  const r = await turn("forgot");
  assert.deepEqual(
    r.steps.map((s) => s.sent),
    ["full", "full", "full", "full"],
  );
  assert.match(sent[1], /Platform policy/);
});

test("stateless providers: earlier results are compacted and the raw evidence stays retrievable", async () => {
  config.agent.deltaContext = true;
  const sent = provider({ sessions: false });
  const r = await turn("stateless");
  assert.match(sent[2], /compacted: \d+ chars; full result via evidence\.get \{"seq": 1\}/);
  assert.match(sent[3], /evidence\.get \{"seq": 2\}/);
  // The raw result is still there for evidence.get.
  const raw = r.d.tool_calls.find((t) => t.tool === "knowledge.get")!;
  assert.match(JSON.stringify(raw.result), /rule 299: refunds keep platform_price/);
});

test("the delivery manifest is durable per provider session and a delta extends it", async () => {
  const p = (...ids: string[]) =>
    ({
      entries: ids.map((id) => ({ id, body: id, trust: "untrusted_evidence", required: true })),
    }) as unknown as ContextPack;
  await recordDelivery({
    provider: "claude",
    sessionId: `sess-${tag}`,
    attemptId: null,
    systemHash: "s",
    decisionsHash: "d",
    pack: p("request"),
    mode: "full",
    previous: null,
  });
  const first = await latestDelivery("claude", `sess-${tag}`);
  assert.deepEqual([first!.system_hash, Object.keys(first!.entries)], ["s", ["request"]]);
  await recordDelivery({
    provider: "claude",
    sessionId: `sess-${tag}`,
    attemptId: null,
    systemHash: "s",
    decisionsHash: "d",
    pack: p("evidence_summary"),
    mode: "delta",
    previous: first ?? null,
  });
  assert.deepEqual(Object.keys((await latestDelivery("claude", `sess-${tag}`))!.entries).sort(), [
    "evidence_summary",
    "request",
  ]);
  assert.equal(
    await latestDelivery("codex", `sess-${tag}`),
    undefined,
    "sessions are per provider",
  );
  assert.equal(await sessionContextTokens(null), null);
});
