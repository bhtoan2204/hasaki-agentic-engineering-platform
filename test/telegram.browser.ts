/** Real settings UI + HTTP/database, mocked Telegram API; no live bot/account required. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { config } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { pool, one } from "../src/db/pool.ts";
import { createUser } from "../src/auth/users.ts";
import { handle } from "../src/http/app.ts";
import { ingestUpdate, processInbox } from "../src/telegram/updates.ts";
import { deliverOutbox } from "../src/telegram/transport.ts";
await migrate();
await createUser({
  username: "telegram-ui-admin",
  password: "telegram-ui-password",
  role: "admin",
});
const user = await createUser({
  username: "telegram-ui",
  password: "telegram-ui-password",
  role: "member",
});
let msgId = 1;
const bot = createServer(async (req, res) => {
  for await (const _ of req) {
    void _;
  }
  const method = req.url!.split("/").at(-1);
  res.writeHead(200, { "Content-Type": "application/json" }).end(
    JSON.stringify({
      ok: true,
      result:
        method === "getMe"
          ? { id: 123, username: "hasaki_ui_test_bot" }
          : method === "sendMessage"
            ? { message_id: ++msgId }
            : true,
    }),
  );
});
await new Promise<void>((r) => bot.listen(0, "127.0.0.1", r));
const secret = "12345:UI_BOT_TOKEN_not_exposed_123456";
Object.assign(config.telegram, {
  botToken: secret,
  apiBase: `http://127.0.0.1:${(bot.address() as any).port}`,
  mode: "polling",
});
const server = createServer(handle);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const out = resolve("docs/validation/telegram");
mkdirSync(out, { recursive: true });
const results: string[] = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.addInitScript(() => localStorage.setItem("hasaki.uiLocale", "en"));
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/#/integrations`);
  await page.locator('[name="username"]').fill(user.username);
  await page.locator('[name="password"]').fill("telegram-ui-password");
  await page.locator('button[type="submit"]').click();
  await page.locator('button[aria-controls="ig-telegram"]').click();
  const panel = page.locator("#ig-telegram");
  await panel.getByRole("button", { name: "Connect Telegram", exact: true }).waitFor();
  assert.equal(
    await panel.locator('input[type="password"]').count(),
    0,
    "members cannot see/edit bot credentials",
  );
  assert.ok(!(await panel.innerHTML()).includes(secret));
  await panel.getByRole("button", { name: "Connect Telegram", exact: true }).click();
  const bindingLink = await panel
    .getByRole("link", {
      name: "Open Telegram to link (10 minutes)",
      exact: true,
    })
    .getAttribute("href");
  assert.ok(bindingLink?.startsWith("https://t.me/hasaki_ui_test_bot?start=bind_"));
  const start = new URL(bindingLink!).searchParams.get("start");
  await ingestUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 777, is_bot: false },
      chat: { id: 777, type: "private" },
      text: `/start ${start}`,
    },
  });
  await processInbox();
  await deliverOutbox();
  await panel.getByRole("button", { name: "Check connection", exact: true }).click();
  await panel.getByRole("button", { name: "Disconnect Telegram", exact: true }).waitFor();
  // No consumer holds the lease in this test: the panel must say so instead of implying taps work.
  assert.match(
    (await panel.locator(".ig-tg-receiver").textContent()) ?? "",
    /Receiver not running/,
  );
  results.push("PASS receiver status reflects the shared consumer lease");
  assert.ok(
    await one(pool, "SELECT * FROM telegram_bindings WHERE user_id=$1 AND telegram_user_id='777'", [
      user.id,
    ]),
  );
  results.push(
    "PASS secure link-based binding and connected UI; no bot credential exposed to member",
  );
  await panel.getByLabel("Enable interactive buttons", { exact: true }).uncheck();
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(
    (await one(pool, "SELECT interactive FROM telegram_preferences WHERE user_id=$1", [user.id]))!
      .interactive,
    false,
  );
  await panel.getByLabel("Notification language", { exact: true }).selectOption("en");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(
    (await one(pool, "SELECT locale FROM telegram_preferences WHERE user_id=$1", [user.id]))!
      .locale,
    "en",
  );
  results.push("PASS owner-scoped notification preferences and language persist through real API");
  await page.waitForFunction(() => document.querySelectorAll(".toast").length === 0);
  for (const locale of ["vi", "en"])
    for (const theme of ["dark", "light"])
      for (const width of [1440, 390]) {
        await page.getByRole("button", { name: locale.toUpperCase(), exact: true }).click();
        if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme)
          await page.locator(".tb-right > button").click();
        await page.setViewportSize({ width, height: 900 });
        await panel.scrollIntoViewIfNeeded();
        assert.equal(
          await page.evaluate(() => {
            const main = document.querySelector("main")!;
            return (
              document.documentElement.scrollWidth > innerWidth ||
              main.scrollWidth > main.clientWidth
            );
          }),
          false,
          `${locale} ${theme} ${width} overflow`,
        );
        await page.screenshot({
          path: resolve(out, `settings-${locale}-${theme}-${width}.png`),
        });
      }
  results.push("PASS VI/EN, light/dark and 1440px/390px settings layouts");
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await panel.getByRole("button", { name: "Disconnect Telegram", exact: true }).click();
  await panel.getByRole("button", { name: "Connect Telegram", exact: true }).waitFor();
  assert.equal(
    await one(pool, "SELECT user_id FROM telegram_bindings WHERE user_id=$1", [user.id]),
    undefined,
  );
  results.push("PASS disconnect removes identity and restores connect flow");
  assert.deepEqual(errors, []);
  results.push("PASS no browser errors");
  writeFileSync(resolve(out, "browser-results.txt"), results.join("\n") + "\n");
  console.log(results.join("\n"));
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => bot.close(() => r()));
  await pool.end();
}
