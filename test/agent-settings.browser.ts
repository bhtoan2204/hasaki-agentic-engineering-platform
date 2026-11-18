/** Run with test/setup.ts: all services and the database belong to this test. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { createUser } from "../src/auth/users.ts";
import { pool } from "../src/db/pool.ts";
import { handle } from "../src/http/app.ts";
import { AGENT_PROVIDERS } from "../src/agent/provider.ts";
import { providerControlState } from "../src/agent/providerCapabilities.ts";

test("provider Settings retain drafts and hide unsupported controls", async () => {
  const previousModel = process.env.CODEX_MODEL;
  process.env.CODEX_MODEL = "gpt-environment-one";
  await createUser({
    username: "agent-settings-admin",
    password: "local-browser-password",
    role: "admin",
  });
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route("**/api/agent-providers*", (route) =>
      route.fulfill({
        json: AGENT_PROVIDERS.map((id) => ({
          id,
          ok: true,
          models:
            id === "claude"
              ? [
                  { slug: "sonnet", name: "Claude Sonnet", efforts: ["low", "medium", "high"] },
                  { slug: "opus", name: "Claude Opus", efforts: ["low", "medium", "high", "max"] },
                ]
              : id === "codex"
                ? [{ slug: "gpt-5-codex", name: "GPT-5 Codex", efforts: ["low", "medium", "high"] }]
                : [],
          discovery: id === "claude" || id === "codex" ? "available" : "unavailable",
          controls: providerControlState(id, { available: true, supportsModel: id !== "cursor" }),
        })),
      }),
    );
    await page.addInitScript(() => localStorage.setItem("hasaki.uiLocale", "en"));
    await page.goto(`${base}/#/settings`);
    await page.locator('[name="username"]').fill("agent-settings-admin");
    await page.locator('[name="password"]').fill("local-browser-password");
    await page.locator('button[type="submit"]').click();
    await page.getByRole("heading", { name: "Provider configuration", exact: true }).waitFor();
    for (const provider of ["claude", "codex", "cursor", "antigravity", "copilot"])
      assert.equal(await page.getByRole("tab", { name: provider, exact: true }).count(), 1);
    for (const profile of ["ANY PROFILE", "MICRO", "FAST", "STANDARD", "DEEP"])
      assert.equal(await page.getByRole("tab", { name: profile, exact: true }).count(), 1);
    // Combobox lets user pick from discovered catalog or type a custom model ID
    await page.getByLabel("Open Default model options", { exact: true }).click();
    await page.getByRole("option", { name: /Claude Sonnet/ }).click();
    assert.equal(await page.getByLabel("Default model", { exact: true }).inputValue(), "sonnet");
    await page.getByLabel("Default model", { exact: true }).fill("saved-draft");
    await page.getByRole("tab", { name: "cursor", exact: true }).click();
    assert.equal(await page.getByLabel("Default model", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("Default model selection", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("Default reasoning effort", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("Default maximum turns", { exact: true }).count(), 0);
    await page.getByRole("tab", { name: "claude", exact: true }).click();
    assert.equal(
      await page.getByLabel("Default model", { exact: true }).inputValue(),
      "saved-draft",
    );
    // Only the 3 roles of the active profile tab are rendered at once
    assert.equal(await page.locator(".agent-profile-role").count(), 3);
    assert.equal(
      await page.getByText("Empty inherits from the next configuration level").count(),
      0,
    );
    await page.getByRole("button", { name: "Save provider", exact: true }).click();
    await page.getByText("Provider saved", { exact: true }).waitFor();
    await page.reload();
    await page.getByLabel("Default model", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Default model", { exact: true }).inputValue(),
      "saved-draft",
    );
    await page.getByRole("tab", { name: "codex", exact: true }).click();
    await page.getByRole("tab", { name: "FAST", exact: true }).click();
    await page.getByLabel("FAST/agent model", { exact: true }).fill("gpt-profile");
    assert.equal(
      await page
        .getByRole("tab", { name: "FAST", exact: true })
        .locator(".agent-tab-badge")
        .textContent(),
      "1",
    );
    assert.equal(
      await page.locator(".agent-profile-role").first().locator(".agent-role-badge").textContent(),
      "Overridden",
    );
    const saving = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/settings/agents/provider") && request.method() === "POST",
    );
    await page.getByRole("button", { name: "Save provider", exact: true }).click();
    const payload = (await saving).postDataJSON();
    assert.equal(Object.hasOwn(payload.patch, "defaults"), false);
    await page.getByText("Provider saved", { exact: true }).waitFor();
    process.env.CODEX_MODEL = "gpt-environment-two";
    await page.reload();
    await page.getByRole("tab", { name: "codex", exact: true }).click();
    assert.equal(
      await page.getByLabel("Default model", { exact: true }).inputValue(),
      "gpt-environment-two",
    );
  } finally {
    if (previousModel === undefined) delete process.env.CODEX_MODEL;
    else process.env.CODEX_MODEL = previousModel;
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
