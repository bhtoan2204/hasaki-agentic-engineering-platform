/**
 * Per-run MCP server Cursor CLI spawns over stdio. It is not a network service.
 * The token and attempt ids come from the process environment written into the run's .cursor/mcp.json
 * and removed when the agent process exits. Every tool call re-checks the attempt lease.
 */
import { dispatchPlatformTool, envFromDatabase } from "../platformTools.ts";
import { bridgeToolsFor, serveStdio } from "../mcpBridge.ts";

export function startBridge() {
  if (!process.env.PLATFORM_BRIDGE_TOKEN || !process.env.PLATFORM_ATTEMPT_ID) {
    process.stderr.write("platform bridge refused to start: missing per-run credentials\n");
    process.exit(1);
  }
  serveStdio({
    tools: bridgeToolsFor(process.env.PLATFORM_MODE || "analysis"),
    framing: "content-length",
    async call(name, args) {
      const env = await envFromDatabase({
        runId: Number(process.env.PLATFORM_RUN_ID),
        stepId: Number(process.env.PLATFORM_STEP_ID),
        attemptId: Number(process.env.PLATFORM_ATTEMPT_ID),
      });
      return dispatchPlatformTool(name, args, env);
    },
  });
}

if (process.argv[1]?.endsWith("bridge.ts")) startBridge();
