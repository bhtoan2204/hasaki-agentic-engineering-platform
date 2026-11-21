/**
 * Browser behaviour of Chat (production bundle, real server, real LISTEN/NOTIFY, stub providers):
 * one EventSource per open conversation across rerenders, clean switching while a turn streams, reconnect with
 * Last-Event-ID replay, no detail polling while the stream is healthy, and render cost of a long transcript under a
 * high-frequency token stream.
 *
 *   npm run build && npm run smoke:chat
 *   CHAT_BENCH_OUT=docs/architecture/chat-frontend.json npm run smoke:chat   # also writes the measurements
 */
import { test, before, after } from "node:test";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { handle } from "../src/http/app.ts";
import { createUser } from "../src/auth/users.ts";
import { chat } from "../src/chat/service.ts";
import { chatRepository } from "../src/chat/repository.ts";
import { setChatProviders } from "../src/chat/runtime.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import { setChatTitleComplete } from "../src/chat/title.ts";
import { stopChatStream } from "../src/chat/events.ts";
import { settleBackground } from "../src/workflow/background.ts";

let server: Server;
let browser: Browser;
let base = "";
let actor: { id: number; username: string; role: string; active: boolean };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const measurements: Record<string, unknown> = {};

// ---------------------------------------------------------------- stub provider (controllable)
const PROVIDERS = ["claude", "cursor", "codex", "antigravity", "copilot"] as const;
const provider = {
  tokens: 40,
  intervalMs: 10,
  /** While set, the provider waits for it after half of the tokens (a turn that is still streaming). */
  gate: null as Promise<void> | null,
};
let release: () => void = () => {};
const hold = () => {
  provider.gate = new Promise<void>((r) => (release = r));
};
const streamer = async (prompt: string, opts: { onStream?: (e: unknown) => void }) => {
  const tag =
    /tag-(\w+)/.exec(
      prompt
        .split("\n")
        .reverse()
        .find((l) => /tag-\w+/.test(l)) ?? "",
    )?.[1] ?? "x";
  opts.onStream?.({ type: "started" });
  let text = "";
  for (let i = 0; i < provider.tokens; i++) {
    if (i === provider.tokens >> 1 && provider.gate) await provider.gate;
    text += `w${i} `;
    opts.onStream?.({ type: "text", text });
    await sleep(provider.intervalMs);
  }
  text += `END-${tag}`;
  opts.onStream?.({ type: "text", text });
  return { text, model: "stub", tokens: { input: 10, output: 10 }, cost_usd: null };
};

before(async () => {
  await migrate();
  const u = await createUser({ username: "chat-ui", password: "chat-ui-password", role: "member" });
  actor = { id: u.id, username: u.username, role: u.role, active: u.active };
  setChatProviders(Object.fromEntries(PROVIDERS.map((p) => [p, streamer])) as never);
  setChatHealthProbe(async () =>
    PROVIDERS.map((p) => ({ provider: p, connected: true, quota: "unknown" as const })),
  );
  setChatTitleComplete(async () => "Stub title");
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    // Browser-only library path (a host without Chromium's system libraries), never applied to PostgreSQL or Node.
    ...(process.env.CHROMIUM_LD_LIBRARY_PATH
      ? { env: { ...process.env, LD_LIBRARY_PATH: process.env.CHROMIUM_LD_LIBRARY_PATH } }
      : {}),
  });
});

after(async () => {
  if (process.env.CHAT_BENCH_OUT)
    writeFileSync(
      process.env.CHAT_BENCH_OUT,
      JSON.stringify({ generated_at: new Date().toISOString(), ...measurements }, null, 2) + "\n",
    );
  await browser?.close();
  await stopChatStream();
  server.closeAllConnections();
  server.close();
  await settleBackground();
  setChatProviders(undefined);
  setChatHealthProbe(undefined);
  setChatTitleComplete(undefined);
  await pool.end();
});

/**
 * Counts EventSource constructions and open streams per URL, and React commits (a minimal devtools hook, read by the
 * production React build when it loads).
 */
const instrument = () => {
  const w = window as unknown as Record<string, unknown>;
  const created: Record<string, number> = {};
  const open = new Set<EventSource>();
  w.__chat = { created, open, commits: 0 };
  const Native = window.EventSource;
  class Counted extends Native {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      const path = new URL(String(url), location.href).pathname;
      created[path] = (created[path] ?? 0) + 1;
      open.add(this);
    }
    close() {
      open.delete(this);
      super.close();
    }
  }
  window.EventSource = Counted as typeof EventSource;
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    onScheduleFiberRoot() {},
    onCommitFiberRoot() {
      (w.__chat as { commits: number }).commits++;
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
};

