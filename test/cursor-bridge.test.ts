import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

/** Send one raw request to the Cursor MCP bridge and return what it wrote back. */
async function exchange(raw: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      join(import.meta.dirname, "../src/agent/cursor/bridge.ts"),
    ],
    {
      env: {
        ...process.env,
        PLATFORM_BROKER_SOCKET: "/nonexistent.sock",
        PLATFORM_BROKER_TOKEN: "t",
        PLATFORM_MODE: "analysis",
      },
    },
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
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
});

test("Cursor MCP bridge answers newline-delimited JSON in kind (current Cursor CLIs reject Content-Length replies)", async () => {
  const out = await exchange(init + "\n");
  assert.doesNotMatch(
    out,
    /Content-Length/i,
    "an NDJSON client must not get LSP-style headers back",
  );
  const reply = JSON.parse(out.trim().split("\n")[0]);
  assert.equal(reply.id, 1);
  assert.equal(reply.result.serverInfo.name, "platform");
});

test("Cursor MCP bridge still answers Content-Length framed requests with Content-Length", async () => {
  const out = await exchange(`Content-Length: ${Buffer.byteLength(init)}\r\n\r\n${init}`);
  assert.match(out, /^Content-Length: \d+\r\n\r\n/);
  assert.equal(JSON.parse(out.split("\r\n\r\n")[1]).id, 1);
});

test("Cursor token deltas become one transcript message per turn (not one line per word)", async () => {
  const { TextCoalescer } = await import("../src/agent/cursor/stream.ts");
  const out: Array<[string, string]> = [];
  const c = new TextCoalescer(async (k, t) => void out.push([k, t]));
  for (const w of ["I'll", " read", " the", " task", " prompt"]) await c.push("agent", w);
  await c.flush(); // a tool call arrives
  await c.push("thinking", "Need the");
  await c.push("thinking", " diff");
  await c.push("agent", "Done."); // switching kind closes the thinking message
  await c.flush();
  await c.flush(); // nothing open: no empty message
  assert.deepEqual(out, [
    ["agent", "I'll read the task prompt"],
    ["thinking", "Need the diff"],
    ["agent", "Done."],
  ]);
});

test("Cursor permissions: real env files stay unreadable, .env templates are readable and editable", async () => {
  const { writeCursorPolicy, SECRET_ENV_FILES } =
    await import("../src/agent/cursor/permissions.ts");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { matchesGlob } = await import("node:path");
  const ws = mkdtempSync(join(tmpdir(), "cursor-policy-"));
  const { permissions } = JSON.parse(
    readFileSync(writeCursorPolicy(ws, { reposRoot: "/src", workspaces: [ws] }), "utf8"),
  );
  assert.ok(!permissions.deny.includes("Read(**/.env*)"), "no blanket .env* deny");
  assert.ok(
    permissions.deny.includes("Read(**/mcp.json)"),
    "the bridge credentials stay unreadable",
  );
  const blocked = (name: string) => SECRET_ENV_FILES.some((g) => matchesGlob(name, g));
  for (const f of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.prod",
    ".env.staging",
    ".env.qc",
    ".env.development",
    ".env.test",
    ".env.uat",
    ".envrc",
    ".env.production.local",
  ])
    assert.ok(blocked(f), `${f} is denied`);
  for (const f of [".env.example", ".env.sample", ".env.template", ".env.dist"])
    assert.ok(!blocked(f), `${f} is readable`);
});
