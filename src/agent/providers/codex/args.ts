import { join } from "node:path";
import { nativeCompactionThreshold } from "../../../context/compaction.ts";
import { npmCacheDir } from "../../../git/provider.ts";
import { advertisedContextTools } from "../../contextToolSchemas.ts";
import { bridgeCapabilityEnv } from "../../mcpBridge.ts";
import type { ToolMode } from "../../toolPolicy.ts";

export const toml = (v: unknown): string => {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(toml).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)}=${toml(x)}`)
      .join(",")}}`;
  return '""';
};

export const DISABLED_FEATURES = [
  "multi_agent",
  "multi_agent_v2",
  "apps",
  "plugins",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "image_generation",
  "goals",
  "memories",
  "in_app_browser",
];

/** Native context tools (search_code, get_symbol, find_dependencies, …) are exposed by the bridge: allow them too, or
 * Codex can never use code intelligence and falls back to whole-repository shell scans. */
const platformToolNames = () => [
  ...new Set([
    "ask_user",
    "post_update",
    "submit_result",
    "prepare_branch",
    "commit_changes",
    "read_knowledge",
    "search_knowledge",
    "read_step_output",
    "list_tools",
    "describe_tool",
    "call_tool",
    ...advertisedContextTools().map((t) => t.name),
  ]),
];

// Computed per call: an optional capability (CodeAct) follows the configuration at invocation time.
export const codexEnabledTools = (mode: ToolMode) =>
  mode === "coding"
    ? platformToolNames()
    : platformToolNames().filter((t) => t !== "prepare_branch" && t !== "commit_changes");

export interface CodexInvocation {
  mode: ToolMode;
  cwd: string;
  scratch: string;
  /** Exact worktree paths authorized by the worker's tool policy for this turn. */
  workspaces?: readonly string[];
  model?: string;
  effort?: string;
  resumeId?: string;
}

/** Full argv for one Codex turn. Pure (unit-tested). The prompt is passed on stdin ("-"). */
export function codexArgs(inv: CodexInvocation): string[] {
  const node = process.execPath;
  const hook = `${JSON.stringify(node)} --disable-warning=ExperimentalWarning ${JSON.stringify(join(import.meta.dirname, "hook.ts"))}`;
  const hookCfg = [
    { hooks: [{ type: "command", command: hook, timeout: 120, statusMessage: "platform policy" }] },
  ];
  const coding = inv.mode === "coding";
  const cfg: Array<[string, unknown]> = [
    ["sandbox_mode", coding ? "workspace-write" : "read-only"],
    ["approval_policy", "never"],
    ["web_search", "disabled"],
  ];
  // Coding stays inside the native write sandbox. The worker runs infrastructure verification after submission.
  cfg.push(
    ["sandbox_workspace_write.network_access", false],
    ["sandbox_workspace_write.writable_roots", coding ? [...new Set(inv.workspaces ?? [])] : []],
  );
  cfg.push(
    ["shell_environment_policy.inherit", "all"],
    ["shell_environment_policy.ignore_default_excludes", false],
    [
      "shell_environment_policy.exclude",
      ["PLATFORM_*", "DATABASE_URL", "AUTH_SECRET", "*_API_KEY"],
    ],
    [
      "shell_environment_policy.set",
      {
        TMPDIR: inv.scratch,
        GOCACHE: join(inv.scratch, "go-build"),
        GOTMPDIR: inv.scratch,
        npm_config_cache: npmCacheDir(),
        XDG_CACHE_HOME: join(inv.scratch, "cache"),
      },
    ],
    ["hooks.SessionStart", hookCfg],
    ["hooks.PreToolUse", hookCfg],
    ["hooks.PermissionRequest", hookCfg],
    ["mcp_servers.platform.command", node],
    [
      "mcp_servers.platform.args",
      ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "bridge.ts")],
    ],
    ["mcp_servers.platform.env", { PLATFORM_MODE: inv.mode, ...bridgeCapabilityEnv() }],
    ["mcp_servers.platform.env_vars", ["PLATFORM_BROKER_SOCKET", "PLATFORM_BROKER_TOKEN"]],
    ["mcp_servers.platform.required", true],
    ["mcp_servers.platform.startup_timeout_sec", 30],
    ["mcp_servers.platform.tool_timeout_sec", 1800],
    ["mcp_servers.platform.enabled_tools", codexEnabledTools(inv.mode)],
    ["mcp_servers.platform.default_tools_approval_mode", "approve"],
  );
  if (inv.model) cfg.push(["model", inv.model]);
  if (inv.effort) cfg.push(["model_reasoning_effort", inv.effort]);
  const native = nativeCompactionThreshold("codex", inv.model);
  if (native) cfg.push(["model_auto_compact_token_limit", native.tokens]);
  const flags = [
    "--json",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--dangerously-bypass-hook-trust",
    "--skip-git-repo-check",
  ];
  for (const f of DISABLED_FEATURES) flags.push("--disable", f);
  for (const [k, v] of cfg) flags.push("-c", `${k}=${toml(v)}`);
  // --last is never used: a worker runs many attempts at once, so resume always names the stored thread id.
  return inv.resumeId
    ? ["exec", "resume", ...flags, inv.resumeId, "-"]
    : ["exec", ...flags, "-C", inv.cwd, "-"];
}
