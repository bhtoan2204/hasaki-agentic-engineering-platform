/**
 * Title generation never competes with the answers people wait for: the fallback title is stored with the first
 * message, the generated one waits for that first turn, runs one at a time and yields to running turns. Manual renames
 * win, explicit regeneration is not deferred, and concurrent admissions share one readiness probe.
 */
import { test, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pool, q, one } from "../src/db/pool.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { chat } from "../src/chat/service.ts";
import { setChatProviders } from "../src/chat/runtime.ts";
import { setChatHealthProbe, setChatHealthProber } from "../src/chat/admission.ts";
import {
  generateConversationTitle,
  setChatTitleComplete,
  titleBacklog,
  TITLE_SCHEDULING,
} from "../src/chat/title.ts";
import {
  loadAgentConfiguration,
  saveProviderConfiguration,
} from "../src/agent/configurationStore.ts";
import { runningTurns } from "../src/chat/turnActivity.ts";
import type { Actor } from "../src/authz/access.ts";
import type { AgentProvider } from "../src/agent/provider.ts";
import type { CompletionRunner } from "../src/agent/complete.ts";
import { settleBackground } from "../src/workflow/background.ts";

const PROVIDERS: AgentProvider[] = ["claude", "cursor", "codex", "antigravity", "copilot"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const all = (r: CompletionRunner) =>
  Object.fromEntries(PROVIDERS.map((p) => [p, r])) as Record<AgentProvider, CompletionRunner>;
let probes = 0;
const healthy = async () => {
  probes++;
  await sleep(30); // a probe takes time: concurrent admissions overlap it
  return PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const }));
};
/** A provider streaming `n` updates; `gate`, when set, holds it mid-answer. */
let gate: Promise<void> | null = null;
let failFor: string | null = null;
const streaming =
  (n = 8): CompletionRunner =>
  async (prompt, opts) => {
    if (failFor && prompt.includes(failFor)) throw new Error("provider not connected");
    let text = "";
    for (let i = 0; i < n; i++) {
      if (i === n >> 1 && gate) await gate;
      opts.onStream?.({ type: "text", text: (text += `t${i} `) });
      await sleep(15);
    }
    return { text: text + "done", model: "stub", tokens: null };
  };

before(() => {
  setChatHealthProbe(undefined);
  setChatHealthProber(healthy);
  setChatProviders(all(streaming()));
});
beforeEach(async () => {
  await settleBackground();
  gate = null;
  failFor = null;
  setChatProviders(all(streaming()));
});
after(async () => {
  setChatProviders(undefined);
  setChatHealthProber(undefined);
  setChatTitleComplete(undefined);
  await settleBackground();
  await pool.end();
});

async function owner(tag: string): Promise<Actor> {
  const u = await createUser({
    username: `chat-title-${tag}-${Date.now()}`,
    password: "local-test-password",
    role: "member",
  });
  return { id: u.id, username: u.username, role: u.role as Actor["role"], active: u.active };
}

const firstTurn = (conversationId: number) =>
  q<{ id: number; status: string; finished_at: Date | null }>(
    pool,
    "SELECT id, status, finished_at FROM chat_turns WHERE conversation_id = $1 ORDER BY id LIMIT 1",
    [conversationId],
  ).then((r) => r[0]);
const conversationRow = (id: number) =>
  q<{ title: string; title_source: string }>(
    pool,
    "SELECT title, title_source FROM chat_conversations WHERE id = $1",
    [id],
  ).then((r) => r[0]);

