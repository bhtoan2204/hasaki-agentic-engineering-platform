import { agentEnvironment } from "../environment.ts";
import { nativeCompactionThreshold } from "../../context/compaction.ts";
import { execution } from "../../auth/execution.ts";
import { execFile, type ExecFileException } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { codexConfig } from "../../config.ts";
import { superviseSpawn, supervisionNote } from "../process/supervisor.ts";
import { npmCacheDir } from "../../git/provider.ts";
import type { ExecutionContext } from "../../workflow/executors/registry.ts";
import { addUsage, newMetrics, noteToolUse, type AgentMetrics } from "../metrics.ts";
import { advertisedContextTools } from "../contextToolSchemas.ts";
import { bridgeCapabilityEnv } from "../mcpBridge.ts";
import type { PolicyContext, ToolMode } from "../toolPolicy.ts";
import { startBroker, type Broker } from "../broker/server.ts";
import {
  classifyCodexError,
  codexMetricUsage,
  codexProgress,
  failureMessage,
  JsonlStream,
  type CodexEvent,
  type CodexFailureKind,
  type CodexItem,
} from "./stream.ts";
import type { CompletionStreamListener } from "../completionStream.ts";
import { codexHookDecision } from "./policy.ts";
import {
  adoptRunWorkspaces,
  checkpointMark,
  readSubmitted,
  stopFailure,
  superviseTurn,
  turnLimits,
  type StopReason,
} from "../harness/cliTurn.ts";
import type { HarnessFailureCode } from "../harness/failure.ts";

const exec = promisify(execFile);

/**
 * OpenAI Codex CLI adapter (`codex exec --json`, `codex exec resume <thread_id>`).
 *
 * Execution policy, per invocation and never in the user's ~/.codex:
 *  - --ignore-user-config / --ignore-rules / --strict-config: only the platform's -c overrides apply; unknown keys fail.
 *  - OS sandbox: read-only for analysis. Coding runs workspace-write with network disabled so local
 *    PostgreSQL sockets and the test suite can run. .git stays read-only to the tool policy, so commits go through
 *    the platform's commit_changes tool.
 *  - approval_policy = never. PermissionRequest is denied by the platform hook as well.
 *  - PreToolUse hook → worker decide(): forbidden commands, edits outside worktrees, unknown tools and subagents are
 *    denied BEFORE they run. --dangerously-bypass-hook-trust is required because Codex skips hooks it has not persisted
 *    trust for; the only hooks loaded are the platform's own (user config is ignored). It does not bypass the sandbox
 *    or approvals.
 *  - Features that would leave the policy (multi-agent, apps, plugins, browser/computer use, web search) are disabled.
 * Auth: the worker's own `codex login` (CODEX_HOME). The platform never reads auth.json and strips API-key variables,
 * so an exhausted ChatGPT plan is reported as a quota failure instead of silently billing an API key.
 */

export interface CodexCapability {
  ok: boolean;
  bin: string;
  version?: string;
  /** Text after "Logged in using", e.g. "ChatGPT". Never a credential. */
  auth?: string;
  kind?: "missing" | "unsupported" | "auth" | "model";
  error?: string;
  models?: Array<{ slug: string; efforts: string[]; default_effort?: string }>;
}

const REQUIRED_EXEC_FLAGS = [
  "--json",
  "--strict-config",
  "--ignore-user-config",
  "--ignore-rules",
  "--dangerously-bypass-hook-trust",
  "--skip-git-repo-check",
  "--config",
];
const REQUIRED_RESUME_FLAGS = [
  "--json",
  "--strict-config",
  "--ignore-user-config",
  "--ignore-rules",
  "--dangerously-bypass-hook-trust",
  "--config",
];
const NO_FALLBACK = "The platform will not fall back to Claude or another provider.";

let capCache: { key: string; at: number; value: CodexCapability } | null = null;

/** Environment for every Codex child: no platform secrets, no API keys (no silent switch to API billing). */
export function codexEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const out = agentEnvironment(base, "codex");
  if (execution.getStore()?.evaluation?.fixtureAgent) {
    for (const k of Object.keys(out)) if (k.startsWith("FAKE_CODEX_")) delete out[k];
    out.FAKE_CODEX_MODE = "ok";
  }
  return { ...out, ...extra };
}

