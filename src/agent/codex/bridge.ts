/**
 * Platform MCP server Codex spawns over stdio for one attempt (configured per invocation with -c mcp_servers.platform.*,
 * never in the user's ~/.codex/config.toml). It holds no credentials: every tools/call is relayed to the worker's
 * per-attempt broker, which runs dispatchPlatformTool with the attempt's lease, fencing and ownership checks.
 * The broker socket and token are forwarded by Codex from its own environment (mcp_servers.platform.env_vars) and are
 * excluded from the agent's shell environment.
 */
import { brokerRequest } from "./client.ts";
import { bridgeToolsFor, serveStdio } from "../mcpBridge.ts";

const socket = process.env.PLATFORM_BROKER_SOCKET;
const token = process.env.PLATFORM_BROKER_TOKEN;
if (!socket || !token) {
  process.stderr.write("platform bridge refused to start: missing per-attempt broker credentials\n");
  process.exit(1);
}

serveStdio({
  tools: bridgeToolsFor(process.env.PLATFORM_MODE || "analysis", { commit: true }),
  framing: "auto",
  async call(name, args) {
    try {
      const r = await brokerRequest(socket, { token, kind: "tool", name, args }, 30 * 60 * 1000);
      return r?.ok ? String(r.text ?? "") : `ERROR: platform broker refused ${name}: ${r?.error ?? "unknown error"}`;
    } catch (e) {
      return `ERROR: platform broker unavailable: ${(e as Error).message}`;
    }
  },
});