test("eight new conversations: fallback titles at once; generated titles after the turns, bounded, one shared probe", async () => {
  const a = await owner("eight");
  const titles: Array<{ seed: string; start: number; end: number; busyTurns: number }> = [];
  let running = 0,
    maxRunning = 0;
  setChatTitleComplete(async (prompt) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    const start = Date.now();
    const busyTurns = runningTurns();
    await sleep(40);
    running--;
    const seed = /request (\d+)/.exec(prompt)?.[1] ?? "?";
    titles.push({ seed, start, end: Date.now(), busyTurns });
    return `Generated title ${seed}`;
  });
  probes = 0;
  const cs = await Promise.all(
    Array.from({ length: 8 }, () => chat.create(a, { mode: "ASK", provider: "claude" })),
  );
  await Promise.all(
    cs.map((c, i) =>
      chat.postMessage(a, c.id, {
        content: `request ${i} about the order service`,
        client_message_id: `title-eight-${c.id}`,
      }),
    ),
  );
  // The deterministic fallback is visible immediately, before any turn has answered.
  for (const [i, c] of cs.entries()) {
    const row = await conversationRow(c.id);
    assert.equal(row.title_source, "fallback");
    assert.equal(
      row.title,
      `request ${i} about the order service`.split(" ").slice(0, 6).join(" "),
    );
  }
  assert.equal(titles.length, 0, "no title before the first turns answered");
  await settleBackground();

  const finished = await Promise.all(cs.map((c) => firstTurn(c.id)));
  assert.ok(finished.every((t) => t.status === "completed"));
  const lastAnswer = Math.max(...finished.map((t) => t.finished_at!.getTime()));
  assert.equal(titles.length, 8, "every conversation is titled");
  assert.ok(
    maxRunning >= 1 && maxRunning <= TITLE_SCHEDULING.concurrency,
    `titles run at most ${TITLE_SCHEDULING.concurrency} at a time: ${maxRunning}`,
  );
  assert.ok(
    titles.every((t) => t.busyTurns === 0),
    "no title ran while a turn was running",
  );
  assert.ok(
    titles.every((t) => t.start >= lastAnswer - 5),
    "every title started after the last first turn answered",
  );
  for (const [i, c] of cs.entries()) {
    assert.deepEqual(await conversationRow(c.id), {
      title: `Generated title ${i}`,
      title_source: "generated",
    });
    const updates = await q<{ data: { title_source?: string } }>(
      pool,
      "SELECT data FROM chat_events WHERE conversation_id = $1 AND kind = 'conversation.updated'",
      [c.id],
    );
    assert.ok(
      updates.some((u) => u.data.title_source === "generated"),
      "a title update event",
    );
  }
  assert.equal(
    probes,
    1,
    `eight concurrent admissions share one readiness probe (titles reuse the answering provider): ${probes}`,
  );
  assert.equal(titleBacklog(), 0);
});

test("a manual rename during title generation wins; no generated-title event follows", async () => {
  const a = await owner("rename");
  let release!: () => void;
  const started = new Promise<void>((s) =>
    setChatTitleComplete(async () => {
      s();
      await new Promise<void>((r) => (release = r));
      return "Model title";
    }),
  );
  const c = await chat.create(a, { mode: "ASK", provider: "claude" });
  await chat.postMessage(a, c.id, {
    content: "rename me while titling",
    client_message_id: `title-rename-${c.id}`,
  });
  await started;
  await chat.update(a, c.id, { title: "My own title" });
  release();
  await settleBackground();
  assert.deepEqual(await conversationRow(c.id), { title: "My own title", title_source: "manual" });
  const generated = await q(
    pool,
    "SELECT 1 FROM chat_events WHERE conversation_id = $1 AND kind = 'conversation.updated' AND data->>'title_source' = 'generated'",
    [c.id],
  );
  assert.equal(generated.length, 0);
  await assert.rejects(chat.regenerateTitle(a, c.id), /renamed manually/);
});

