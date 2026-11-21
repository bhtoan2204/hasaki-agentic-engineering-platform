/**
 * Telegram is configured only on the Integrations page (bot token as an encrypted shared secret, mode off|polling in
 * settings): TELEGRAM_* environment variables are not read into the configuration any more.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("TELEGRAM_* variables in the environment are ignored", () => {
  const r = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      'const { config } = await import("./src/config.ts"); console.log(JSON.stringify(config.telegram));',
    ],
    {
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: "123:ENV_TOKEN",
        TELEGRAM_CHAT_ID: "42",
        TELEGRAM_MODE: "polling",
        TELEGRAM_WEBHOOK_URL: "https://env.example/hook",
        TELEGRAM_WEBHOOK_SECRET: "env-secret-1234567890",
        TELEGRAM_API_BASE: "http://127.0.0.1:1",
      },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const t = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
  assert.deepEqual(
    {
      botToken: t.botToken,
      chatId: t.chatId,
      mode: t.mode,
      webhookUrl: t.webhookUrl,
      webhookSecret: t.webhookSecret,
    },
    { botToken: "", chatId: "", mode: "off", webhookUrl: "", webhookSecret: "" },
  );
  assert.equal(t.apiBase, "https://api.telegram.org");
});
