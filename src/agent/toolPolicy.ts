import { resolve, sep } from "node:path";

/**
 * Explicit tool policy for unattended agent steps, enforced in code (PreToolUse hook + canUseTool), not by
 * prompt instructions. Replaces the old `bypassPermissions` + short deny-list.
 *
 *  analysis (agent):        read anywhere, read-only shell allowlist, no file edits.
 *  coding (coding_agent):   edits only inside the run's worktrees; shell minus destructive git / rm -rf / push.
 */
export type ToolMode = "analysis" | "coding";

const BASE_TOOLS = ["Read", "Grep", "Glob", "Bash", "Skill", "TodoWrite", "WebFetch", "WebSearch", "Task"];
export const toolsFor = (mode: ToolMode) => (mode === "coding" ? [...BASE_TOOLS, "Edit", "Write", "NotebookEdit"] : BASE_TOOLS);

export interface PolicyContext {
  mode: ToolMode;
  /** Absolute worktree paths the step may edit. */
  workspaces: string[];
  baseBranch: string;
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

export function decideBash(command: string, ctx: PolicyContext): Decision {
  for (const [re, why] of ALWAYS_DENIED) if (re.test(command)) return deny(why);
  const base = ctx.baseBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\bgit\\s+(-C\\s+\\S+\\s+)?(checkout|switch)\\s+${base}\\b`).test(command)) return deny(`do not check out ${ctx.baseBranch}`);
  if (ctx.mode === "coding") return allow;
  if (/(^|[^0-9&])>{1,2}(?!&)\s*(?!\/dev\/null)/.test(command.replace(/2>&1/g, ""))) return deny("analysis steps cannot write files (output redirection)");
  for (const seg of segments(command)) {
    const s = seg.replace(/^cd\s+\S+\s*$/, "pwd");
    if (!READ_ONLY.some((re) => re.test(s))) return deny(`analysis steps may only run read-only commands; "${seg.slice(0, 80)}" is not on the allowlist`);
  }
  return allow;
}

export function decide(tool: string, input: Record<string, unknown>, ctx: PolicyContext): Decision {
  if (tool.startsWith("mcp__platform__")) return allow;
  switch (tool) {
    case "Read":
    case "Grep":
    case "Glob":
    case "LS":
    case "TodoWrite":
    case "WebFetch":
    case "WebSearch":
    case "Skill":
    case "Task":
    case "Agent":
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
      return decideBash(String(input.command ?? ""), ctx);
    default:
      return deny(`tool ${tool} is not allowed in workflow steps`);
  }
}