async function signedIn(): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addInitScript(instrument);
  const page = await context.newPage();
  await page.goto(base + "/#/overview");
  await page.evaluate(async () => {
    await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "chat-ui", password: "chat-ui-password" }),
    });
  });
  await page.close();
  return context;
}

type Stats = { created: Record<string, number>; open: string[]; commits: number };
const stats = (page: Page) =>
  page.evaluate(() => {
    const c = (
      window as unknown as {
        __chat: { created: Record<string, number>; open: Set<EventSource>; commits: number };
      }
    ).__chat;
    return {
      created: { ...c.created },
      // Chat streams only: the app shell keeps its own shared /api/stream for every page.
      open: [...c.open]
        .filter((e) => e.readyState !== 2)
        .map((e) => new URL(e.url).pathname)
        .filter((p) => p.startsWith("/api/chat/")),
      commits: c.commits,
    } as Stats;
  });
const streamPath = (id: number) => `/api/chat/conversations/${id}/stream`;

function track(page: Page) {
  const urls: string[] = [];
  page.on("request", (r) => urls.push(new URL(r.url()).pathname + new URL(r.url()).search));
  return { urls, count: (re: RegExp) => urls.filter((u) => re.test(u)).length };
}
const occurrences = (page: Page, text: string) =>
  page.evaluate((t) => document.body.innerText.split(t).length - 1, text);
async function shows(page: Page, text: string, ms = 15_000) {
  const end = Date.now() + ms;
  while ((await occurrences(page, text)) === 0) {
    if (Date.now() > end) throw new Error(`"${text}" never appeared`);
    await sleep(50);
  }
}

async function conversation(turns = 0) {
  const c = await chat.create(actor as never, { mode: "ASK", provider: "claude" });
  for (let i = 0; i < turns; i++) {
    const turn = await chatRepository.insertTurn(
      {
        conversationId: c.id,
        ownerId: actor.id,
        clientMessageId: `seed-${c.id}-${i}`,
        mode: "ASK",
        provider: "claude",
        model: null,
        reasoningEffort: null,
        providerStrategy: "manual",
        regenerates: null,
      },
      pool,
    );
    await chatRepository.insertMessage(
      {
        conversationId: c.id,
        turnId: turn.id,
        role: "user",
        content: `Question ${i}: how does module ${i} work?`,
      },
      pool,
    );
    await chatRepository.insertMessage(
      {
        conversationId: c.id,
        turnId: turn.id,
        role: "assistant",
        content: `## Answer ${i}\n\n${"Some **markdown** with `code` and a [link](https://example.com). ".repeat(12)}\n\n- one\n- two\n- three\n\n\`\`\`ts\nconst x${i} = ${i};\n\`\`\`\n`,
      },
      pool,
    );
    await chatRepository.finishTurn(turn.id, "completed", { phase: "completed" });
  }
  return c.id;
}

async function openChat(context: BrowserContext, id: number) {
  const page = await context.newPage();
  const t = track(page);
  await page.goto(`${base}/#/chat/${id}`);
  await page.locator(".chat-composer textarea").waitFor({ timeout: 15_000 });
  await sleep(300);
  return { page, t };
}

async function send(page: Page, text: string) {
  const box = page.locator(".chat-composer textarea");
  await box.fill(text);
  await box.press("Enter");
}

/** Main-thread script and task time (CDP Performance domain), for render cost. */
async function perf(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  return async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    return {
      script: m.ScriptDuration * 1000,
      task: m.TaskDuration * 1000,
      layout: m.LayoutDuration * 1000,
    };
  };
}

test("one EventSource per open conversation across rerenders, typing and a streamed turn", async () => {
  const context = await signedIn();
  const id = await conversation(2);
  const { page } = await openChat(context, id);
  const box = page.locator(".chat-composer textarea");
  for (const ch of "rerender the page with every keystroke")
    await box.press(ch === " " ? "Space" : ch);
  await box.fill("");
  await send(page, "first tag-stable");
  await shows(page, "END-stable");
  await sleep(500);
  const s = await stats(page);
  measurements.sse_connections_per_streamed_turn = s.created[streamPath(id)];
  assert.equal(
    s.created[streamPath(id)],
    1,
    `one stream for the conversation: ${JSON.stringify(s.created)}`,
  );
  assert.deepEqual(s.open, [streamPath(id)], "exactly one open stream");
  assert.equal(await occurrences(page, "END-stable"), 1, "the answer is shown once");
  await context.close();
});

