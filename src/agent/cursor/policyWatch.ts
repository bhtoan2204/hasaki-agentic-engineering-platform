import { decide, isInside, type PolicyContext } from "../toolPolicy.ts";
import { toolCallShape } from "./stream.ts";

/**
 * Map a Cursor native tool event onto the same decision the Claude hook uses.
 * MCP platform tools are authorized inside the bridge, not here.
 * A write or shell that the policy rejects must kill the process: the CLI has already started the tool
 * by the time the event is printed, so the step is failed and the process tree is killed.
 */
export function cursorToolDecision(
  toolCall: Record<string, unknown> | undefined,
  policy: PolicyContext,
  cwd: string,
): { allow: true } | { allow: false; reason: string; tool: string } {
  const shape = toolCallShape(toolCall);
  if (!shape) return { allow: true };
  const native = nativeName(shape.name);
  if (!native) return { allow: true };
  const input = toolInput(native, shape.body);
  if (native === "Bash" && /mcp\.json|PLATFORM_BRIDGE|cli\.json/i.test(String(input.command ?? "")))
    return { allow: false, reason: "reading the per-run bridge configuration is not allowed", tool: native };
  const d = decide(native, input, policy, cwd);
  return d.allow ? { allow: true } : { allow: false, reason: d.reason, tool: native };
}

function nativeName(name: string): string | null {
  const n = name.toLowerCase();
  if (n === "read" || n === "grep" || n === "glob") return n === "read" ? "Read" : n === "grep" ? "Grep" : "Glob";
  if (n === "write" || n === "edit" || n === "strreplace" || n === "delete") return "Write";
  if (n === "shell" || n === "bash") return "Bash";
  if (n.startsWith("mcp") || n === "function") return null;
  return null;
}

function toolInput(native: string, body: any): Record<string, unknown> {
  const args = body?.args ?? body ?? {};
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return native === "Bash" ? { command: args } : { path: args };
    }
  }
  if (native === "Bash") return { command: String(args.command ?? args.cmd ?? "") };
  if (native === "Grep") return { pattern: args.pattern ?? args.query ?? "", path: args.path };
  if (native === "Glob") return { pattern: args.glob_pattern ?? args.pattern ?? args.glob ?? "", path: args.path ?? args.target_directory };
  const path = args.path ?? args.file_path ?? args.target_file ?? "";
  return { file_path: path, path };
}

/** A write path must sit inside a worktree the run actually owns. Prompt text and cwd are not enough. */
export function writeOutsideWorktrees(path: string, workspaces: string[]): boolean {
  if (!path) return false;
  return !isInside(path, workspaces);
}
