import { chmodSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { decide, type Decision, type PolicyContext } from "./toolPolicy.ts";

export interface HookPayload {
  toolCall?: { name?: unknown; args?: unknown };
  tool_call?: { name?: unknown; args?: unknown };
  tool_name?: unknown;
  name?: unknown;
  tool_input?: unknown;
  args?: unknown;
  hook_event_name?: unknown;
}

export interface HookPolicyConfig {
  providerSecretPatterns: ReadonlyArray<readonly [RegExp, string]>;
  sanitizeText?: (text: string) => string;
  subagentDenialReason: string;
}

const SHARED_SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /PLATFORM_BROKER|ctp-codex-|ctp-agy-|ctp-copilot-|\/proc\/[^\s]*\/(environ|cmdline)/i,
    "the platform's per-attempt broker is not accessible to workflow steps",
  ],
  [
    /(^|[\s'"/=*])\.env(\.[\w-]+)?(\s|$|['"])/,
    "environment files may contain credentials and are not readable by workflow steps",
  ],
];

const deny = (reason: string): Decision => ({ allow: false, reason });

function secretDenial(text: string, cfg: HookPolicyConfig): string | null {
  if (!text) return null;
  const visible = cfg.sanitizeText ? cfg.sanitizeText(text) : text;
  for (const [re, why] of [...cfg.providerSecretPatterns, ...SHARED_SECRET_PATTERNS]) {
    if (re.test(visible)) return why;
  }
  return null;
}

function firstString(args: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return "";
}

/**
 * Shared PreToolUse decision evaluator for hook-based providers (Antigravity, Copilot).
 * Maps provider native tool names onto canonical `decide()` tools so `ToolLoopDetector`,
 * `toolBudget`, secret path rules, and coding worktree boundaries apply uniformly.
 */
export function evaluateHookToolDecision(
  payload: HookPayload | null | undefined,
  policy: PolicyContext,
  sessionCwd: string,
  cfg: HookPolicyConfig,
): Decision {
  const toolCall = payload?.toolCall ?? payload?.tool_call;
  const toolName = String(toolCall?.name ?? payload?.tool_name ?? payload?.name ?? "");
  const args = (toolCall?.args ?? payload?.tool_input ?? payload?.args ?? {}) as Record<
    string,
    unknown
  >;
  const lower = toolName.toLowerCase();

  if (payload?.hook_event_name === "PreInvocation" && !toolName) return { allow: true };

  // 1. MCP Platform tools
  if (
    lower.startsWith("platform_") ||
    lower.startsWith("platform.") ||
    lower.startsWith("mcp__platform__") ||
    lower.startsWith("mcp_platform_")
  ) {
    const canonicalName = lower.replace(
      /^(mcp__platform__|mcp_platform_|platform\.|platform_)/,
      "",
    );
    if (!canonicalName) return deny("empty platform tool name");
    return decide(`mcp__platform__${canonicalName}`, args, policy, sessionCwd);
  }

  // The CLI wraps platform tools as call_mcp_tool. The broker still fences and authorizes the inner call.
  if (lower === "call_mcp_tool" || lower === "mcptool") return { allow: true };

  // 2. Subagents restriction
  if (lower.includes("subagent")) return deny(cfg.subagentDenialReason);

  // 3. Web search restriction
  if (lower.includes("search_web") || lower === "web_search")
    return deny("Web search is disabled by platform execution policy");

  // 4. Shell commands
  if (lower === "run_command" || lower === "bash" || lower === "exec_command") {
    const cmd = firstString(args, ["CommandLine", "command", "cmd"]);
    if (!cmd) return deny("empty shell command");
    const secret = secretDenial(cmd, cfg);
    if (secret) return deny(secret);
    return decide("Bash", { command: cmd }, policy, sessionCwd);
  }

  // 5. File modifications (write_file -> Write, edit_file -> Edit)
  if (lower === "write_file" || lower === "edit_file") {
    if (policy.mode !== "coding") {
      return deny(`Tool ${toolName} is only allowed in coding steps (analysis mode is read-only)`);
    }
    const filePath = firstString(args, ["Path", "path", "file_path", "TargetFile"]);
    if (!filePath) return deny("empty file path");
    const secret = secretDenial(filePath, cfg);
    if (secret) return deny(secret);
    const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(sessionCwd, filePath);
    if (resolved.includes("/.git/"))
      return deny("modifying .git internal files directly is forbidden; use commit_changes");
    return decide(
      lower === "edit_file" ? "Edit" : "Write",
      { file_path: resolved },
      policy,
      sessionCwd,
    );
  }

  // 6. File reading
  if (lower === "read_file" || lower === "view_file") {
    const filePath = firstString(args, ["Path", "path", "file_path", "TargetFile"]);
    const secret = secretDenial(filePath, cfg);
    if (secret) return deny(secret);
    return decide("Read", { path: filePath }, policy, sessionCwd);
  }

  // 7. Workspace inspection tools routed through decide() for loop, budget, and secret-path enforcement
  const inspectTool: Record<string, "LS" | "Glob" | "Grep"> = {
    list_dir: "LS",
    glob: "Glob",
    grep: "Grep",
    search_files: "Grep",
  };
  const canonicalInspect = inspectTool[lower];
  if (canonicalInspect) {
    const rawPath = firstString(args, [
      "DirectoryPath",
      "SearchPath",
      "Path",
      "path",
      "dir",
      "directory",
      "file_path",
    ]);
    const extraTarget = firstString(args, ["Pattern", "pattern", "Query", "query", "includes"]);
    const pathSecret = secretDenial(rawPath, cfg) ?? secretDenial(extraTarget, cfg);
    if (pathSecret) return deny(pathSecret);
    const resolved = rawPath
      ? isAbsolute(rawPath)
        ? resolve(rawPath)
        : resolve(sessionCwd, rawPath)
      : "";
    return decide(
      canonicalInspect,
      {
        ...(resolved ? { path: resolved } : {}),
        ...(extraTarget ? { pattern: extraTarget } : {}),
      },
      policy,
      sessionCwd,
    );
  }

  return decide(toolName, args, policy, sessionCwd);
}

/** Writes JSON to disk with owner-only `0600` permissions (mkdir parent as needed). */
export function writePrivateJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

/** Removes directories only if empty; leaves non-empty or missing directories untouched. */
export function removeEmptyDirs(...dirs: string[]): void {
  for (const dir of dirs) {
    try {
      rmdirSync(dir);
    } catch {
      /* ignore missing or non-empty dirs */
    }
  }
}

/** Appends platform config entries into `<gitDir>/info/exclude` idempotently. */
export function appendGitInfoExclude(gitDir: string, entries: readonly string[]): void {
  const exclude = `${gitDir}/info/exclude`;
  mkdirSync(dirname(exclude), { recursive: true });
  let cur = "";
  try {
    cur = readFileSync(exclude, "utf8");
  } catch {
    /* ignore: missing exclude file starts empty */
  }
  let added = false;
  for (const line of entries) {
    if (!cur.includes(line)) {
      cur += (cur.endsWith("\n") || !cur ? "" : "\n") + line + "\n";
      added = true;
    }
  }
  if (added) writeFileSync(exclude, cur);
}
