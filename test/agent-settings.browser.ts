/** Run with test/setup.ts: all services and the database belong to this test. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { createUser } from "../src/auth/users.ts";
import { pool } from "../src/db/pool.ts";
import { handle } from "../src/http/app.ts";

test("provider Settings retain drafts and hide unsupported controls", async () => {
  await createUser({
    username: "agent-settings-admin",
    password: "local-browser-password",
    role: "admin",
  });
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem("hasaki.uiLocale", "en"));
    await page.goto(`${base}/#/settings`);
    await page.locator('[name="username"]').fill("agent-settings-admin");
    await page.locator('[name="password"]').fill("local-browser-password");
    await page.locator('button[type="submit"]').click();
    await page.getByRole("heading", { name: "Provider configuration", exact: true }).waitFor();
    for (const provider of ["claude", "codex", "cursor", "antigravity", "copilot"])
      assert.equal(await page.getByRole("tab", { name: provider, exact: true }).count(), 1);
    await page.getByLabel("Default model", { exact: true }).fill("saved-draft");
    await page.getByRole("tab", { name: "cursor", exact: true }).click();
    assert.equal(await page.getByLabel("Default reasoning effort", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("Default maximum turns", { exact: true }).count(), 0);
    await page.getByRole("tab", { name: "claude", exact: true }).click();
    assert.equal(
      await page.getByLabel("Default model", { exact: true }).inputValue(),
      "saved-draft",
    );
    assert.equal(await page.locator(".agent-profile-role").count(), 15);
    await page.getByRole("button", { name: "Save provider", exact: true }).click();
    await page.getByText("Provider saved", { exact: true }).waitFor();
    await page.reload();
    await page.getByLabel("Default model", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Default model", { exact: true }).inputValue(),
      "saved-draft",
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
