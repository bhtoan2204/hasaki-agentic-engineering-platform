/**
 * Static web assets: a hashed chunk that no longer exists (a tab still running the previous build after a rebuild)
 * must be a 404, never index.html served as JavaScript — the client then recovers by reloading (web/src/App.tsx).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handle } from "../src/http/app.ts";

const server = createServer(handle);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test("a missing hashed asset is a 404, not the HTML shell", async () => {
  const r = await fetch(`${base}/assets/RunView-0ldBu1ld.js`);
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("application routes still get the HTML shell (or the not-built notice)", async () => {
  const r = await fetch(`${base}/runs/150`);
  assert.ok([200, 503].includes(r.status), String(r.status));
  if (r.status === 200) assert.match(r.headers.get("content-type") ?? "", /text\/html/);
});
