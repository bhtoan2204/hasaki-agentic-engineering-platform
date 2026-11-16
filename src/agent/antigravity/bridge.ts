/**
 * Platform MCP server spawned by Antigravity over stdio for one attempt.
 * Relays all tool calls to the worker's per-attempt broker.
 */
import { brokerRequest } from "../codex/client.ts";
import { bridgeToolsFor, serveStdio } from "../mcpBridge.ts";

const socket = process.env.PLATFORM_BROKER_SOCKET;
const token = process.env.PLATFORM_BROKER_TOKEN;
if (!socket || !token) {
  process.stderr.write(
    "antigravity platform bridge refused to start: missing per-attempt broker credentials\n",
  );
  process.exit(1);
}

serveStdio({
  tools: bridgeToolsFor(process.env.PLATFORM_MODE || "analysis", {
    commit: true,
  }),
  framing: "auto",
  async call(name, args) {
    try {
      const r = await brokerRequest(socket, { token, kind: "tool", name, args }, 30 * 60 * 1000);
      return r?.ok
        ? String(r.text ?? "")
        : `ERROR: platform broker refused ${name}: ${r?.error ?? "unknown error"}`;
    } catch (e) {
      return `ERROR: platform broker unavailable: ${(e as Error).message}`;
    }
  },
});
