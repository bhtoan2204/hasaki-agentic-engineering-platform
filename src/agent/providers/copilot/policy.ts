import { isAbsolute, resolve, join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { decideNativeInspection } from "../../nativeInspection.ts";
import { decide, type Decision, type PolicyContext } from "../../toolPolicy.ts";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /github-copilot|\.config[/\\]github-copilot/i,
    "GitHub Copilot credentials and configuration are not readable by workflow steps",
  ],
  [
    /PLATFORM_BROKER|ctp-codex-|ctp-copilot-|\/proc\/[^\s]*\/(environ|cmdline)/i,
    "the platform's per-attempt broker is not accessible to workflow steps",
  ],
  [
    /(^|[\s'"/=])\.env(\.[\w-]+)?(\s|$|['"])/,
    "environment files may contain credentials and are not readable by workflow steps",
  ],
];

const deny = (reason: string): Decision => ({ allow: false, reason });

/** The native hook payload carries toolArgs as an object or as a JSON string. */
function hookArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function secretDenial(text: string): string | null {
  for (const [re, why] of SECRET_PATTERNS) if (re.test(text)) return why;
  return null;
}

export function copilotHookDecision(
  payload: Record<string, unknown> | null | undefined,
  policy: PolicyContext,
  sessionCwd: string,
): Decision {
  const toolCall = (payload?.toolCall ?? payload?.tool_call) as Record<string, unknown> | undefined;
  const toolName = String(
    toolCall?.name ?? payload?.toolName ?? payload?.tool_name ?? payload?.name ?? "",
  );
  const args = hookArgs(
    toolCall?.args ?? payload?.toolArgs ?? payload?.tool_input ?? payload?.args,
  );
  const lower = toolName.toLowerCase();
  // This metadata hook carries the actual model even when the provider never calls a tool.
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
    // decide() allows mcp__platform__* before its name switch. The bare name falls through to deny,
    // which blocked read_artifact even though the broker would have served it.
    return decide(`mcp__platform__${canonicalName}`, args, policy, sessionCwd);
  }

  // The CLI wraps platform tools as call_mcp_tool. The broker still fences and authorizes the inner call.
  if (lower === "call_mcp_tool" || lower === "mcptool") return { allow: true };

  // 2. Subagents restriction
  if (lower.includes("subagent")) {
    return deny("Subagents are not permitted for this provider under platform security policy");
  }

  // 3. Web search restriction
  if (lower.includes("search_web") || lower === "web_search") {
    return deny("Web search is disabled by platform execution policy");
  }

  // 4. Shell commands (run_command)
  if (lower === "run_command" || lower === "bash" || lower === "exec_command") {
    const cmd = String(args.CommandLine ?? args.command ?? args.cmd ?? "");
    if (!cmd.trim()) return deny("empty shell command");
    const secret = secretDenial(cmd);
    if (secret) return deny(secret);
    return decide("Bash", { command: cmd }, policy, sessionCwd);
  }

  // 5. File modifications (write_file, edit_file)
  if (["write_file", "edit_file", "edit", "create"].includes(lower)) {
    if (policy.mode !== "coding") {
      return deny(`Tool ${toolName} is only allowed in coding steps (analysis mode is read-only)`);
    }
    const filePath = String(args.Path ?? args.path ?? "");
    if (!filePath.trim()) return deny("empty file path");
    const secret = secretDenial(filePath);
    if (secret) return deny(secret);
    const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(sessionCwd, filePath);
    // Ensure path doesn't escape into sensitive roots
    if (resolved.includes("/.git/"))
      return deny("modifying .git internal files directly is forbidden; use commit_changes");
    return decide(
      lower === "edit_file" || lower === "edit" ? "Edit" : "Write",
      { file_path: resolved },
      policy,
      sessionCwd,
    );
  }

  // 6. File reading (read_file, view_file)
  if (lower === "read_file" || lower === "view_file" || lower === "view") {
    const filePath = String(args.Path ?? args.path ?? "");
    const secret = secretDenial(filePath);
    if (secret) return deny(secret);
    return decide("Read", { path: filePath }, policy, sessionCwd);
  }

  // 7. Harmless read-only inspection tools
  const inspection = decideNativeInspection(lower, args, policy, sessionCwd, secretDenial);
  if (inspection) return inspection;

  return decide(toolName, args, policy, sessionCwd);
}

/**
 * Hooks live in the worktree (the CLI loads them from .github/hooks once the folder is trusted for the session); the
 * MCP server config goes to `mcpDir`, outside the worktree, and carries no broker credentials: the bridge inherits
 * PLATFORM_BROKER_SOCKET and PLATFORM_BROKER_TOKEN from the CLI process environment.
 */
export function writeCopilotWorkspaceConfig(
  workspace: string,
  opts: {
    mcpDir: string;
    mode: string;
  },
): { mcpConfigPath: string; githubHookPath: string } {
  const hookScript = join(import.meta.dirname, "hook.ts");
  const bridgeScript = join(import.meta.dirname, "bridge.ts");
  const node = process.execPath;

  const hookCommand = `${JSON.stringify(node)} --disable-warning=ExperimentalWarning ${JSON.stringify(hookScript)}`;
  // Copilot CLI 1.0.113 loads .github/hooks/*.json in this schema (version 1, camelCase events, bash command);
  // a Claude-style PreToolUse array there is ignored.
  const githubHooksDir = join(workspace, ".github", "hooks");
  mkdirSync(githubHooksDir, { recursive: true });
  const githubHooks = {
    version: 1,
    hooks: {
      preToolUse: [{ type: "command", bash: hookCommand, timeoutSec: 60 }],
      sessionStart: [{ type: "command", bash: `${hookCommand} --telemetry`, timeoutSec: 10 }],
    },
  };
  const githubHookPath = join(githubHooksDir, "ctp-platform.json");
  writeFileSync(githubHookPath, JSON.stringify(githubHooks, null, 2));

  const mcpConfig = {
    mcpServers: {
      platform: {
        command: node,
        args: ["--disable-warning=ExperimentalWarning", bridgeScript],
        env: { PLATFORM_MODE: opts.mode },
      },
    },
  };
  const mcpConfigPath = join(opts.mcpDir, "mcp_config.json");
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });

  return { mcpConfigPath, githubHookPath };
}

/** Removes what writeCopilotWorkspaceConfig put in the worktree, and the directories it created if they are now empty. */
export function removeCopilotWorkspaceConfig(workspace: string) {
  rmSync(join(workspace, ".github", "hooks", "ctp-platform.json"), { force: true });
  for (const dir of [join(".github", "hooks"), ".github"]) {
    try {
      rmdirSync(join(workspace, dir));
    } catch {
      /* ignore: not empty or already gone */
    }
  }
}

export function excludeFromGit(gitDir: string) {
  const exclude = join(gitDir, "info", "exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  let cur = "";
  try {
    cur = readFileSync(exclude, "utf8");
  } catch {
    /* ignore */
  }
  const lines = [".github/hooks/ctp-platform.json"];
  let added = false;
  for (const line of lines) {
    if (!cur.includes(line)) {
      cur += (cur.endsWith("\n") || !cur ? "" : "\n") + line + "\n";
      added = true;
    }
  }
  if (added) writeFileSync(exclude, cur);
}
