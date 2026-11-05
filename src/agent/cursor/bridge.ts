/**
 * Per-run MCP server Cursor CLI spawns over stdio. It is not a network service.
 * The token and attempt ids come from the process environment written into the run's .cursor/mcp.json
 * and removed when the agent process exits. Every tool call re-checks the attempt lease.
 */
import { dispatchPlatformTool, envFromDatabase } from "../platformTools.ts";

const TOOLS = [
  { name: "ask_user", description: "Post questions and stop. The step waits for the developer; do not keep editing.", inputSchema: { type: "object", properties: { questions: { type: "array", items: { type: "object", properties: { question: { type: "string" }, context: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question"] } } }, required: ["questions"] } },
  { name: "post_update", description: "Post a short progress note.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "submit_result", description: "Submit the step output object once, at the end.", inputSchema: { type: "object", properties: { output: { type: "object" } }, required: ["output"] } },
  { name: "prepare_branch", description: "Create the run branch in an isolated worktree. Coding steps only.", inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
  { name: "read_knowledge", description: "Read a knowledge item by key.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "search_knowledge", description: "Search knowledge available to this step.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
  { name: "read_step_output", description: "Read an upstream step output.", inputSchema: { type: "object", properties: { step_key: { type: "string" }, attempt: { type: "number" } }, required: ["step_key"] } },
  { name: "list_tools", description: "List integration tools.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "describe_tool", description: "Describe one integration tool.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "call_tool", description: "Call an integration tool.", inputSchema: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name"] } },
];

function toolsForMode(mode: string) {
  return mode === "coding" ? TOOLS : TOOLS.filter((t) => t.name !== "prepare_branch");
}

function send(msg: unknown) {
  const json = JSON.stringify(msg);
  const body = Buffer.from(json, "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

async function onMessage(msg: any) {
  if (!msg || msg.jsonrpc !== "2.0") return;
  if (msg.id == null) return;
  try {
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "platform", version: "1.0.0" } } });
      return;
    }
    if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: toolsForMode(process.env.PLATFORM_MODE || "analysis") } });
      return;
    }
    if (msg.method === "tools/call") {
      const name = String(msg.params?.name ?? "");
      const args = msg.params?.arguments ?? {};
      const env = await envFromDatabase({
        runId: Number(process.env.PLATFORM_RUN_ID),
        stepId: Number(process.env.PLATFORM_STEP_ID),
        attemptId: Number(process.env.PLATFORM_ATTEMPT_ID),
      });
      const text = await dispatchPlatformTool(name, args, env);
      const isError = text.startsWith("ERROR:");
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], isError } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: (e as Error).message } });
  }
}

export function startBridge() {
  if (!process.env.PLATFORM_BRIDGE_TOKEN || !process.env.PLATFORM_ATTEMPT_ID) {
    process.stderr.write("platform bridge refused to start: missing per-run credentials\n");
    process.exit(1);
  }
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd >= 0 && buf.subarray(0, headerEnd).toString("utf8").toLowerCase().includes("content-length")) {
        const header = buf.subarray(0, headerEnd).toString("utf8");
        const m = header.match(/content-length:\s*(\d+)/i);
        if (!m) {
          buf = buf.subarray(headerEnd + 4);
          continue;
        }
        const len = Number(m[1]);
        const start = headerEnd + 4;
        if (buf.length < start + len) return;
        const body = buf.subarray(start, start + len).toString("utf8");
        buf = buf.subarray(start + len);
        try {
          void onMessage(JSON.parse(body));
        } catch {
          /* ignore a single bad frame */
        }
        continue;
      }
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = buf.subarray(0, nl).toString("utf8").trim();
      buf = buf.subarray(nl + 1);
      if (!line || line.startsWith("Content-Length") || line === "") continue;
      if (line.startsWith("{")) {
        try {
          void onMessage(JSON.parse(line));
        } catch {
          /* ignore */
        }
      }
    }
  });
}

if (process.argv[1]?.endsWith("bridge.ts")) startBridge();
