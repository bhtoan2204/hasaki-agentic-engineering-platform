/**
 * HTTP hardening that needs no database: body ceilings, client IP trust, security headers and static path handling.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { connect, type AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { handle } from "../src/http/app.ts";
import { clientIp } from "../src/http/clientIp.ts";
import {
  AUTH_BODY_LIMIT,
  bodyLimitFor,
  DEFAULT_BODY_LIMIT,
  UPLOAD_BODY_LIMIT,
} from "../src/http/bodyLimits.ts";

const server = createServer(handle);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
after(() => server.close());

/** A raw GET, so the client cannot normalise the path. */
function rawGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const fakeReq = (forwarded: string | undefined, remote = "10.0.0.9") =>
  ({
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
    socket: { remoteAddress: remote },
  }) as unknown as IncomingMessage;

test("body limits: default 1 MiB, 16 KiB for credentials, explicit larger ones for uploads", () => {
  assert.equal(DEFAULT_BODY_LIMIT, 1024 * 1024);
  assert.equal(bodyLimitFor("/api/runs"), DEFAULT_BODY_LIMIT);
  assert.equal(bodyLimitFor("/api/auth/login"), AUTH_BODY_LIMIT);
  assert.equal(bodyLimitFor("/api/auth/password"), AUTH_BODY_LIMIT);
  assert.equal(bodyLimitFor("/api/chat/conversations/4/attachments"), UPLOAD_BODY_LIMIT);
  assert.equal(bodyLimitFor("/api/runs/4/steps/report/evidence"), UPLOAD_BODY_LIMIT);
  assert.ok(bodyLimitFor("/api/impact/analyze") > DEFAULT_BODY_LIMIT);
});

test("an oversized login body is a 413 and the connection is closed", async () => {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "a", password: "x".repeat(AUTH_BODY_LIMIT) }),
  });
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { error: "Body too large" });
});

test("a streamed body over the limit is refused without reading the rest", async () => {
  const sent = await new Promise<{ head: string; bytes: number }>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let head = "";
    let bytes = 0;
    const chunk = "x".repeat(8192);
    socket.on("data", (d) => (head += d.toString()));
    socket.on("error", () => {});
    socket.on("close", () => {
      clearInterval(timer);
      resolve({ head, bytes });
    });
    socket.write(
      "POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
    );
    // A client that would send 50 MiB: the server must stop reading after the limit.
    const timer = setInterval(() => {
      if (socket.destroyed || bytes > 50 * 1024 * 1024) return socket.destroy();
      bytes += chunk.length;
      socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
    }, 1);
    setTimeout(() => reject(new Error("server never closed the connection")), 8000).unref();
  });
  assert.match(sent.head, /^HTTP\/1\.1 413/);
  assert.match(sent.head, /connection: close/i);
  assert.ok(sent.bytes < 50 * 1024 * 1024, "the client was not drained to the end");
});

test("clientIp ignores X-Forwarded-For unless proxies are trusted", () => {
  assert.equal(clientIp(fakeReq("1.2.3.4"), 0), "10.0.0.9");
  assert.equal(clientIp(fakeReq(undefined), 0), "10.0.0.9");
  assert.equal(clientIp(fakeReq("1.2.3.4, 5.6.7.8"), 0), "10.0.0.9");
});

test("clientIp with trusted hops reads from the right, where a spoofed prefix cannot reach", () => {
  // One proxy (10.0.0.9) saw the client 5.6.7.8; the attacker prepended 1.2.3.4.
  assert.equal(clientIp(fakeReq("1.2.3.4, 5.6.7.8"), 1), "5.6.7.8");
  // Two proxies: the first proxy's address was appended by the second.
  assert.equal(clientIp(fakeReq("1.2.3.4, 5.6.7.8"), 2), "1.2.3.4");
  // Fewer entries than hops: the leftmost entry, never undefined.
  assert.equal(clientIp(fakeReq("5.6.7.8"), 3), "5.6.7.8");
  // A trusted hop with no header at all falls back to the socket address.
  assert.equal(clientIp(fakeReq(undefined), 1), "10.0.0.9");
});

test("static responses carry the security headers", async () => {
  const r = await fetch(`${base}/runs/150`);
  await r.arrayBuffer();
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.ok(r.headers.get("permissions-policy"));
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self'(?:;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
  // Plain-HTTP loopback: no HSTS.
  assert.equal(r.headers.get("strict-transport-security"), null);
});

test("API responses carry the security headers", async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
});

test("HSTS is sent only when the cookie is Secure", async () => {
  const before = process.env.COOKIE_SECURE;
  process.env.COOKIE_SECURE = "1";
  try {
    const r = await fetch(`${base}/api/health`);
    assert.match(r.headers.get("strict-transport-security") ?? "", /max-age=\d+/);
  } finally {
    if (before === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = before;
  }
});

test("paths that escape the web root are rejected, never served", async () => {
  // Backslashes and NUL are refused outright.
  for (const path of [
    "/..%5c..%5cpackage.json",
    "/%5c..%5cpackage.json",
    "/assets/%2e%2e%5c%2e%2e%5cpackage.json",
    "/a%00b",
  ]) {
    const r = await rawGet(path);
    assert.equal(r.status, 400, path);
  }
  // Dot segments cannot climb out of the root: refused, or clamped inside it (then the HTML shell / a 404).
  for (const path of [
    "/..%2f..%2fpackage.json",
    "/%2e%2e/%2e%2e/package.json",
    "/assets/..%2f..%2f..%2fpackage.json",
    "/../../package.json",
  ]) {
    const r = await rawGet(path);
    assert.ok([200, 400, 404, 503].includes(r.status), `${path} -> ${r.status}`);
    assert.doesNotMatch(r.body, /"name"\s*:/, path);
  }
});

test("a malformed percent-encoding is a 400, not an unhandled error", async () => {
  for (const path of ["/%", "/%E0%A4%A", "/assets/%zz.js"]) {
    const r = await rawGet(path);
    assert.equal(r.status, 400, path);
  }
  const ok = await rawGet("/api/health");
  assert.equal(ok.status, 200);
});