test("explicit regeneration is not deferred behind a running turn and is not run twice", async () => {
  const a = await owner("force");
  let calls = 0;
  setChatTitleComplete(async () => {
    calls++;
    return `Forced ${calls}`;
  });
  let open!: () => void;
  gate = new Promise<void>((r) => (open = r));
  const c = await chat.create(a, { mode: "ASK", provider: "claude" });
  await chat.postMessage(a, c.id, {
    content: "a long running question",
    client_message_id: `title-force-${c.id}`,
  });
  await sleep(150);
  assert.equal((await firstTurn(c.id)).status, "running");
  await chat.regenerateTitle(a, c.id);
  for (let i = 0; i < 100 && calls === 0; i++) await sleep(20);
  assert.equal(calls, 1, "the requested title ran while the turn was still running");
  assert.equal((await firstTurn(c.id)).status, "running");
  open();
  await settleBackground();
  assert.equal(calls, 1, "the scheduled title and the explicit one were one job");
  assert.deepEqual(await conversationRow(c.id), { title: "Forced 1", title_source: "generated" });
});

test("a failed first turn still gets its title (admitted like a turn); its failure makes the next admission probe again", async () => {
  const a = await owner("failed");
  const used: string[] = [];
  setChatTitleComplete(async (_p, opts) => {
    used.push(opts.provider);
    return "Titled after a failure";
  });
  const c = await chat.create(a, { mode: "ASK", provider: "claude", fallback_enabled: false });
  failFor = "this provider fails";
  probes = 0;
  setChatHealthProber(healthy); // reset the shared reading
  await chat.postMessage(a, c.id, {
    content: "this provider fails",
    client_message_id: `title-failed-${c.id}`,
  });
  await settleBackground();
  assert.equal((await firstTurn(c.id)).status, "failed");
  assert.deepEqual(used, ["claude"]);
  assert.equal((await conversationRow(c.id)).title_source, "generated");
  // One probe for the turn; the PROVIDER_UNAVAILABLE failure invalidated it, so the title's admission probed again.
  assert.equal(probes, 2);
});

test("chat/title inherits AgentSettings model when target model is null", async () => {
  const a = await owner("tnull");
  const previousRow = await one<{ value: string }>(
    pool,
    "SELECT value FROM settings WHERE key='agent_configuration'",
  );
  const current = await loadAgentConfiguration();
  await saveProviderConfiguration("codex", current.providers.codex.revision, {
    defaults: { model: "gpt-test", reasoning_effort: "high" },
  });

  const tmp = mkdtempSync(join(tmpdir(), "chat-title-codex-"));
  const logFile = join(tmp, "codex.log");
  const savedEnv = {
    FAKE_CODEX_MODE: process.env.FAKE_CODEX_MODE,
    FAKE_CODEX_TEXT: process.env.FAKE_CODEX_TEXT,
    FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG,
  };
  const savedTitleReal = config.chat.titleRealInTests;
  setChatTitleComplete(undefined);
  config.chat.titleRealInTests = "1";
  process.env.FAKE_CODEX_MODE = "complete";
  process.env.FAKE_CODEX_TEXT = "Codex Generated Title";
  process.env.FAKE_CODEX_LOG = logFile;

  try {
    const c = await chat.create(a, {
      mode: "ASK",
      provider: "codex",
      model: null,
    });
    await q(
      pool,
      "INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, 'user', 'Fix checkout race condition')",
      [c.id],
    );
    await generateConversationTitle(c.id, a.id, { force: true });
    assert.deepEqual(await conversationRow(c.id), {
      title: "Codex Generated Title",
      title_source: "generated",
    });
    const entries = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv?: string[] });
    const execEntry = entries.find((e) => Array.isArray(e.argv));
    assert.ok(execEntry?.argv, "expected fake-codex exec invocation log");
    assert.ok(execEntry.argv.includes('model="gpt-test"'));
    assert.ok(execEntry.argv.includes('model_reasoning_effort="low"'));
  } finally {
    setChatTitleComplete(undefined);
    config.chat.titleRealInTests = savedTitleReal;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
    if (previousRow)
      await q(pool, "UPDATE settings SET value=$1 WHERE key='agent_configuration'", [
        previousRow.value,
      ]);
    else await q(pool, "DELETE FROM settings WHERE key='agent_configuration'");
  }
});
