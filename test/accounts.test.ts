import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { settings } from "../src/db.ts";

let server: Server;
const sent: any[] = [];
const TOKEN = "123456:ABCdefGHIjklMNOpqrSTUvwx";
before(async () => {
  await migrate();
  await settings.set("telegram", "");
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (code: number, b: unknown) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(b)));
      if (!req.url!.startsWith(`/bot${TOKEN}/`)) return json(401, { ok: false, description: "Unauthorized" });
      if (req.url!.endsWith("/getMe")) return json(200, { ok: true, result: { username: "hsk_bot" } });
      if (req.url!.endsWith("/getUpdates")) return json(200, { ok: true, result: [{ message: { chat: { id: 42, first_name: "Toan", type: "private" } } }, { my_chat_member: { chat: { id: -1001, title: "Payment team", type: "supergroup" } } }] });
      if (req.url!.endsWith("/sendMessage")) return (sent.push(JSON.parse(body)), json(200, { ok: true, result: {} }));
      json(404, { ok: false });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  config.telegram.apiBase = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  server.close();
  await settings.set("telegram", "");
  await pool.end();
});

test("Telegram: env values are the fallback, UI values win and persist, clearing falls back; secrets masked", async () => {
  Object.assign(config.telegram, { botToken: "999:ENVTOKENxxxxxxxxxxxxxxxxx", chatId: "7" }); // as if from .env
  const acc = await import(`../src/integrations/accounts.ts?${Date.now()}`); // captures the env fallback now
  await acc.loadAccountSettings();
  assert.equal((await acc.telegramStatus()).source, "env");

  await assert.rejects(acc.setTelegram({ botToken: "nope", chatId: "42" }), /BotFather/);
  await assert.rejects(acc.setTelegram({ botToken: TOKEN, chatId: "abc" }), /chat id/);
  await assert.rejects(acc.setTelegram({ botToken: "123456:WRONGwrongWRONGwrongWRONG", chatId: "42" }), /Unauthorized/);

  assert.deepEqual((await acc.telegramChats({ botToken: TOKEN })).map((c: any) => c.id), ["42", "-1001"]);
  const st = await acc.setTelegram({ botToken: TOKEN, chatId: "42" });
  assert.equal(st.bot, "@hsk_bot");
  assert.equal(st.source, "platform");
  assert.equal(st.botToken, "••••STUvwx".replace("STUvwx", TOKEN.slice(-4)));
  assert.ok(!JSON.stringify(st).includes(TOKEN), "token never returned");
  assert.equal(config.telegram.botToken, TOKEN, "applied to config used by telegram.ts");

  await acc.setTelegram({ chatId: "-1001" }); // empty token keeps the saved one
  assert.equal(config.telegram.botToken, TOKEN);
  assert.equal(config.telegram.chatId, "-1001");
  await acc.testTelegram(undefined, true); // admin without a personal chat: the shared chat
  assert.equal(sent.at(-1).chat_id, "-1001");
  // Step notifications use the user's OWN chat: settable from the UI, shown in the status, used by "send a test".
  const { ensureTestOwner } = await import("../src/auth/testOwner.ts");
  const uid = await ensureTestOwner();
  await assert.rejects(acc.testTelegram(uid, false), /chat nhận thông báo/, "a member without a chat gets a clear error");
  await acc.setTelegramDestination(uid, "555");
  assert.equal((await acc.telegramStatus(uid)).myChatId, "555");
  await acc.testTelegram(uid, false);
  assert.equal(sent.at(-1).chat_id, "555");
  await acc.setTelegramDestination(uid, "");
  assert.equal((await acc.telegramStatus(uid)).myChatId, null, "empty clears it");

  Object.assign(config.telegram, { botToken: "", chatId: "" });
  await acc.loadAccountSettings(); // restart: reloaded from the settings table
  assert.equal(config.telegram.chatId, "-1001");

  const cleared = await acc.clearTelegram();
  assert.equal(cleared.source, "env");
  assert.equal(config.telegram.botToken, "999:ENVTOKENxxxxxxxxxxxxxxxxx");
});

test("Bitbucket: reviewers must be UUIDs; user+token required", async () => {
  const acc = await import("../src/integrations/accounts.ts");
  await assert.rejects(acc.setBitbucket({ user: "", token: "" }), /cần user/);
  await assert.rejects(acc.setBitbucket({ user: "a@b.c", token: "t", reviewers: "nobody" }), /UUID/);
});
