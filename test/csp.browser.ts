/**
 * The UI under its real Content-Security-Policy: no `bypassCSP`, so a blocked script, style, font, image or connection
 * shows up as a securitypolicyviolation. (The other browser tests bypass the CSP because Playwright's string evaluation
 * needs 'unsafe-eval'; this one is what keeps the policy honest.) Run after npm run build:
 *   node --import ./test/setup.ts test/csp.browser.ts   (CHROMIUM_BIN=... if Playwright's Chromium is not installed)
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";
import { migrate } from "../src/db/migrate.ts";
import { pool } from "../src/db/pool.ts";
import { handle } from "../src/http/app.ts";
import { createUser } from "../src/auth/users.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { seedKnowledge } from "../src/knowledge/service.ts";

assert.equal(process.env.PLATFORM_TEST, "1");
await migrate();
await seedTemplates();
await seedKnowledge();
const server = createServer(handle);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const password = randomBytes(20).toString("hex");
await createUser({ username: "csp-admin", password, role: "admin" });

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_BIN || process.env.CHROMIUM_PATH || chromium.executablePath(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "csp-admin", password }),
  });
  assert.equal(login.status, 200);
  const sid = /sid=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(sid);
  await context.addCookies([{ name: "sid", value: sid, url: base }]);

  const page = await context.newPage();
  const messages: string[] = [];
  page.on("pageerror", (e) => messages.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (/content security policy|refused to/i.test(m.text())) messages.push(m.text());
  });
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });
  const response = await page.goto(base + "/", { waitUntil: "load" });
  assert.match(response?.headers()["content-security-policy"] ?? "", /script-src 'self'/);
  for (const path of [
    "/runs",
    "/chat",
    "/knowledge",
    "/integrations",
    "/repositories",
    "/settings",
    "/",
  ]) {
    // SSE keeps the network busy, so wait for the load event and a moment for lazy chunks, fonts and the first fetches.
    await page.goto(base + path, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    // The shell mounted: something rendered into #root.
    assert.ok((await page.locator("#root *").count()) > 0, `nothing rendered at ${path}`);
    const violations = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    messages.push(...violations.map((v) => `${path}: ${v}`));
  }
  assert.deepEqual(messages, [], "the UI must run without any Content-Security-Policy violation");
  console.log("csp: no violations");
} finally {
  await browser.close();
  server.close();
  await pool.end();
}