async function run(bin: string, args: string[], timeout = 20_000) {
  return exec(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: codexEnv(process.env) });
}

/**
 * Probe the installed CLI without calling a model: version, required flags, login status (`codex login status`),
 * and the model catalog (`codex debug models`) to validate the configured model and reasoning effort.
 */
export async function codexCapabilities(
  force = false,
  selection?: { model: string; effort: string },
): Promise<CodexCapability> {
  const cfg = {
    ...codexConfig(),
    ...(selection ? { model: selection.model, reasoningEffort: selection.effort } : {}),
  };
  const key = `${cfg.bin}\u0000${cfg.model}\u0000${cfg.reasoningEffort}`;
  if (!force && capCache && capCache.key === key && Date.now() - capCache.at < 5 * 60_000)
    return capCache.value;
  const value = await probe(cfg.bin, cfg.model, cfg.reasoningEffort);
  capCache = { key, at: Date.now(), value };
  return value;
}

async function probe(bin: string, model: string, effort: string): Promise<CodexCapability> {
  let version = "";
  try {
    const v = await run(bin, ["--version"]);
    version = `${v.stdout}`.trim().split("\n")[0] ?? "";
  } catch (caught) {
    const e = caught as ExecFileException;
    if (e?.code === "ENOENT")
      return {
        ok: false,
        bin,
        kind: "missing",
        error: `Codex CLI was not found (${bin}). Install it on the worker (npm i -g @openai/codex) or set agent.codex.bin / CODEX_BIN, then run \`codex login\`. ${NO_FALLBACK}`,
      };
    return {
      ok: false,
      bin,
      kind: "missing",
      error: `Codex CLI (${bin}) failed to start: ${String(e?.stderr || e?.message || e).slice(0, 300)}. ${NO_FALLBACK}`,
    };
  }
  try {
    const help = await run(bin, ["exec", "--help"]);
    const text = `${help.stdout}\n${help.stderr}`;
    for (const f of REQUIRED_EXEC_FLAGS)
      if (!text.includes(f))
        return {
          ok: false,
          bin,
          version,
          kind: "unsupported",
          error: `${version || bin}: \`codex exec\` does not support ${f}, which the platform needs to enforce its execution policy. Upgrade the Codex CLI. ${NO_FALLBACK}`,
        };
    const rhelp = await run(bin, ["exec", "resume", "--help"]);
    const rtext = `${rhelp.stdout}\n${rhelp.stderr}`;
    for (const f of REQUIRED_RESUME_FLAGS)
      if (!rtext.includes(f))
        return {
          ok: false,
          bin,
          version,
          kind: "unsupported",
          error: `${version || bin}: \`codex exec resume\` does not support ${f}. Upgrade the Codex CLI. ${NO_FALLBACK}`,
        };
  } catch (caught) {
    const e = caught as ExecFileException;
    return {
      ok: false,
      bin,
      version,
      kind: "unsupported",
      error: `${version || bin}: could not read \`codex exec --help\`: ${String(e?.stderr || e?.message || e).slice(0, 300)}. ${NO_FALLBACK}`,
    };
  }
  let auth = "";
  try {
    const st = await run(bin, ["login", "status"]);
    const body = `${st.stdout}\n${st.stderr}`;
    const m = body.match(/logged in using (.+)/i);
    if (!m)
      return {
        ok: false,
        bin,
        version,
        kind: "auth",
        error: `Codex CLI on this worker is not logged in. Run \`codex login\` on the worker machine. ${NO_FALLBACK}`,
      };
    auth = m[1].trim().slice(0, 60);
  } catch (caught) {
    const e = caught as ExecFileException;
    return {
      ok: false,
      bin,
      version,
      kind: "auth",
      error: `Codex CLI on this worker is not logged in (${String(
        e?.stdout || e?.stderr || e?.message || "",
      )
        .trim()
        .split("\n")[0]
        .slice(0, 200)}). Run \`codex login\` on the worker machine. ${NO_FALLBACK}`,
    };
  }
  const models = await modelCatalog(bin);
  const cap: CodexCapability = { ok: true, bin, version, auth, models: models ?? undefined };
  const problem = models ? checkModel(models, model, effort) : null;
  if (problem) return { ...cap, ok: false, kind: "model", error: `${problem} ${NO_FALLBACK}` };
  return cap;
}

