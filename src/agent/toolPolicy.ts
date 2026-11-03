import { resolve, sep } from "node:path";

/**
 * Explicit tool policy for unattended agent steps, enforced in code (PreToolUse hook + canUseTool), not by
 * prompt instructions. Replaces the old `bypassPermissions` + short deny-list.
 *
 *  analysis (agent):        read anywhere, read-only shell allowlist, no file edits.
 *  coding (coding_agent):   edits only inside the run's worktrees; shell minus destructive git / rm -rf / push.
 */
export type ToolMode = "analysis" | "coding";

const BASE_TOOLS = ["Read", "Grep", "Glob", "Bash", "TodoWrite", "WebFetch", "WebSearch"];
/**
 * Native tools per step. `Task`/`Agent` (subagents) only when the step opts into delegation; `Skill` only when Claude
 * Code settings layers are loaded (otherwise skills come exclusively from the platform registry via read_knowledge).
 */
export const toolsFor = (mode: ToolMode, opts: { delegation?: boolean; claudeSkills?: boolean } = {}) => [
  ...BASE_TOOLS,
  ...(opts.claudeSkills ? ["Skill"] : []),
  ...(opts.delegation ? ["Task", "Agent"] : []),
  ...(mode === "coding" ? ["Edit", "Write", "NotebookEdit"] : []),
];

/** Platform tools a subagent may use: read-only ones. */
export const SUBAGENT_PLATFORM_TOOLS = ["read_knowledge", "search_knowledge", "read_step_output", "list_tools", "describe_tool", "call_tool"].map((t) => `mcp__platform__${t}`);

export interface PolicyContext {
  mode: ToolMode;
  /** Absolute worktree paths the step may edit. */
  workspaces: string[];
  baseBranch: string;
  /** Primary checkouts (reposRoot): readable, never modifiable — neither by Edit/Write nor by shell commands. */
  protectedRoots?: string[];
  /** The step allows subagent delegation (Task/Agent). */
  delegation?: boolean;
  /** For call_tool from subagents: is the named integration tool read-only? */
  isReadOnlyIntegration?: (name: string) => boolean;
}

export type Decision = { allow: true } | { allow: false; reason: string };
const allow: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

export function isInside(path: string, roots: string[]) {
  const p = resolve(path);
  return roots.some((r) => {
    const root = resolve(r);
    return p === root || p.startsWith(root + sep);
  });
}

const ALWAYS_DENIED: Array<[RegExp, string]> = [
  [/\bgit\s+(-C\s+\S+\s+)?push\b/, "pushing is done by the platform's pull request step"],
  [/\bgit\s+(-C\s+\S+\s+)?reset\s+--hard\b/, "git reset --hard is not allowed"],
  [/\bgit\s+(-C\s+\S+\s+)?clean\b/, "git clean is not allowed"],
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, "rm -rf is not allowed"],
  [/\bgit\s+(-C\s+\S+\s+)?worktree\s+(remove|prune)\b/, "worktrees are managed by the platform"],
  [/\bgit\s+(-C\s+\S+\s+)?branch\s+-[dD]\b/, "deleting branches is not allowed"],
  [/\bsudo\b/, "sudo is not allowed"],
  [/\bgit\s+(-C\s+\S+\s+)?(restore|stash)\b/, "do not discard or stash existing changes; edit them deliberately"],
  [/\bgit\s+(-C\s+\S+\s+)?checkout\s+(--\s|\.(\s|$))/, "do not discard existing changes with git checkout --"],
];

