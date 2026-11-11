import { isAbsolute, resolve } from "node:path";
import { decide, type Decision, type PolicyContext } from "../toolPolicy.ts";

/**
 * Pre-execution policy for Codex. Codex runs a PreToolUse hook (learn.chatgpt.com/docs/hooks) before shell commands
 * (tool_name Bash / exec_command), apply_patch file edits and MCP tools; the hook asks the worker, which answers with the
 * same decide() Claude's PreToolUse hook uses. A deny stops the call before it runs.
 *
 * The OS sandbox is the second layer (read-only for analysis; workspace-write limited to the task directory for coding),
 * so a missing or crashing hook cannot widen what the process can write.
 *
 * Unknown tools are denied (fail closed). Escalation requests (PermissionRequest) are always denied: the platform never
 * lets a command leave the sandbox; commits go through the platform's commit_changes tool instead.
 */

export interface CodexHookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
  [k: string]: unknown;
}

/** Native tools that only read or only touch Codex' own plan state. */
const HARMLESS = new Set(["update_plan", "todo_write", "view_image", "write_stdin"]);
/** Shell tool names across Codex releases. */
const SHELL = new Set([
  "bash",
  "shell",
  "local_shell",
  "exec_command",
  "unified_exec",
  "container.exec",
  "shell_command",
]);
const PATCH = new Set(["apply_patch", "edit", "write", "multiedit"]);
/** Never read these through the shell, even though the sandbox allows reads: Codex credentials and the per-attempt broker. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /auth\.json|\.codex(\/|\b)|CODEX_HOME/i,
    "Codex credentials and configuration are not readable by workflow steps",
  ],
  [
    /PLATFORM_BROKER|ctp-codex-|\/proc\/[^\s]*\/(environ|cmdline)/i,
    "the platform's per-attempt broker is not accessible to workflow steps",
  ],
  [
    /(^|[\s'"/=])\.env(\.[\w-]+)?(\s|$|['"])/,
    "environment files may contain credentials and are not readable by workflow steps",
  ],
];

export function shellCommandText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const c = o.command ?? o.cmd ?? o.script;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts = c.map(String);
    // ["bash", "-lc", "<script>"] → the script is what runs.
    if (
      parts.length >= 3 &&
      /(^|\/)(ba|z)?sh$/.test(parts[0]) &&
      /^-l?c$|^-c$|^-lc$/.test(parts[1])
    )
      return parts.slice(2).join(" ");
    return parts.join(" ");
  }
  return "";
}

/** Files an apply_patch envelope touches: Add/Update/Delete File and Move to targets. Relative paths resolve against cwd. */
export function patchPaths(patch: string, cwd: string): string[] {
  const out: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const m = line.match(/^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/);
    if (m) out.push(isAbsolute(m[1]) ? resolve(m[1]) : resolve(cwd, m[1]));
  }
  return out;
}

function patchText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["command", "patch", "input", "content"]) {
    const v = o[k];
    if (typeof v === "string" && v.includes("*** ")) return v;
    if (Array.isArray(v)) {
      const s = v.map(String).find((x) => x.includes("*** Begin Patch"));
      if (s) return s;
    }
  }
  return "";
}

const deny = (reason: string): Decision => ({ allow: false, reason });

export function codexHookDecision(
  payload: CodexHookPayload,
  policy: PolicyContext,
  sessionCwd: string,
): Decision {
  const event = String(payload.hook_event_name ?? "");
  if (event === "PermissionRequest")
    return deny(
      "the platform never grants sandbox escalation; work inside the worktree and commit with mcp__platform__commit_changes",
    );
  if (event !== "PreToolUse") return { allow: true };
  const tool = String(payload.tool_name ?? "");
  const lower = tool.toLowerCase();
  const input = payload.tool_input;
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const workdir =
    typeof obj.workdir === "string" && obj.workdir
      ? resolve(sessionCwd, obj.workdir)
      : typeof payload.cwd === "string" && payload.cwd
        ? payload.cwd
        : sessionCwd;

  if (tool.startsWith("mcp__")) {
    // Platform tools are authorized again inside the broker (attempt lease, mode, open questions).
    if (tool.startsWith("mcp__platform__")) return decide(tool, obj, policy, workdir);
    return deny(`MCP server tool ${tool} is not part of this workflow step`);
  }
  if (SHELL.has(lower)) {
    const command = shellCommandText(input);
    if (!command.trim()) return deny("empty or unreadable shell command");
    for (const [re, why] of SECRET_PATTERNS) if (re.test(command)) return deny(why);
    return decide("Bash", { command }, policy, workdir);
  }
  if (PATCH.has(lower)) {
    if (policy.mode !== "coding")
      return deny("this step is read-only; file edits happen in a coding step");
    const direct =
      typeof obj.file_path === "string"
        ? [resolve(workdir, obj.file_path)]
        : typeof obj.path === "string"
          ? [resolve(workdir, obj.path)]
          : [];
    const paths = direct.length ? direct : patchPaths(patchText(input), workdir);
    if (!paths.length)
      return deny(
        "cannot determine which files this edit touches; use apply_patch with explicit file paths",
      );
    for (const p of paths) {
      const d = decide("Write", { file_path: p }, policy, workdir);
      if (!d.allow) return d;
    }
    return { allow: true };
  }
  if (HARMLESS.has(lower))
    return decide(
      lower === "view_image" ? "Read" : lower === "write_stdin" ? "Bash" : "TodoWrite",
      {},
      policy,
      workdir,
    );
  if (
    lower === "spawn_agent" ||
    lower.includes("subagent") ||
    lower === "send_input" ||
    lower === "wait_agent"
  )
    return deny(
      "delegation to Codex subagents is not supported by the platform policy for this provider",
    );
  return deny(`tool ${tool || "(unnamed)"} is not allowed in workflow steps`);
}