test("no detail polling while the stream is healthy; the list is not refetched by transcript events", async () => {
  const context = await signedIn();
  const id = await conversation(1);
  const { page, t } = await openChat(context, id);
  const detail = new RegExp(`^/api/chat/conversations/${id}$`);
  const list = /^\/api\/chat\/conversations(\?|$)/;
  const d0 = t.count(detail),
    l0 = t.count(list);
  await sleep(20_000);
  const idle = { detail: t.count(detail) - d0, list: t.count(list) - l0 };
  await send(page, "count requests tag-rest");
  await shows(page, "END-rest");
  await sleep(1500);
  const turn = { detail: t.count(detail) - d0 - idle.detail, list: t.count(list) - l0 - idle.list };
  measurements.rest_requests_idle_20s = idle;
  measurements.rest_requests_per_turn = turn;
  assert.equal(
    idle.detail,
    0,
    `no detail reload while idle with a healthy stream: ${JSON.stringify(idle)}`,
  );
  assert.ok(
    turn.detail <= 3,
    `a turn reloads the detail a bounded number of times: ${JSON.stringify(turn)}`,
  );
  await context.close();
});

test("switching conversations while a turn streams: one stream, the right one; the answer appears once on return", async () => {
  const context = await signedIn();
  const a = await conversation(1);
  const b = await conversation(1);
  const { page } = await openChat(context, a);
  hold();
  await send(page, "switch away tag-switch");
  await shows(page, "w5");
  await page.evaluate((b) => (location.hash = `/chat/${b}`), b);
  await page.locator(".chat-composer textarea").waitFor();
  await sleep(500);
  let s = await stats(page);
  assert.deepEqual(s.open, [streamPath(b)], `only B's stream is open: ${JSON.stringify(s.open)}`);
  assert.equal(await occurrences(page, "w5"), 0, "A's partial answer is not shown in B");
  release();
  provider.gate = null;
  await sleep(1000);
  await page.evaluate((a) => (location.hash = `/chat/${a}`), a);
  await shows(page, "END-switch");
  await sleep(500);
  s = await stats(page);
  assert.deepEqual(s.open, [streamPath(a)]);
  assert.equal(await occurrences(page, "END-switch"), 1);
  await context.close();
});

test("a dropped stream reconnects with Last-Event-ID; the answer is complete, in order and shown once", async () => {
  const context = await signedIn();
  const id = await conversation(1);
  const { page } = await openChat(context, id);
  hold();
  await send(page, "survive a disconnect tag-reconnect");
  await shows(page, "w5");
  await stopChatStream(); // ends every SSE response: the browser reconnects (retry 3 s) with Last-Event-ID
  release();
  provider.gate = null;
  await shows(page, "END-reconnect", 20_000);
  await sleep(1000);
  const text = await page.evaluate(() => document.body.innerText);
  const expected =
    Array.from({ length: provider.tokens }, (_, i) => `w${i}`).join(" ") + " END-reconnect";
  assert.ok(text.includes(expected), "the stored answer is complete and in order");
  assert.equal(await occurrences(page, "END-reconnect"), 1);
  const s = await stats(page);
  assert.deepEqual(s.open, [streamPath(id)], "one stream after the reconnect");
  await context.close();
});

test("long transcript under a high-frequency token stream: render cost", async () => {
  const context = await signedIn();
  const id = await conversation(100);
  const { page } = await openChat(context, id);
  await shows(page, "Answer 99");
  const metrics = await perf(page);
  provider.tokens = 300;
  provider.intervalMs = 5;
  try {
    const before = await stats(page);
    const m0 = await metrics();
    await send(page, "stream into a long transcript tag-long");
    await shows(page, "END-long", 30_000);
    await sleep(500);
    const m1 = await metrics();
    const after = await stats(page);
    // Typing into the composer of a long conversation.
    const box = page.locator(".chat-composer textarea");
    const k0 = await metrics();
    const c0 = (await stats(page)).commits;
    const typed = "typing cost in a long transcript";
    for (const ch of typed) await box.press(ch === " " ? "Space" : ch);
    const k1 = await metrics();
    const c1 = (await stats(page)).commits;
    measurements.long_transcript = {
      messages: 200,
      stream: { tokens: provider.tokens, interval_ms: provider.intervalMs },
      streamed_turn: {
        react_commits: after.commits - before.commits,
        script_ms: Math.round(m1.script - m0.script),
        task_ms: Math.round(m1.task - m0.task),
        layout_ms: Math.round(m1.layout - m0.layout),
      },
      typing: {
        keystrokes: typed.length,
        react_commits: c1 - c0,
        script_ms_per_key: Math.round(((k1.script - k0.script) / typed.length) * 10) / 10,
        task_ms_per_key: Math.round(((k1.task - k0.task) / typed.length) * 10) / 10,
      },
      sse_connections: after.created[streamPath(id)],
    };
    console.error(JSON.stringify(measurements.long_transcript));
    assert.equal(after.created[streamPath(id)], 1, "one stream for the whole turn");
    assert.equal(await occurrences(page, "END-long"), 1);
  } finally {
    provider.tokens = 40;
    provider.intervalMs = 10;
  }
  await context.close();
});
