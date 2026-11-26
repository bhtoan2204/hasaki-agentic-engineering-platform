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
    /github-copilot|\.config[/\\]github-copilot/i,
    "GitHub Copilot credentials and configuration are not readable by workflow steps",
  ],
];

export function copilotHookDecision(
  payload: HookPayload | null | undefined,
  policy: PolicyContext,
  sessionCwd: string,
): Decision {
  return evaluateHookToolDecision(payload, policy, sessionCwd, {
    providerSecretPatterns: SECRET_PATTERNS,
    subagentDenialReason: "Subagents are not permitted for this provider under platform security policy",
  });
}

export function writeCopilotWorkspaceConfig(
  workspace: string,
  opts: {
    brokerSocket: string;
    brokerToken: string;
    mode: string;
    /** External directory (scratchDir) for MCP config so broker credentials stay out of worktrees. */
    mcpDir?: string;
  },
): { hookConfigPath: string; mcpConfigPath: string; githubHookPath: string } {
  const agentsDir = join(workspace, ".agents");
  mkdirSync(agentsDir, { recursive: true });

  const hookScript = join(import.meta.dirname, "hook.ts");
  const bridgeScript = join(import.meta.dirname, "bridge.ts");
  const node = process.execPath;

  const hookCommand = `${JSON.stringify(node)} --disable-warning=ExperimentalWarning ${JSON.stringify(hookScript)}`;
  // Legacy named hooks (kept for the fake CLI / older agy-compatible probes).
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

  // Copilot CLI 1.0+ loads Claude-compatible hooks from .github/hooks/*.json.
  const githubHooksDir = join(workspace, ".github", "hooks");
  mkdirSync(githubHooksDir, { recursive: true });
  const githubHooks = {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: hookCommand, timeout: 60 }],
      },
    ],
    SessionStart: [{ type: "command", command: `${hookCommand} --telemetry`, timeout: 10 }],
  };
  const githubHookPath = join(githubHooksDir, "ctp-platform.json");
  writeFileSync(githubHookPath, JSON.stringify(githubHooks, null, 2));

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
  const mcpConfigPath = join(opts.mcpDir ?? agentsDir, "mcp_config.json");
  writePrivateJson(mcpConfigPath, mcpConfig);

  return { hookConfigPath, mcpConfigPath, githubHookPath };
}

export function excludeFromGit(gitDir: string) {
  appendGitInfoExclude(gitDir, [".agents/hooks.json", ".github/hooks/ctp-platform.json"]);
}
