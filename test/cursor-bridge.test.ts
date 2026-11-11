import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

/** Send one raw request to the Cursor MCP bridge and return what it wrote back. */
async function exchange(raw: string): Promise<string> {
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../src/agent/cursor/bridge.ts")],
    { env: { ...process.env, PLATFORM_BROKER_SOCKET: "/nonexistent.sock", PLATFORM_BROKER_TOKEN: "t", PLATFORM_MODE: "analysis" } },
  );
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.write(raw);
  for (let i = 0; i < 50 && !out.includes("}"); i++) await new Promise((r) => setTimeout(r, 100));
  child.kill();
  return out;
}

const init = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

test("Cursor MCP bridge answers newline-delimited JSON in kind (current Cursor CLIs reject Content-Length replies)", async () => {
  const out = await exchange(init + "\n");
  assert.doesNotMatch(out, /Content-Length/i, "an NDJSON client must not get LSP-style headers back");
  const reply = JSON.parse(out.trim().split("\n")[0]);
  assert.equal(reply.id, 1);
  assert.equal(reply.result.serverInfo.name, "platform");
});

test("Cursor MCP bridge still answers Content-Length framed requests with Content-Length", async () => {
  const out = await exchange(`Content-Length: ${Buffer.byteLength(init)}\r\n\r\n${init}`);
  assert.match(out, /^Content-Length: \d+\r\n\r\n/);
  assert.equal(JSON.parse(out.split("\r\n\r\n")[1]).id, 1);
});
