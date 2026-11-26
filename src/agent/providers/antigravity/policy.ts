import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendGitInfoExclude,
  evaluateHookToolDecision,
  writePrivateJson,
  type HookPayload,
} from "../../hookPolicy.ts";
import type { Decision, PolicyContext } from "../../toolPolicy.ts";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /antigravity-oauth-token|\.gemini(\/|\b)/i,
    "Antigravity credentials and configuration are not readable by workflow steps",
  ],
];

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

export function antigravityHookDecision(
  payload: HookPayload | null | undefined,
  policy: PolicyContext,
  sessionCwd: string,
): Decision {
  return evaluateHookToolDecision(payload, policy, sessionCwd, {
    providerSecretPatterns: SECRET_PATTERNS,
    sanitizeText: withoutBrainStepOutputs,
    subagentDenialReason: "Subagents are not permitted for this provider under platform security policy",
  });
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
  writePrivateJson(mcpConfigPath, mcpConfig);

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
  appendGitInfoExclude(gitDir, [".agents/hooks.json", ".agents/mcp_config.json"]);
}
