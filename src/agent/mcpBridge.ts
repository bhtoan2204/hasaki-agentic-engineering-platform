import { CONTEXT_TOOLS } from "./contextToolSchemas.ts";
import { z } from "zod";
/**
 * Stdio MCP server core shared by the CLI providers' per-run bridges (Cursor: cursor/bridge.ts, Codex: codex/bridge.ts).
 * It is not a network service. Each bridge supplies how a tool call is executed; the platform tools themselves live in
 * platformTools.ts (dispatchPlatformTool), so every provider gets the same lease, fencing and ownership checks.
 */

export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const PLATFORM_BRIDGE_TOOLS: BridgeTool[] = [
  { name: "ask_user", description: "Post questions to the developer and STOP. The step waits for answers; do not keep editing or call other tools.", inputSchema: { type: "object", properties: { questions: { type: "array", minItems: 1, items: { type: "object", properties: { question: { type: "string" }, context: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question"] } } }, required: ["questions"] } },
  { name: "post_update", description: "Post a short progress note to the platform timeline.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "submit_result", description: "Submit this step's output (an object matching the step's output contract) once, at the end.", inputSchema: { type: "object", properties: { output: { type: "object" } }, required: ["output"] } },
  { name: "prepare_branch", description: "Create or reuse the run branch for a repo in an isolated git worktree and return its path. Coding steps only.", inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
  { name: "read_knowledge", description: "Read the full text of a skill, business rule or reference doc by key.", inputSchema: { type: "object", properties: { key: { type: "string" }, offset: { type: "integer", minimum: 0, maximum: 1000000 }, limit: { type: "integer", minimum: 1, maximum: 24000 } }, required: ["key"] } },
  { name: "search_knowledge", description: "Search the skills, business rules and reference docs that apply to this step.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
  { name: "read_step_output", description: "Read the full output of an earlier step of this run.", inputSchema: { type: "object", properties: { step_key: { type: "string" }, attempt: { type: "number" } }, required: ["step_key"] } },
  { name: "list_tools", description: "Discover domain integration tools (Hasaki Work, Jira, Bitbucket, repository registry, run history).", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "describe_tool", description: "Full description and input schema of an integration tool.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "call_tool", description: "Call an integration tool by name with arguments matching its schema.", inputSchema: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name"] } },
];

/** Codex only: its sandbox keeps .git read-only, so commits are made by the platform inside the run's worktree. */
export const COMMIT_TOOL: BridgeTool = {
  name: "commit_changes",
  description: "Commit your changes in a run worktree (git add + commit, made by the platform because .git is read-only in your sandbox). Coding steps only. Optional paths limits what is staged (relative to the worktree).",
  inputSchema: { type: "object", properties: { repo: { type: "string" }, message: { type: "string" }, paths: { type: "array", items: { type: "string" } } }, required: ["repo", "message"] },
};

export function bridgeToolsFor(mode: string, opts: { commit?: boolean } = {}): BridgeTool[] {
  const nativeNames = new Set(CONTEXT_TOOLS.map(t => t.name));
  const all = [...PLATFORM_BRIDGE_TOOLS.filter(t => !nativeNames.has(t.name)), ...CONTEXT_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.input) }))];
  const base = mode === "coding" ? all : all.filter((t) => t.name !== "prepare_branch");
  return mode === "coding" && opts.commit ? [...base, COMMIT_TOOL] : base;
}

export interface StdioBridgeOptions {
  tools: BridgeTool[];
  call(name: string, args: unknown): Promise<string>;
  /**
   * How replies are framed. "content-length" always uses LSP-style headers (the Cursor bridge's historical behavior);
   * "auto" answers in the framing the request used (newline-delimited JSON for MCP stdio clients such as Codex).
   */
  framing: "content-length" | "auto";
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export function serveStdio(opts: StdioBridgeOptions) {
  const input: NodeJS.ReadableStream = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const send = (msg: unknown, lined: boolean) => {
    const json = JSON.stringify(msg);
    if (opts.framing === "auto" && lined) {
      output.write(json + "\n");
      return;
    }
    const body = Buffer.from(json, "utf8");
    output.write(`Content-Length: ${body.length}\r\n\r\n`);
    output.write(body);
  };

  const onMessage = async (msg: any, lined: boolean) => {
    if (!msg || msg.jsonrpc !== "2.0" || msg.id == null) return;
    try {
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "platform", version: "1.0.0" } } }, lined);
        return;
      }
      if (msg.method === "tools/list") {
        send({ jsonrpc: "2.0", id: msg.id, result: { tools: opts.tools } }, lined);
        return;
      }
      if (msg.method === "ping") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} }, lined);
        return;
      }
      if (msg.method === "tools/call") {
        const name = String(msg.params?.name ?? "");
        if (!opts.tools.some((t) => t.name === name)) {
          send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `ERROR: unknown platform tool ${name}` }], isError: true } }, lined);
          return;
        }
        const text = await opts.call(CONTEXT_TOOLS.some(t => t.name === name) ? `platform.${name}` : name, msg.params?.arguments ?? {});
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], isError: text.startsWith("ERROR:") } }, lined);
        return;
      }
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } }, lined);
    } catch (e) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: (e as Error).message } }, lined);
    }
  };

  let buf = Buffer.alloc(0);
  input.on("data", (chunk: Buffer | string) => {
    buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
    if (buf.length > 1024 * 1024) { buf = Buffer.alloc(0); return; }
    for (; ;) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd >= 0 && buf.subarray(0, headerEnd).toString("utf8").toLowerCase().includes("content-length")) {
        const header = buf.subarray(0, headerEnd).toString("utf8");
        const m = header.match(/content-length:\s*(\d+)/i);
        if (!m) {
          buf = buf.subarray(headerEnd + 4);
          continue;
        }
        const len = Number(m[1]);
        if (len > 1024 * 1024) { buf = Buffer.alloc(0); return; }
        const start = headerEnd + 4;
        if (buf.length < start + len) return;
        const body = buf.subarray(start, start + len).toString("utf8");
        buf = buf.subarray(start + len);
        try {
          void onMessage(JSON.parse(body), false);
        } catch {
          /* ignore a single bad frame */
        }
        continue;
      }
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = buf.subarray(0, nl).toString("utf8").trim();
      buf = buf.subarray(nl + 1);
      if (!line || line.toLowerCase().startsWith("content-length")) continue;
      if (line.startsWith("{")) {
        try {
          void onMessage(JSON.parse(line), true);
        } catch {
          /* ignore */
        }
      }
    }
  });
}