interface CatalogModel {
  slug: string;
  supported_reasoning_levels?: unknown;
  default_reasoning_level?: unknown;
}

async function modelCatalog(bin: string): Promise<CodexCapability["models"] | null> {
  try {
    const r = await run(bin, ["debug", "models"], 30_000);
    const d = JSON.parse(r.stdout);
    const list: unknown[] = Array.isArray(d) ? d : Array.isArray(d?.models) ? d.models : [];
    return list
      .filter(
        (m): m is CatalogModel => typeof (m as Partial<CatalogModel> | null)?.slug === "string",
      )
      .map((m) => ({
        slug: m.slug,
        efforts: Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels
              .map((x: unknown) => String((x as { effort?: unknown } | null)?.effort ?? x))
              .filter(Boolean)
          : [],
        default_effort:
          typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : undefined,
      }));
  } catch {
    return null; // catalog unavailable: the CLI reports an unsupported model when the turn starts
  }
}

/** Null when the model (empty = account default) and effort are in the catalog. */
export function checkModel(
  models: NonNullable<CodexCapability["models"]>,
  model: string,
  effort: string,
): string | null {
  if (!models.length) return null;
  const m = model ? models.find((x) => x.slug === model) : null;
  if (model && !m)
    return `Codex model "${model}" is not available to the worker's Codex account (available: ${models.map((x) => x.slug).join(", ")}).`;
  if (effort && m && m.efforts.length && !m.efforts.includes(effort))
    return `Codex model "${model}" does not support reasoning effort "${effort}" (supported: ${m.efforts.join(", ")}).`;
  if (effort && !m && !models.some((x) => x.efforts.includes(effort)))
    return `Reasoning effort "${effort}" is not supported by any Codex model available to this account.`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------

const toml = (v: unknown): string => {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(toml).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)}=${toml(x)}`)
      .join(",")}}`;
  return '""';
};

