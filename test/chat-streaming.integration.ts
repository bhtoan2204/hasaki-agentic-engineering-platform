import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { pool, q } from "../src/db/pool.ts";
import { createUser } from "../src/auth/users.ts";
import { chat } from "../src/chat/service.ts";
import { setChatProviders } from "../src/chat/runtime.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import type { Actor } from "../src/authz/access.ts";
import type { AgentProvider } from "../src/agent/provider.ts";
import type { CompletionRunner } from "../src/agent/complete.ts";
import { settleBackground } from "../src/workflow/background.ts";

const PROVIDERS: AgentProvider[] = ["claude", "cursor", "codex", "antigravity", "copilot"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const all = (r: CompletionRunner) =>
  Object.fromEntries(PROVIDERS.map((p) => [p, r])) as Record<AgentProvider, CompletionRunner>;

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

async function owner(tag: string): Promise<Actor> {
  const u = await createUser({
    username: `chat-stream-${tag}-${Date.now()}`,
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

const events = (turnId: number) =>
  q<{ kind: string; data: Record<string, unknown> }>(
    pool,
    "SELECT kind, data FROM chat_events WHERE turn_id = $1 ORDER BY id",
    [turnId],
  );

test("streaming: provider text arrives as coalesced deltas, reasoning and activity form the trace, the final answer supersedes the draft", async () => {
  const a = await owner("ok");
  const c = await chat.create(a, { mode: "ASK", provider: "claude" });
  const seen: Array<{ kind: string; data: Record<string, unknown> }> = [];
  setChatProviders(
    all(async (_p, opts) => {
      opts.onStream?.({ type: "started" });
      opts.onStream?.({ type: "reasoning", delta: "Checking the question. " });
      opts.onStream?.({ type: "activity", label: "tool: search" });
      let text = "";
      for (const w of ["Câu ", "trả ", "lời ", "**từng** ", "phần."]) {
        opts.onStream?.({ type: "text", text: (text += w) });
        await sleep(120);
      }
      // A turn whose events are read mid-flight sees the draft and deltas, not only phases.
      seen.push(
        ...(await q<{ kind: string; data: Record<string, unknown> }>(
          pool,
          "SELECT kind, data FROM chat_events WHERE conversation_id = $1 ORDER BY id",
          [c.id],
        )),
      );
      return { text, model: "m", tokens: null, cost_usd: null };
    }),
  );
  const msg = await chat.postMessage(a, c.id, {
    content: "hỏi",
    client_message_id: "stream-ok-msg",
  });
  const d = await settle(a, c.id);

  const deltas = seen.filter((e) => e.kind === "response.delta");
  assert.ok(
    deltas.length >= 2 && deltas.length < 5,
    `coalesced, not one row per update (${deltas.length})`,
  );
  let rebuilt = "";
  for (const e of deltas) rebuilt = rebuilt.slice(0, Number(e.data.offset)) + String(e.data.text);
  assert.ok("Câu trả lời **từng** phần.".startsWith(rebuilt) && rebuilt.length > 0);
  assert.ok(
    seen.some((e) => e.kind === "reasoning.delta" && e.data.text === "Checking the question. "),
  );
  assert.ok(seen.some((e) => e.kind === "provider.activity" && e.data.label === "tool: search"));

  assert.equal(
    d.messages.find((m) => m.role === "assistant")?.content,
    "Câu trả lời **từng** phần.",
  );
  const turn = d.turns.find((t) => t.id === msg.turn.id)!;
  assert.equal(turn.status, "completed");
  assert.equal(turn.draft, "", "the stored answer replaces the draft");
  assert.deepEqual(
    turn.trace.map((i) => i.k),
    ["reasoning", "activity"],
  );
  const after = await events(msg.turn.id);
  assert.equal(
    after.filter((e) => ["response.delta", "reasoning.delta", "provider.activity"].includes(e.kind))
      .length,
    0,
    "live deltas are dropped once the answer is stored",
  );
  assert.ok(after.some((e) => e.kind === "turn.completed"));
});

test("streaming: a tool-call request is never streamed as answer text; tool steps join the trace", async () => {
  const a = await owner("tools");
  const c = await chat.create(a, { mode: "INVESTIGATE", provider: "claude" });
  const deltas: string[] = [];
  let calls = 0;
  setChatProviders(
    all(async (_p, opts) => {
      calls++;
      const text =
        calls === 1
          ? 'Let me look.\n```chat-tool\n{"calls":[{"tool":"repo.list","arguments":{}}]}\n```'
          : "Done: no repositories.";
      for (let i = 1; i <= text.length; i += 7)
        opts.onStream?.({ type: "text", text: text.slice(0, i) });
      opts.onStream?.({ type: "text", text });
      await sleep(250);
      deltas.push(
        ...(
          await q<{ data: { text: string } }>(
            pool,
            "SELECT data FROM chat_events WHERE conversation_id = $1 AND kind = 'response.delta'",
            [c.id],
          )
        ).map((r) => r.data.text),
      );
      return { text, model: "m", tokens: null, cost_usd: null };
    }),
  );
  const msg = await chat.postMessage(a, c.id, {
    content: "liệt kê repo @repo:none",
    client_message_id: "stream-tools-msg",
  });
  const d = await settle(a, c.id);
  const turn = d.turns.find((t) => t.id === msg.turn.id)!;
  assert.equal(turn.status, "completed", JSON.stringify(turn.failure));
  assert.ok(!deltas.some((t) => /chat-tool|"calls"|`/.test(t)), deltas.join("|"));
  assert.ok(turn.trace.some((i) => i.k === "tool" && i.tool === "repo.list" && i.status === "ok"));
});

test("streaming: stop keeps the streamed partial answer, marked by the canceled turn", async () => {
  const a = await owner("stop");
  const c = await chat.create(a, { mode: "ASK", provider: "claude" });
  let streamed!: () => void;
  const ready = new Promise<void>((r) => (streamed = r));
  setChatProviders(
    all(async (_p, opts) => {
      opts.onStream?.({ type: "text", text: "Phần đầu của câu trả lời" });
      streamed();
      await new Promise((_, reject) =>
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
      return { text: "never", tokens: null };
    }),
  );
  const msg = await chat.postMessage(a, c.id, {
    content: "dài",
    client_message_id: "stream-stop-msg",
  });
  await ready;
  await sleep(1300);
  assert.equal(
    (await chat.get(a, c.id)).active_turn?.draft,
    "Phần đầu của câu trả lời",
    "checkpoint is visible to a reconnecting client",
  );
  await chat.cancelTurn(a, msg.turn.id);
  await settleBackground();
  const d = await settle(a, c.id);
  const turn = d.turns.find((t) => t.id === msg.turn.id)!;
  assert.equal(turn.status, "canceled");
  assert.equal(
    d.messages.find((m) => m.turn_id === msg.turn.id && m.role === "assistant")?.content,
    "Phần đầu của câu trả lời",
  );
  assert.ok((await events(msg.turn.id)).some((e) => e.kind === "response.partial"));
});

test("streaming: a provider failing mid-stream falls back in AUTO; the failed attempt's draft is not the answer", async () => {
  const a = await owner("fail");
  const c = await chat.create(a, { mode: "ASK", provider: "auto" });
  const used: string[] = [];
  const failing: CompletionRunner = async (_p, opts) => {
    opts.onStream?.({ type: "text", text: "half" });
    throw new Error("rate limit exceeded (429)");
  };
  setChatProviders(
    Object.fromEntries(
      PROVIDERS.map((p) => [
        p,
        async (prompt: string, opts: Parameters<CompletionRunner>[1]) => {
          used.push(p);
          return used.length === 1
            ? failing(prompt, opts)
            : { text: `answer from ${p}`, tokens: null };
        },
      ]),
    ) as Record<AgentProvider, CompletionRunner>,
  );
  const msg = await chat.postMessage(a, c.id, {
    content: "hi",
    client_message_id: "stream-fail-msg",
  });
  const d = await settle(a, c.id);
  assert.equal(d.turns.find((t) => t.id === msg.turn.id)!.status, "completed");
  assert.equal(used.length, 2);
  assert.equal(
    d.messages.find((m) => m.role === "assistant")?.content,
    `answer from ${used[1]}`,
    "the failed attempt's draft is not the answer",
  );
  const kinds = (await events(msg.turn.id)).map((e) => e.kind);
  assert.ok(kinds.includes("provider.attempt_failed") && kinds.includes("provider.fallback"));
});

test("streaming: a failure without fallback keeps the streamed partial answer next to the error", async () => {
  const a = await owner("manual");
  const c = await chat.create(a, {
    mode: "ASK",
    provider: "codex",
    provider_strategy: "manual",
    fallback_enabled: false,
  });
  setChatProviders(
    all(async (_p, opts) => {
      opts.onStream?.({ type: "text", text: "Kết quả một phần" });
      throw new Error("rate limit exceeded (429)");
    }),
  );
  const msg = await chat.postMessage(a, c.id, {
    content: "hi",
    client_message_id: "stream-manual-msg",
  });
  const d = await settle(a, c.id);
  const turn = d.turns.find((t) => t.id === msg.turn.id)!;
  assert.equal(turn.status, "failed");
  assert.equal(turn.failure?.code, "RATE_LIMITED");
  assert.equal(
    d.messages.find((m) => m.turn_id === msg.turn.id && m.role === "assistant")?.content,
    "Kết quả một phần",
  );
});
