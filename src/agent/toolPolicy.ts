import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";

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
  [/\bgit\s+(-C\s+\S+\s+)?worktree\s+(remove|prune)\b/, "worktrees are managed by the platform"],
  [/\bgit\s+(-C\s+\S+\s+)?branch\s+-[dD]\b/, "deleting branches is not allowed"],
  [/\bsudo\b/, "sudo is not allowed"],
  [/\bgit\s+(-C\s+\S+\s+)?(restore\b|stash\b(?!\s+(list|show)\b))/, "do not discard or stash existing changes; edit them deliberately"],
  [/\bgit\s+(-C\s+\S+\s+)?checkout\s+(--\s|\.(\s|$))/, "do not discard existing changes with git checkout --"],
];

// First word(s) of each pipeline segment allowed in analysis steps.
const READ_ONLY = [
  /^(ls|cat|head|tail|wc|grep|rg|find|tree|file|stat|pwd|echo|sort|uniq|cut|tr|jq|diff|basename|dirname|realpath|which|date)\b/,
  /^sed\b(?!.*(\s-[a-zA-Z]*i|--in-place|\/w\s|;\s*w\s|^sed\s+(-\S+\s+)*['"]?w\s))/, // no in-place edit, no `w file`
  /^awk\b(?!.*system\()/,
  /^git\s+(-C\s+\S+\s+)?(log|show|diff|status|blame|branch|rev-parse|ls-files|ls-tree|grep|cat-file|merge-base|describe|remote\s+-v|fetch|stash\s+(list|show))\b/,
  /^go\s+(list|doc|version|env|vet)\b/,
  /^(node|npm)\s+(-v|--version|ls)\b/,
];

export interface ShellParse {
  /** Simple commands (split on unquoted |, ||, &&, ;, newline), heredoc bodies removed. */
  segments: string[];
  /** Unquoted output redirections, with the index of the simple command they belong to. */
  redirects: Array<{ target: string; seg: number }>;
  heredocs: Array<{ seg: number; delim: string; quoted: boolean; body: string; /** body is stdin data, not a script */ data: boolean }>;
  /** The command text with heredoc bodies removed (what the shell itself parses). */
  code: string;
  /** Set when the command cannot be parsed safely (unterminated quote/heredoc, ...): callers must deny. */
  error?: string;
}

/**
 * Commands whose stdin is plain data, so a heredoc fed to them is text (a commit message, a pattern list), never shell.
 * Anything else (python3 -, bash, node, psql, ...) treats the body as a script: it is kept for path/deny scanning.
 */
const DATA_STDIN = /^(git\s+(-C\s+\S+\s+)?(commit|tag)\b.*\s(-F|--file)(\s+|=)-(\s|$)|(cat|grep|rg|wc|head|tail|jq|sort|uniq|cut|tr)\b)/;

/**
 * Quote- and heredoc-aware tokenizer for policy checks. `grep -E 'a|b'` stays one command, `echo 'a > b'` has no
 * redirection, `2>/dev/null` is a redirect target, and a heredoc body (`<<'EOF' ... EOF`) is separated from the
 * shell code around it. Not a full shell parser: anything it cannot follow sets `error` and must be denied.
 */
export function parseShell(command: string): ShellParse {
  const segments: string[] = [];
  const redirects: ShellParse["redirects"] = [];
  const heredocs: ShellParse["heredocs"] = [];
  const pending: Array<{ delim: string; quoted: boolean; dash: boolean; seg: number }> = [];
  let cur = "";
  let code = "";
  let quote: string | null = null;
  const fail = (error: string): ShellParse => ({ segments, redirects, heredocs, code, error });
  const flush = () => {
    const t = cur.trim();
    if (t) segments.push(t);
    cur = "";
  };
  const add = (t: string) => ((cur += t), (code += t));
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        add(c + (command[i + 1] ?? ""));
        i++;
        continue;
      }
      add(c);
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      add(c);
      continue;
    }
    if (c === "\\") {
      if (command[i + 1] === "\n") return fail("line continuation");
      add(c + (command[i + 1] ?? ""));
      i++;
      continue;
    }
    if (c === "<" && command[i + 1] === "<") {
      if (command[i + 2] === "<") {
        add("<<<");
        i += 2;
        continue;
      }
      let j = i + 2;
      const dash = command[j] === "-";
      if (dash) j++;
      while (command[j] === " " || command[j] === "\t") j++;
      let delim = "";
      let quoted = false;
      if (command[j] === "'" || command[j] === '"') {
        const q = command[j];
        const close = command.indexOf(q, j + 1);
        if (close < 0) return fail("unterminated heredoc delimiter");
        delim = command.slice(j + 1, close);
        quoted = true;
        j = close + 1;
      } else {
        if (command[j] === "\\") (quoted = true), j++;
        const m = command.slice(j).match(/^[A-Za-z0-9_]+/);
        if (!m) return fail("heredoc without a delimiter");
        delim = m[0];
        j += delim.length;
      }
      if (!/^[A-Za-z0-9_]+$/.test(delim)) return fail("unusual heredoc delimiter");
      pending.push({ delim, quoted, dash, seg: segments.length });
      add(command.slice(i, j));
      i = j - 1;
      continue;
    }
    if (c === "\n" && pending.length) {
      // The command line ends here; the next lines are the heredoc bodies, each up to its delimiter line.
      flush();
      code += "\n";
      let pos = i + 1;
      for (const h of pending) {
        const lines: string[] = [];
        let found = false;
        while (pos < command.length) {
          const nl = command.indexOf("\n", pos);
          const line = command.slice(pos, nl < 0 ? command.length : nl);
          pos = nl < 0 ? command.length : nl + 1;
          if ((h.dash ? line.replace(/^\t+/, "") : line) === h.delim) {
            found = true;
            break;
          }
          lines.push(line);
          if (nl < 0) break;
        }
        if (!found) return fail(`unterminated heredoc <<${h.delim}`);
        heredocs.push({ seg: h.seg, delim: h.delim, quoted: h.quoted, body: lines.join("\n"), data: false });
      }
      pending.length = 0;
      i = pos - 1;
      continue;
    }
    if (c === "\n" || c === ";" || c === "|" || (c === "&" && command[i + 1] === "&")) {
      flush();
      const two = (c === "|" && command[i + 1] === "|") || c === "&";
      code += two ? c + command[i + 1] : c;
      if (two) i++;
      continue;
    }
    if (c === ">") {
      let j = i + 1;
      if (command[j] === ">" || command[j] === "|") j++;
      const dup = command[j] === "&";
      if (dup) j++;
      while (command[j] === " " || command[j] === "\t") j++;
      let k = j;
      let tq: string | null = null;
      while (k < command.length && (tq || !/[\s;|&<>()]/.test(command[k]))) {
        if (tq) tq = command[k] === tq ? null : tq;
        else if (command[k] === "'" || command[k] === '"') tq = command[k];
        k++;
      }
      if (tq) return fail("unterminated quote in redirection target");
      const target = command.slice(j, k).replace(/^(['"])(.*)\1$/, "$2");
      if (!target) return fail("redirection without a target");
      redirects.push({ target: (dup ? "&" : "") + target, seg: segments.length });
      code += command.slice(i, k);
      cur = cur.replace(/[0-9&]$/, "") + " ";
      i = k - 1;
      continue;
    }
    add(c);
  }
  if (quote) return fail("unterminated quote");
  if (pending.length) return fail(`unterminated heredoc <<${pending[0].delim}`);
  flush();
  for (const h of heredocs) {
    h.data = DATA_STDIN.test(segments[h.seg] ?? "");
    // An unquoted heredoc expands $(...) and `...` in its body: that runs commands, so it is not plain data.
    if (h.data && !h.quoted && /\$\(|`/.test(h.body)) return fail(`unquoted heredoc <<${h.delim} contains command substitution; quote the delimiter (<<'${h.delim}')`);
  }
  return { segments, redirects, heredocs, code };
}

export const segments = (command: string) => parseShell(command).segments;

/** Text the policy scans for paths and forbidden commands: shell code plus script bodies (never data bodies). */
const scanText = (p: ShellParse) => [p.code, ...p.heredocs.filter((h) => !h.data).map((h) => h.body)].join("\n");

const harmlessRedirect = (t: string) => t === "/dev/null" || t === "&/dev/null" || /^&[0-9-]$/.test(t);

/** null = read-only; otherwise the first offending segment / reason. */
function readOnlyViolation(command: string): string | null {
  const p = parseShell(command);
  if (p.error) return `cannot parse safely: ${p.error}`;
  const bad = p.redirects.find((r) => !harmlessRedirect(r.target));
  if (bad) return `output redirection writes files (> ${bad.target})`;
  for (const seg of p.segments) {
    // $(...) substitutions run commands too: check each one, then treat it as an opaque word.
    let s = seg;
    for (let m; (m = s.match(/\$\(([^()]*)\)/)); ) {
      const inner = readOnlyViolation(m[1]);
      if (inner) return inner;
      s = s.replace(m[0], "SUBST");
    }
    if (/`/.test(s.replace(/'[^']*'/g, ""))) return "backtick command substitution";
    if (/^(done|fi|then|else|do|\{|\})$/.test(s) || /^for\s+\w+\s+in\b/.test(s) || /^while\s+(IFS=\S*\s+)?read\b/.test(s)) continue;
    s = s.replace(/^(do|then|else)\s+/, "").replace(/^cd\s+\S+\s*$/, "pwd");
    if (!READ_ONLY.some((re) => re.test(s))) return `"${seg.slice(0, 80)}" is not a read-only command`;
  }
  return null;
}

const TEMP_ROOTS = () => [...new Set(["/tmp", tmpdir(), process.env.TMPDIR].filter(Boolean) as string[])].map((r) => resolve(r));
const strictlyInside = (p: string, root: string) => p !== root && isInside(p, [root]);
const expandHome = (t: string) => t.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");

/**
 * The directory each simple command runs in, following literal `cd` (starting from the hook's cwd). A `cd` whose
 * target is not a literal path makes the directory unknown (undefined) from there on.
 */
function segmentDirs(p: ShellParse, cwd?: string): Array<string | undefined> {
  let dir = cwd;
  return p.segments.map((seg) => {
    const here = dir;
    const cd = seg.match(/^cd(?:\s+(\S+))?\s*$/);
    if (cd) {
      const to = expandHome((cd[1] ?? "~").replace(/^(['"])(.*)\1$/, "$2"));
      dir = /[$`*?]/.test(to) || to === "-" ? undefined : to.startsWith("/") ? resolve(to) : dir ? resolve(dir, to) : undefined;
    }
    return here;
  });
}

/**
 * rm -rf is allowed only when every target is a temp location: under /tmp or $TMPDIR (not the root itself), or a
 * tmp* / .tmp* folder (or something below one) inside one of the run's worktrees. `cd` earlier in the same command is
 * followed. Returns a deny reason, or null when the command has no rm -rf or only temp targets.
 */
export function rmRfViolation(command: string | ShellParse, ctx: PolicyContext, cwd?: string): string | null {
  const p = typeof command === "string" ? parseShell(command) : command;
  if (p.error) return `cannot parse safely: ${p.error}`;
  for (const h of p.heredocs)
    if (!h.data && /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/.test(h.body)) return "rm -rf inside an inline script cannot be checked; run it as a separate command";
  const dirs = segmentDirs(p, cwd);
  for (const [n, seg] of p.segments.entries()) {
    const words = seg.split(/\s+/);
    const i = words.findIndex((w) => w === "rm" || w.endsWith("/rm"));
    if (i < 0) continue;
    const args = words.slice(i + 1);
    const flags = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join("");
    if (!(/r|R/.test(flags) && /f/.test(flags)) && !args.includes("--recursive")) continue;
    const targets = args.filter((a) => !a.startsWith("-")).map((a) => a.replace(/^['"]|['"]$/g, ""));
    if (!targets.length) return "rm -rf without a target";
    const dir = dirs[n];
    for (const t of targets) {
      if (/[$`]/.test(t) || t.startsWith("~")) return `rm -rf target "${t}" must be a literal path`;
      if (!t.startsWith("/") && !dir) return `rm -rf with a relative path needs a known directory ("${t}")`;
      const abs = t.startsWith("/") ? resolve(t) : resolve(dir!, t);
      const temp = TEMP_ROOTS().some((r) => strictlyInside(abs, r));
      const ws = ctx.workspaces.find((w) => strictlyInside(abs, resolve(w)));
      const tmpInWorktree = ws && relative(resolve(ws), abs).split(sep).some((c) => /^\.?tmp/i.test(c));
      if (!temp && !tmpInWorktree) return `rm -rf is only allowed for temp paths (/tmp, $TMPDIR, or a tmp*/.tmp* folder inside the worktree), not "${t}"`;
    }
  }
  return null;
}

/**
 * Absolute paths mentioned in the shell code and in inline scripts (heredoc bodies fed to an interpreter); heredoc
 * data such as a commit message is not scanned. Only real absolute paths count: "~128k" in prose is not a path.
 */
export function pathsIn(command: string): string[] {
  const p = parseShell(command);
  const text = p.error ? command : scanText(p);
  return [...text.matchAll(/(?:^|[\s'"=:(])((?:~|\/)[^\s'"`;|&<>()]*)/g)].map((m) => expandHome(m[1])).filter((x) => x.startsWith("/") && x.length > 1);
}

/** The command with heredoc bodies removed (what the shell itself parses). */
export const stripHeredocs = (command: string) => parseShell(command).code;

/**
 * `cwd` is the shell's current directory as reported by the PreToolUse hook — Claude Code keeps it across Bash calls,
 * so "cd <primary checkout>" followed by "git checkout -b x" is caught on the second call too.
 */
export function decideBash(command: string, ctx: PolicyContext, cwd?: string): Decision {
  const p = parseShell(command);
  if (p.error) return deny(`cannot parse this command safely (${p.error}); split it into simpler commands`);
  const scan = scanText(p);
  for (const [re, why] of ALWAYS_DENIED) if (re.test(scan)) return deny(why);
  const rm = rmRfViolation(p, ctx, cwd);
  if (rm) return deny(rm);
  const base = ctx.baseBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\bgit\\s+(-C\\s+\\S+\\s+)?(checkout|switch)\\s+${base}\\b`).test(scan)) return deny(`do not check out ${ctx.baseBranch}`);
  if (ctx.mode === "coding") {
    if (/\bgit\s+(-C\s+\S+\s+)?(checkout\s+-[bB]|switch\s+-[cC]|branch\s+(?!-)[^\s|;&]+)/.test(scan))
      return deny("branches are managed by the platform: use mcp__platform__prepare_branch and work in the returned worktree");
    const roots = ctx.protectedRoots ?? [];
    const primary = (x: string) => isInside(x, roots) && !isInside(x, ctx.workspaces);
    const dirs = segmentDirs(p, cwd);
    const touched = [...(cwd && primary(cwd) ? [cwd] : []), ...dirs.filter((d): d is string => !!d && primary(d)), ...pathsIn(command).filter(primary)];
    // Real output redirections: resolve each target where its command runs, so `> ../../src/repo/f` is caught too.
    for (const r of p.redirects) {
      if (harmlessRedirect(r.target) || r.target.startsWith("&")) continue;
      if (/[$`*?{]/.test(r.target)) return deny(`cannot resolve redirection target "${r.target}" safely; use a literal path`);
      const t = expandHome(r.target);
      if (!t.startsWith("/") && !dirs[r.seg]) return deny(`cannot resolve relative redirection target "${r.target}": the working directory is unknown`);
      const abs = t.startsWith("/") ? resolve(t) : resolve(dirs[r.seg]!, t);
      if (primary(abs)) touched.push(abs);
    }
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
