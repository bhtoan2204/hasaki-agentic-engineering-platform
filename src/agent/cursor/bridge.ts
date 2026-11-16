/** Cursor's stdio helper holds only an attempt-scoped broker capability, never database credentials. */
import { brokerRequest } from "../codex/client.ts";
import { bridgeToolsFor, serveStdio } from "../mcpBridge.ts";
export function startBridge() {
  const socket = process.env.PLATFORM_BROKER_SOCKET,
    token = process.env.PLATFORM_BROKER_TOKEN;
  if (!socket || !token) {
    process.stderr.write(
      "platform bridge refused to start: missing per-attempt broker credentials\n",
    );
    process.exit(1);
  }
  serveStdio({
    tools: bridgeToolsFor(process.env.PLATFORM_MODE || "analysis"),
    // Reply in the framing the client used: current Cursor CLIs speak newline-delimited JSON (MCP stdio) and fail to
    // load a server that answers with LSP-style Content-Length headers ("namespace platform not found").
    framing: "auto",
    async call(name, args) {
      const r = await brokerRequest(socket, { token, kind: "tool", name, args }, 65000);
      return r?.ok
        ? String(r.text ?? "")
        : `ERROR: platform broker refused: ${r?.error ?? "unknown"}`;
    },
  });
}
if (process.argv[1]?.endsWith("bridge.ts")) startBridge();