const DISABLED_FEATURES = [
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

export interface CodexTurnInput {
  ctx: ExecutionContext;
  mode: ToolMode;
  policy: PolicyContext;
  cwd: string;
  prompt: string;
  metrics: AgentMetrics;
  invocationId?: string;
  onTelemetry?: (error?: unknown) => Promise<void>;
  model?: string;
  effort?: string;
  resumeId?: string;
}

export interface CodexTurnResult {
  isError: boolean;
  text: string;
  assistantTurns: number;
  submitted?: Record<string, unknown>;
  failure?: CodexFailureKind | "policy" | "incomplete" | HarnessFailureCode;
  threadId?: string;
}

export async function codexAgentTurn(input: CodexTurnInput): Promise<CodexTurnResult> {
  const { ctx, metrics } = input;
  const turnMark = await checkpointMark(ctx.attempt.id);
  const cap = await codexCapabilities(false, {
    model: input.model ?? "",
    effort: input.effort ?? "",
  });
  if (!cap.ok)
    return {
      isError: true,
      text: cap.error || "Codex CLI is not usable",
      assistantTurns: 0,
      failure: cap.kind === "model" ? "model" : cap.kind === "auth" ? "auth" : "error",
    };
  if (input.policy.delegation)
    return {
      isError: true,
      text: `Codex runs cannot enforce the platform's read-only subagent policy. Disable delegation on the step, or create the run with Claude. ${NO_FALLBACK}`,
      assistantTurns: 0,
      failure: "policy",
    };
  const modelProblem = cap.models
    ? checkModel(cap.models, input.model ?? "", input.effort ?? "")
    : null;
  if (modelProblem)
    return {
      isError: true,
      text: `${modelProblem} ${NO_FALLBACK}`,
      assistantTurns: 0,
      failure: "model",
    };
  mkdirSync(input.cwd, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "ctp-agent-tmp-"));
  const { dispatchPlatformTool, envFromExecution } = await import("../platformTools.ts");
  let submitted: Record<string, unknown> | undefined;
  let paused = false;
  let actualModel = "";
  const toolEnv = envFromExecution(ctx, input.mode, input.policy, metrics, (o) => (submitted = o));
  // After ask_user the step waits: no further edits or state-changing commands until the engine resumes with answers.
  const livePolicy = new Proxy(input.policy, {
    get: (t, k) => (k === "mode" && paused ? "analysis" : Reflect.get(t, k)),
  });
  const activity = { touch: () => {} };
  let broker: Broker;
  try {
    broker = await startBroker({
      onActivity: () => activity.touch(),
      policy: livePolicy,
      cwd: input.cwd,
      decideHook: codexHookDecision,
      async dispatch(name, args) {
        const text = await dispatchPlatformTool(name, args, toolEnv);
        if (
          ["ask_user", "request_clarification", "platform.request_clarification"].includes(name) &&
          !text.startsWith("ERROR")
        )
          paused = true;
        return text;
      },
      onModel(m) {
        if (m !== actualModel) {
          actualModel = m;
          metrics.model = m;
          void ctx.log("system", `Codex model in use: ${m}`, { provider: "codex", model: m });
        }
      },
      async onDenied(tool, reason) {
        metrics.denied.push({ tool, reason });
        await ctx.log("tool", `denied ${tool}: ${reason}`, { provider: "codex" });
      },
    });
  } catch (e) {
    rmSync(scratch, { recursive: true, force: true });
    return {
      isError: true,
      text: `could not start the platform broker: ${(e as Error).message}`,
      assistantTurns: 0,
      failure: "error",
    };
  }

  const args = codexArgs({
    mode: input.mode,
    cwd: input.cwd,
    scratch,
    workspaces: input.policy.workspaces,
    model: input.model,
    effort: input.effort,
    resumeId: input.resumeId,
  });
  const limits = turnLimits(input.ctx.attempt.effective_agent, codexConfig().timeoutMs);
  // Codex is stopped at once (no grace), as before; its MCP bridge and hook helpers go with it.
  const proc = superviseSpawn({
    command: cap.bin,
    args,
    cwd: input.cwd,
    env: codexEnv(process.env, {
      PLATFORM_BROKER_SOCKET: broker.socketPath,
      PLATFORM_BROKER_TOKEN: broker.token,
    }),
    class: "agent",
    graceMs: 0,
    timeoutMs: limits.timeoutMs + 60_000,
    runId: ctx.run.id,
    attemptId: ctx.attempt.id,
  });
  const child = proc.child;
  let stopReason: "" | StopReason | "policy" = "";
  let violation = "";
  const stop = (why: StopReason | "policy") => {
    if (!stopReason) stopReason = why;
    proc.stop();
  };
  const watch = superviseTurn({ signal: ctx.signal, ...limits, stop });
  activity.touch = () => watch.touch();
  child.stdin?.on("error", () => {});
  child.stdin?.end(input.prompt);

  const parser = new JsonlStream();
  let stderr = "";
  let threadId = "";
  let assistantTurns = 0;
  let lastText = "";
  let completed = false;
  let failedMsg = "";
  const errors: string[] = [];
  const started = Date.now();

  const seenItems = new Set<string>();
  const onItem = async (type: string, item: CodexItem) => {
    const eventKey = `${type}:${item.id}`;
    if (item.id && seenItems.has(eventKey)) return;
    if (item.id) seenItems.add(eventKey);
    const toolId = `${input.invocationId ?? ctx.attempt.id}:${item.id}`;
    const toolish =
      item.type === "command_execution" ||
      item.type === "file_change" ||
      item.type === "mcp_tool_call";
    if (toolish && type === "item.started" && broker.hookCalls === 0) {
      violation =
        "Codex started a tool without running the platform's pre-execution hook; the run was stopped";
      metrics.denied.push({ tool: item.type, reason: violation });
      stop("policy");
      return;
    }
    if (type !== "item.completed" && !(type === "item.started" && toolish)) return;
    switch (item.type) {
      case "agent_message":
        if (item.text?.trim()) {
          assistantTurns++;
          lastText = item.text;
          await ctx.log("agent", item.text, { provider: "codex", item_id: item.id });
        }
        break;
      case "reasoning":
        if (item.text?.trim())
          await ctx.log("thinking", item.text, { provider: "codex", item_id: item.id });
        break;
      case "command_execution":
        if (type === "item.started") {
          metrics.tool_calls.shell = (metrics.tool_calls.shell ?? 0) + 1;
          await ctx.log("tool", `shell ${String(item.command ?? "").slice(0, 300)}`, {
            provider: "codex",
            item_id: item.id,
            name: "shell",
            id: toolId,
            input: { command: item.command },
          });
        } else {
          const failed =
            item.status === "failed" ||
            (typeof item.exit_code === "number" && item.exit_code !== 0);
          if (failed) metrics.tool_errors++;
          await ctx.log(
            "tool_result",
            String(item.aggregated_output ?? "").slice(-30_000) ||
              `(exit ${item.exit_code ?? "?"})`,
            {
              provider: "codex",
              item_id: item.id,
              tool_use_id: toolId,
              exit_code: item.exit_code ?? null,
              is_error: failed,
            },
          );
        }
        break;
      case "file_change":
        if (type === "item.started") {
          metrics.tool_calls.apply_patch = (metrics.tool_calls.apply_patch ?? 0) + 1;
          await ctx.log(
            "tool",
            `apply_patch ${(item.changes ?? [])
              .map((c) => `${c.kind} ${c.path}`)
              .join(", ")
              .slice(0, 300)}`,
            {
              provider: "codex",
              item_id: item.id,
              name: "apply_patch",
              id: toolId,
              input: { changes: item.changes },
            },
          );
        } else {
          const failed = item.status === "failed";
          if (failed) metrics.tool_errors++;
          await ctx.log(
            "tool_result",
            failed ? "patch failed" : `${(item.changes ?? []).length} file(s) changed`,
            { provider: "codex", item_id: item.id, tool_use_id: toolId, is_error: failed },
          );
        }
        break;
      case "mcp_tool_call": {
        const name = `mcp__${item.server ?? "?"}__${item.tool ?? "?"}`;
        if (type === "item.started") {
          metrics.tool_calls[name] = (metrics.tool_calls[name] ?? 0) + 1;
          noteToolUse(metrics, name, item.arguments ?? null);
          await ctx.log("tool", `${name} ${JSON.stringify(item.arguments ?? {}).slice(0, 300)}`, {
            provider: "codex",
            item_id: item.id,
            id: toolId,
            name,
            input: item.arguments ?? null,
          });
        } else {
          const failed = item.status === "failed" || !!item.error;
          if (failed) metrics.tool_errors++;
          await ctx.log(
            "tool_result",
            JSON.stringify(item.error ?? item.result ?? "").slice(0, 30_000),
            { provider: "codex", item_id: item.id, tool_use_id: toolId, is_error: failed },
          );
        }
        break;
      }
      case "error":
        if (item.message) errors.push(item.message);
        await ctx.log("system", `Codex: ${item.message ?? "error"}`, {
          provider: "codex",
          item_id: item.id,
        });
        break;
      case "todo_list":
      case "web_search":
        await ctx.log("system", `Codex ${item.type}`, { provider: "codex", item: item.raw });
        break;
      default:
        await ctx.log("system", `Codex item ${item.type} (not interpreted)`, {
          provider: "codex",
          item: item.raw,
        });
    }
  };

  const handle = async (ev: CodexEvent) => {
    switch (ev.type) {
      case "thread.started":
        if (threadId === ev.thread_id) break;
        threadId = ev.thread_id;
        metrics.sessions++;
        await ctx.recordSession(ev.thread_id, input.cwd, input.model || "", "codex");
        await ctx.log(
          "system",
          `Codex thread ${ev.thread_id} ${input.resumeId ? "resumed" : "started"}${input.model ? ` (model ${input.model})` : " (Codex account default model)"}`,
          {
            provider: "codex",
            session_id: ev.thread_id,
            model: input.model || null,
            effort: input.effort || null,
          },
        );
        break;
      case "turn.started":
        break;
      case "turn.completed":
        if (completed) break;
        completed = true;
        metrics.turns++;
        if (ev.usage) {
          addUsage(metrics, codexMetricUsage(ev.usage));
        }
        await input.onTelemetry?.();
        break;
      case "turn.failed":
        failedMsg = ev.message;
        await input.onTelemetry?.(ev.raw);
        await ctx.log("system", `Codex turn failed: ${ev.message}`, { provider: "codex" });
        break;
      case "error":
        errors.push(ev.message);
        await input.onTelemetry?.(ev.raw);
        await ctx.log("system", `Codex error: ${ev.message}`, { provider: "codex" });
        break;
      case "unknown":
        await ctx.log("system", `Codex event ${ev.name} (not interpreted)`, {
          provider: "codex",
          event: ev.raw,
        });
        break;
      default:
        await onItem(ev.type, ev.item);
    }
  };

  let pending = Promise.resolve();
  const consume = (chunk: Buffer) => {
    watch.touch();
    const { events, errors: bad } = parser.push(chunk);
    pending = pending.then(async () => {
      for (const b of bad)
        await ctx.log("system", `Codex stream: malformed line (${b.error})`, {
          provider: "codex",
          line: b.line,
        });
      for (const ev of events) await handle(ev);
    });
  };
  const exitCode = await new Promise<number | null>((resolve) => {
    child.stdout?.on("data", consume);
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    child.on("error", (e) => {
      stderr += e.message;
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
  watch.dispose();
  const supervision = await proc.done; // helpers (MCP bridge, hooks) that outlived Codex are gone too
  const supervisionLine = supervisionNote(supervision);
  if (supervisionLine) await ctx.log("system", supervisionLine, { provider: "codex", supervision });
  const tail = parser.flush();
  await pending;
  for (const b of tail.errors)
    await ctx.log("system", `Codex stream: malformed line (${b.error})`, {
      provider: "codex",
      line: b.line,
    });
  for (const ev of tail.events) await handle(ev);
  await broker.close().catch(() => {});
  rmSync(scratch, { recursive: true, force: true });

  metrics.duration_ms += Date.now() - started;
  metrics.cost_usd = null; // ChatGPT plan usage has no per-call price; never invent one
  if (actualModel) metrics.model = actualModel;
  await adoptRunWorkspaces(ctx.run.id, input.policy);
  if (stderr.trim())
    await ctx.log("log", redact(stderr.trim()).slice(-4000), {
      provider: "codex",
      stream: "stderr",
    });

  submitted = submitted ?? (await readSubmitted(ctx.attempt.id, turnMark));
  const base = { assistantTurns, submitted, threadId: threadId || undefined };

  const stopped = stopReason as string;
  if (stopped === "canceled" || ctx.signal.aborted)
    return { ...base, isError: true, ...stopFailure("canceled", "Codex", limits) };
  if (stopped === "timeout" || stopped === "idle")
    return { ...base, isError: true, ...stopFailure(stopped, "Codex", limits) };
  if (violation)
    return {
      ...base,
      isError: true,
      assistantTurns: Math.max(assistantTurns, 1),
      text: `Codex blocked by platform policy: ${violation}`,
      failure: "UNSAFE_SIDE_EFFECT",
    };
  const detail = failedMsg || errors.at(-1) || "";
  if (failedMsg || (!completed && (errors.length || exitCode !== 0))) {
    const kind = classifyCodexError(`${detail}\n${stderr}`);
    return {
      ...base,
      isError: true,
      text: failureMessage(
        kind,
        detail || lastLine(stderr) || `Codex exited ${exitCode ?? "unknown"}`,
      ),
      failure: kind,
    };
  }
  if (!completed)
    return {
      ...base,
      isError: true,
      text: `Codex exited ${exitCode ?? "unknown"} without completing the turn${stderr.trim() ? `: ${lastLine(stderr)}` : ""}`,
      failure: "incomplete",
    };
  if (exitCode !== 0) {
    const kind = classifyCodexError(`${detail}\n${stderr}`);
    return {
      ...base,
      isError: true,
      text: failureMessage(kind, detail || lastLine(stderr) || `Codex exited ${exitCode}`),
      failure: kind,
    };
  }
  return { ...base, isError: false, text: lastText };
}

function lastLine(s: string) {
  return redact(s.trim().split("\n").filter(Boolean).at(-1) ?? "").slice(0, 500);
}

/** Never let a token-looking string from CLI stderr reach the transcript. */
export function redact(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, "$1[redacted]")
    .replace(/\b(sk|rt|sess)-[A-Za-z0-9_-]{12,}/g, "$1-[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted-jwt]");
}

/**
 * One-shot text completion for auxiliary calls of a Codex run (ranking, report, test-failure explanation). Read-only
 * sandbox in an empty temp directory, no platform tools, ephemeral session. Returns the final agent message.
 */
export async function codexComplete(
  prompt: string,
  opts: {
    signal?: AbortSignal;
    model?: string;
    effort?: string;
    timeoutMs?: number;
    onStream?: CompletionStreamListener;
  } = {},
): Promise<{ text: string; tokens: AgentMetrics["tokens"]; model: string }> {
  const cfg = codexConfig();
  const cap = await codexCapabilities(false, {
    model: opts.model ?? cfg.model,
    effort: opts.effort ?? cfg.reasoningEffort,
  });
  if (!cap.ok) throw new Error(cap.error);
  opts.signal?.throwIfAborted();
  const dir = mkdtempSync(join(tmpdir(), "ctp-codex-complete-"));
  const model = opts.model ?? cfg.model;
  const effort = opts.effort ?? cfg.reasoningEffort;
  const args = [
    "exec",
    "--json",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--ephemeral",
  ];
  for (const f of DISABLED_FEATURES) args.push("--disable", f);
  for (const [k, v] of [
    ["sandbox_mode", "read-only"],
    ["approval_policy", "never"],
    ["web_search", "disabled"],
    ...(model ? [["model", model]] : []),
    ...(effort ? [["model_reasoning_effort", effort]] : []),
  ] as Array<[string, unknown]>)
    args.push("-c", `${k}=${toml(v)}`);
  args.push("-C", dir, "-");
  const proc = superviseSpawn({
    command: cap.bin,
    args,
    cwd: dir,
    env: codexEnv(process.env),
    class: "agent",
    graceMs: 0,
  });
  const child = proc.child;
  const kill = () => proc.stop();
  opts.signal?.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(kill, Math.min(opts.timeoutMs ?? cfg.timeoutMs, 10 * 60_000));
  child.stdin?.on("error", () => {});
  child.stdin?.end(
    `${prompt}\n\nReply with the requested text only. Do not run commands or modify files.`,
  );
  const parser = new JsonlStream();
  const events: CodexEvent[] = [];
  let stderr = "";
  const code = await new Promise<number | null>((resolve) => {
    child.stdout?.on("data", (b: Buffer) => {
      const fresh = parser.push(b).events;
      events.push(...fresh);
      for (const ev of fresh) {
        const p = opts.onStream && codexProgress(ev);
        if (p) opts.onStream!(p);
      }
    });
    child.stderr?.on("data", (b: Buffer) => (stderr = (stderr + b.toString("utf8")).slice(-8000)));
    child.on("error", () => resolve(null));
    child.on("close", (c) => resolve(c));
  });
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", kill);
  await proc.done;
  events.push(...parser.flush().events);
  rmSync(dir, { recursive: true, force: true });
  if (opts.signal?.aborted) throw new Error("canceled");
  let text = "";
  let done = false;
  let fail = "";
  let lastError = "";
  const usageMetrics = newMetrics(model || "");
  for (const ev of events) {
    if (ev.type === "item.completed" && ev.item.type === "agent_message" && ev.item.text)
      text = ev.item.text;
    else if (ev.type === "turn.completed") {
      done = true;
      if (ev.usage) {
        addUsage(usageMetrics, codexMetricUsage(ev.usage));
      }
    } else if (ev.type === "turn.failed") fail = ev.message;
    else if (ev.type === "error") lastError = ev.message;
  }
  if (fail || !done || code !== 0) {
    const detail =
      fail ||
      lastError ||
      lastLine(stderr) ||
      `Codex exited ${code ?? "unknown"} without completing`;
    throw new Error(failureMessage(classifyCodexError(`${detail}\n${stderr}`), detail));
  }
  if (!text.trim()) throw new Error("Codex text completion returned no message");
  return { text, tokens: usageMetrics.tokens, model: model || "" };
}
