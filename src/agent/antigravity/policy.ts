import { isAbsolute, resolve, join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { decide, type Decision, type PolicyContext } from "../toolPolicy.ts";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /antigravity-oauth-token|\.gemini(\/|\b)/i,
    "Antigravity credentials and configuration are not readable by workflow steps",
  ],
  [
    /PLATFORM_BROKER|ctp-codex-|ctp-agy-|\/proc\/[^\s]*\/(environ|cmdline)/i,
    "the platform's per-attempt broker is not accessible to workflow steps",
  ],
  [
    /(^|[\s'"/=])\.env(\.[\w-]+)?(\s|$|['"])/,
    "environment files may contain credentials and are not readable by workflow steps",
  ],
];

const deny = (reason: string): Decision => ({ allow: false, reason });

/**
 * The CLI writes an oversized tool result under its brain directory and then reads that file back.
 * That path is scratch for the current turn, not the OAuth token or settings under ~/.gemini.
 */
function withoutBrainStepOutputs(text: string): string {
  return text.replace(
    /(?:~|[/\\][\w.@+-]+)*[/\\]\.gemini[/\\]antigravity-cli[/\\]brain[/\\][0-9a-f-]{36}[/\\]\.system_generated[/\\]steps[/\\]\d+[/\\]output\.txt/gi,
    " ",
  );
}

function secretDenial(text: string): string | null {
  const visible = withoutBrainStepOutputs(text);
  for (const [re, why] of SECRET_PATTERNS) if (re.test(visible)) return why;
  return null;
}

export function antigravityHookDecision(
  payload: any,
  policy: PolicyContext,
  sessionCwd: string,
): Decision {
  const toolCall = payload?.toolCall ?? payload?.tool_call;
  const toolName = String(toolCall?.name ?? payload?.tool_name ?? payload?.name ?? "");
  const args = (toolCall?.args ?? payload?.tool_input ?? payload?.args ?? {}) as Record<
    string,
    unknown
  >;
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
  if (lower === "write_file" || lower === "edit_file") {
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
    return decide(toolName, { path: resolved }, policy, sessionCwd);
  }

  // 6. File reading (read_file, view_file)
  if (lower === "read_file" || lower === "view_file") {
    const filePath = String(args.Path ?? args.path ?? "");
    const secret = secretDenial(filePath);
    if (secret) return deny(secret);
    return decide("Read", { path: filePath }, policy, sessionCwd);
  }

  // 7. Harmless read-only inspection tools
  if (["list_dir", "glob", "grep", "search_files"].includes(lower)) {
    return { allow: true };
  }

  return decide(toolName, args, policy, sessionCwd);
}

export function writeAntigravityWorkspaceConfig(
  workspace: string,
  opts: {
    brokerSocket: string;
    brokerToken: string;
    mode: string;
  },
): { hookConfigPath: string; mcpConfigPath: string } {
  const agentsDir = join(workspace, ".agents");
  mkdirSync(agentsDir, { recursive: true });

  const hookScript = join(import.meta.dirname, "hook.ts");
  const bridgeScript = join(import.meta.dirname, "bridge.ts");
  const node = process.execPath;

  const hookCommand = `${JSON.stringify(node)} --disable-warning=ExperimentalWarning ${JSON.stringify(hookScript)}`;
  // Named hooks only. A top-level PreToolUse array is not a hook spec, and agy
  // then refuses the whole file, so the platform policy never loads.
  const hooksConfig = {
    "platform-model": {
      enabled: true,
      PreInvocation: [{ type: "command", command: `${hookCommand} --telemetry`, timeout: 10 }],
    },
    "platform-security": {
      enabled: true,
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: hookCommand,
              timeout: 60,
            },
          ],
        },
      ],
    },
  };
  const hookConfigPath = join(agentsDir, "hooks.json");
  writeFileSync(hookConfigPath, JSON.stringify(hooksConfig, null, 2));

  const mcpConfig = {
    mcpServers: {
      platform: {
        command: node,
        args: ["--disable-warning=ExperimentalWarning", bridgeScript],
        env: {
          PLATFORM_MODE: opts.mode,
          PLATFORM_BROKER_SOCKET: opts.brokerSocket,
          PLATFORM_BROKER_TOKEN: opts.brokerToken,
        },
      },
    },
  };
  const mcpConfigPath = join(agentsDir, "mcp_config.json");
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

  return { hookConfigPath, mcpConfigPath };
}

/** Session-only settings for headless print mode.
 * request-review soft-denies every tool confirmation (ReadFile, then McpTool), so the
 * turn ends before submit_result. always-proceed approves that CLI prompt; the platform
 * PreToolUse hook and the broker still allow or refuse each call. */
export function antigravityHeadlessSettings(toolNames: readonly string[]) {
  const names = [...new Set(toolNames.filter(Boolean))].sort();
  return {
    toolPermission: "always-proceed",
    permissions: {
      allow: ["mcp(platform/*)", ...names.map((name) => `mcp(platform/${name})`)],
    },
  };
}

export function excludeFromGit(gitDir: string) {
  const exclude = join(gitDir, "info", "exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  let cur = "";
  try {
    cur = readFileSync(exclude, "utf8");
  } catch {}
  const lines = [".agents/hooks.json", ".agents/mcp_config.json"];
  let added = false;
  for (const line of lines) {
    if (!cur.includes(line)) {
      cur += (cur.endsWith("\n") || !cur ? "" : "\n") + line + "\n";
      added = true;
    }
  }
  if (added) writeFileSync(exclude, cur);
}