// First word(s) of each pipeline segment allowed in analysis steps.
const READ_ONLY = [
  /^(ls|cat|head|tail|wc|grep|rg|find|tree|file|stat|pwd|echo|sort|uniq|cut|tr|jq|diff|basename|dirname|realpath|which|date)\b/,
  /^sed\s+-n\b/,
  /^awk\b(?!.*system\()/,
  /^git\s+(-C\s+\S+\s+)?(log|show|diff|status|blame|branch|rev-parse|ls-files|ls-tree|grep|cat-file|merge-base|describe|remote\s+-v|fetch)\b/,
  /^go\s+(list|doc|version|env|vet)\b/,
  /^(node|npm)\s+(-v|--version|ls)\b/,
];

/** Split on pipes / && / || / ; (good enough for policy: anything unusual falls through to deny). */
export function segments(command: string) {
  return command
    .split(/\|\||&&|;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** null = read-only; otherwise the first offending segment / reason. */
function readOnlyViolation(command: string): string | null {
  if (/(^|[^0-9&])>{1,2}(?!&)\s*(?!\/dev\/null)/.test(command.replace(/2>&1/g, ""))) return "output redirection writes files";
  for (const seg of segments(command)) {
    const s = seg.replace(/^cd\s+\S+\s*$/, "pwd");
    if (!READ_ONLY.some((re) => re.test(s))) return `"${seg.slice(0, 80)}" is not a read-only command`;
  }
  return null;
}

/** Absolute paths mentioned in a shell command (good enough for policy; ~ is expanded). */
export function pathsIn(command: string): string[] {
  const home = process.env.HOME ?? "";
  return [...command.matchAll(/(?:^|[\s'"=:(])((?:~|\/)[^\s'"`;|&<>()]*)/g)].map((m) => m[1].replace(/^~(?=\/|$)/, home)).filter((p) => p.length > 1);
}

/**
 * `cwd` is the shell's current directory as reported by the PreToolUse hook — Claude Code keeps it across Bash calls,
 * so "cd <primary checkout>" followed by "git checkout -b x" is caught on the second call too.
 */
export function decideBash(command: string, ctx: PolicyContext, cwd?: string): Decision {
  for (const [re, why] of ALWAYS_DENIED) if (re.test(command)) return deny(why);
  const base = ctx.baseBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\bgit\\s+(-C\\s+\\S+\\s+)?(checkout|switch)\\s+${base}\\b`).test(command)) return deny(`do not check out ${ctx.baseBranch}`);
  if (ctx.mode === "coding") {
    if (/\bgit\s+(-C\s+\S+\s+)?(checkout\s+-[bB]|switch\s+-[cC]|branch\s+(?!-)[^\s|;&]+)/.test(command))
      return deny("branches are managed by the platform: use mcp__platform__prepare_branch and work in the returned worktree");
    const roots = ctx.protectedRoots ?? [];
    const primary = (p: string) => isInside(p, roots) && !isInside(p, ctx.workspaces);
    const touched = [...(cwd && primary(cwd) ? [cwd] : []), ...pathsIn(command).filter(primary)];
    if (touched.length) {
      const v = readOnlyViolation(command);
      if (v)
        return deny(
          `${touched[0]} is a primary checkout and is read-only (${v}). Call mcp__platform__prepare_branch and run modifying commands inside the returned worktree` +
            (ctx.workspaces.length ? ` (${ctx.workspaces.join(", ")})` : "") + ".",
        );
    }
    return allow;
  }
  const v = readOnlyViolation(command);
  return v ? deny(`analysis steps may only run read-only commands; ${v}`) : allow;
}

/**
 * `agentId` is set by the PreToolUse hook when a subagent makes the call. Subagents inherit the step's restrictions and
 * are additionally read-only: analysis policy, read-only platform tools, no nested delegation.
 */
export function decide(tool: string, input: Record<string, unknown>, ctx: PolicyContext, cwd?: string, agentId?: string): Decision {
  if (agentId) {
    if (tool.startsWith("mcp__platform__")) {
      if (!SUBAGENT_PLATFORM_TOOLS.includes(tool)) return deny(`subagents are read-only: ${tool.replace("mcp__platform__", "")} is reserved for the main agent`);
      if (tool === "mcp__platform__call_tool" && !(ctx.isReadOnlyIntegration?.(String(input.name ?? "")) ?? false))
        return deny("subagents may only call read-only integration tools");
      return allow;
    }
    if (tool === "Task" || tool === "Agent") return deny("subagents cannot delegate further");
    return decide(tool, input, { ...ctx, mode: "analysis", delegation: false }, cwd);
  }
  if (tool.startsWith("mcp__platform__")) return allow;
  switch (tool) {
    case "Task":
    case "Agent":
      return ctx.delegation ? allow : deny("delegation is not enabled for this step (step config delegation.enabled)");
    case "Read":
    case "Grep":
    case "Glob":
    case "LS":
    case "TodoWrite":
    case "WebFetch":
    case "WebSearch":
    case "Skill":
      return allow;
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit": {
      if (ctx.mode !== "coding") return deny("this step is read-only; file edits happen in a coding step");
      const path = String(input.file_path ?? input.notebook_path ?? "");
      if (!path) return deny("missing file path");
      if (!ctx.workspaces.length) return deny("call mcp__platform__prepare_branch first; edits are only allowed inside its worktree");
      if (!isInside(path, ctx.workspaces)) return deny(`edits are only allowed inside the run's worktrees: ${ctx.workspaces.join(", ")}`);
      return allow;
    }
    case "Bash":
      return decideBash(String(input.command ?? ""), ctx, cwd);
    default:
      return deny(`tool ${tool} is not allowed in workflow steps`);
  }
}
