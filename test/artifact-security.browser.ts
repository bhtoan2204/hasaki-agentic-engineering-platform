// Run with the test-owned PostgreSQL preload and a locally provisioned Playwright Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { handle } from "../src/http/app.ts";
import { pool, one } from "../src/db/pool.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { createUser, setActive } from "../src/auth/users.ts";

const server = createServer((req, res) => {
  if (req.url === "/artifact-security-fixture") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>Artifact security fixture</title>");
    return;
  }
  return handle(req, res);
});
let base: string;
let ownerId: number;
let owner: string;
let other: string;
let admin: string;
const artifacts: Array<{ id: number; body: string; mime: string; binary: boolean }> = [];
const payload = '<script>parent.postMessage("artifact-executed", "*")</script><svg onload="parent.postMessage(\'artifact-executed\', \'*\')"></svg>';

async function login(username: string) {
  const response = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "fixture-password" }),
  });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}
before(async () => {
  await seedTemplates();
  ownerId = (await createUser({ username: "artifactowner", password: "fixture-password", role: "member" })).id;
  await createUser({ username: "artifactother", password: "fixture-password", role: "member" });
  await createUser({ username: "artifactsupport", password: "fixture-password", role: "admin" });
  const run = await startRun({ definitionKey: "bug-investigation", title: "Artifact isolation", ownerId, start: false });
  for (const [mime, binary] of [["text/html", true], ["image/svg+xml", true], ["application/pdf", true], ["image/png", true], ["text/html", false]] as const) {
    const row = await one<{ id: number }>(pool,
      "INSERT INTO workflow_artifacts (run_id, kind, name, content, data) VALUES ($1, 'evidence', $2, $3, $4) RETURNING id",
      [run.id, 'hostile"\r\nname.html', binary ? Buffer.from(payload).toString("base64") : payload, JSON.stringify({ mime, ...(binary ? { encoding: "base64" } : {}) })]);
    artifacts.push({ id: row!.id, body: payload, mime, binary });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  [owner, other, admin] = await Promise.all([login("artifactowner"), login("artifactother"), login("artifactsupport")]);
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("artifact HTTP responses preserve bytes and enforce owner, explicit support and revoked-session access", async () => {
  for (const artifact of artifacts) {
    const path = `/api/artifacts/${artifact.id}`;
    for (const suffix of ["", "/raw"]) {
      assert.equal((await fetch(base + path + suffix)).status, 401);
      assert.equal((await fetch(base + path + suffix, { headers: { cookie: other } })).status, 404);
      assert.equal((await fetch(base + path + suffix + "?scope=all", { headers: { cookie: other } })).status, 404);
      assert.equal((await fetch(base + path + suffix, { headers: { cookie: admin } })).status, 404);
      assert.equal((await fetch(base + path + suffix + "?scope=all", { headers: { cookie: admin } })).status, 200);
    }
    const response = await fetch(base + path + "/raw", { headers: { cookie: owner } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), artifact.body);
    assert.equal(response.headers.get("content-type"), artifact.binary ? "application/octet-stream" : "text/plain; charset=utf-8");
    assert.match(response.headers.get("content-disposition")!, artifact.binary ? /^attachment;/ : /^inline;/);
    assert.doesNotMatch(response.headers.get("content-disposition")!, /[\r\n]/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy")!, /sandbox; default-src 'none'/);
  }
  const audit = await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM audit_log WHERE action = 'support.access' AND actor_id = (SELECT id FROM users WHERE username = 'artifactsupport')");
  assert.ok(audit!.n >= artifacts.length * 2);
  await setActive(ownerId, false);
  try {
    for (const suffix of ["", "/raw"]) assert.equal((await fetch(`${base}/api/artifacts/${artifacts[0].id}${suffix}`, { headers: { cookie: owner } })).status, 401);
  } finally {
    await setActive(ownerId, true);
    owner = await login("artifactowner");
  }
});

test("served hostile artifacts cannot execute in an authenticated browser", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN || chromium.executablePath(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: "sid", value: owner.slice("sid=".length), url: base }]);
    const page = await context.newPage();
    await page.goto(base + "/artifact-security-fixture");
    // Prove the payload and observer detect execution before testing the protected delivery route.
    await page.setContent('<script>addEventListener("message", e => { if (e.data === "artifact-executed") window.artifactExecuted = true; });</script>' + payload);
    await page.waitForFunction(() => (window as Window & { artifactExecuted?: boolean }).artifactExecuted === true, undefined, { timeout: 5000 });
    await page.setContent("<p>Artifact security fixture</p>");
    await page.evaluate(() => {
      (window as Window & { artifactExecuted?: boolean }).artifactExecuted = false;
      window.addEventListener("message", (event) => {
        if (event.data === "artifact-executed") (window as Window & { artifactExecuted?: boolean }).artifactExecuted = true;
      });
    });
    for (const artifact of artifacts.filter((a) => a.binary)) {
      const download = page.waitForEvent("download");
      await page.evaluate((url) => { const a = document.createElement("a"); a.href = url; document.body.append(a); a.click(); }, `${base}/api/artifacts/${artifact.id}/raw`);
      assert.ok(await download);
    }
    assert.equal(await page.evaluate(() => (window as Window & { artifactExecuted?: boolean }).artifactExecuted), false);
    const text = artifacts.find((a) => !a.binary)!;
    const url = `${base}/api/artifacts/${text.id}/raw`;
    await page.evaluate((src) => new Promise<void>((resolve) => {
      const frame = document.createElement("iframe"); frame.onload = () => resolve(); frame.src = src; document.body.append(frame);
    }), url);
    const frame = page.frames().find((f) => f.url() === url)!;
    assert.equal(await frame.locator("script, svg").count(), 0);
    assert.ok((await frame.textContent("body"))!.includes("<script>"));
    assert.equal(await page.evaluate(() => (window as Window & { artifactExecuted?: boolean }).artifactExecuted), false);
    await context.close();
  } finally { await browser.close(); }
});
