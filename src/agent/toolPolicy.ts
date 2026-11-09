import { CONTEXT_TOOLS } from "./contextToolSchemas.ts";
import { lstatSync } from "node:fs";
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
export const SUBAGENT_PLATFORM_TOOLS = ["read_knowledge", "search_knowledge", "read_step_output", "list_tools", "describe_tool", "call_tool", ...CONTEXT_TOOLS.filter(t => t.readOnly).map(t => t.name)].map((t) => `mcp__platform__${t}`);

export interface PolicyContext {
  mode: ToolMode;
  allowedTools?: string[] | null;
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
  [/\bgit\s+(-C\s+\S+\s+)?push\b/, "pushing is done by the platform's pull request step — commit locally and finish with mcp__platform__submit_result"],
  [/\bgit\s+(-C\s+\S+\s+)?reset\s+--hard\b/, "git reset --hard is not allowed — to undo a change, edit the files back or add a new commit (git revert)"],
  [/\bgit\s+(-C\s+\S+\s+)?clean\b/, "git clean is not allowed — remove only files you created, by name (rm <file>)"],
  [/\bgit\s+(-C\s+\S+\s+)?worktree\s+prune\b/, "worktrees are managed by the platform — keep working in the worktree returned by mcp__platform__prepare_branch"],
  [/\bgit\s+(-C\s+\S+\s+)?branch\s+-[dD]\b/, "deleting branches is not allowed — branches belong to the platform; just keep committing on the run branch"],
  [/\bsudo\b/, "sudo is not allowed — the step runs unprivileged; if a tool is missing, say so in submit_result"],
  [/\bgit\s+(-C\s+\S+\s+)?(restore\b|stash\b(?!\s+(list|show)\b))/, "do not discard or stash existing changes; edit them deliberately"],
  [/\bgit\s+(-C\s+\S+\s+)?checkout\s+(--\s|\.(\s|$))/, "do not discard existing changes with git checkout -- — edit the file back deliberately instead"],
];

// First word(s) of each pipeline segment allowed in analysis steps.
const READ_ONLY = [
  /^(ls|cat|head|tail|wc|grep|rg|find|tree|file|stat|pwd|echo|sort|uniq|cut|tr|jq|diff|basename|dirname|realpath|which|date)\b/,
  /^sed\b(?!.*(\s-[a-zA-Z]*i|--in-place|\/w\s|;\s*w\s|^sed\s+(-\S+\s+)*['"]?w\s))/, // no in-place edit, no `w file`
  /^awk\b(?!.*system\()/,
  /^git\s+(-C\s+\S+\s+)?(log|show|diff|status|blame|branch|rev-parse|ls-files|ls-tree|grep|cat-file|merge-base|describe|remote\s+-v|fetch|stash\s+(list|show))\b/,
  /^git\s+(-C\s+\S+\s+)?symbolic-ref(\s+(-q|--quiet|--short))*\s+\S+\s*$/, // one argument = read; two = write
  /^(\[|test)\s/, // [ -d dir ], test -f file
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
  // open $( ... ) substitutions: the quote state outside each one, and its own unclosed "(" count
  const subst: Array<{ quote: string | null; parens: number }> = [];
  const fail = (error: string): ShellParse => ({ segments, redirects, heredocs, code, error });
  const flush = () => {
    const t = cur.trim();
    if (t) segments.push(t);
    cur = "";
  };
  const add = (t: string) => ((cur += t), (code += t));
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "$" && command[i + 1] === "(" && quote !== "'") {
      subst.push({ quote, parens: 0 });
      quote = null;
      add("$(");
      i++;
      continue;
    }
    if (subst.length && !quote && (c === "(" || c === ")")) {
      const top = subst[subst.length - 1];
      add(c);
      if (c === "(") top.parens++;
      else if (top.parens > 0) top.parens--;
      else quote = subst.pop()!.quote;
      continue;
    }
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
    if (subst.length && (c === "\n" || c === ";" || c === "|" || c === "&")) {
      add(c); // inside $( ... ): checked as its own command later
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
  if (subst.length) return fail("unterminated $( ... )");
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

/** Text the policy scans for paths and forbidden commands: shell code plus script bodies (never data bodies). */
const scanText = (p: ShellParse) => [p.code, ...p.heredocs.filter((h) => !h.data).map((h) => h.body)].join("\n");

const harmlessRedirect = (t: string) => t === "/dev/null" || t === "&/dev/null" || /^&[0-9-]$/.test(t);

/** null = read-only; otherwise the first offending segment / reason. */
function readOnlyViolation(command: string, allow: (seg: string) => boolean = () => false): string | null {
  const p = parseShell(command);
  if (p.error) return `cannot parse safely: ${p.error}`;
  const bad = p.redirects.find((r) => !harmlessRedirect(r.target));
  if (bad) return `output redirection writes files (> ${bad.target})`;
  const commands: Array<{ seg: string; s: string }> = [];
  for (const seg of p.segments) {
    // $(...) substitutions run commands too: check each one, then treat it as an opaque word.
    const { text, inner } = extractSubstitutions(seg);
    if (inner === null) return "cannot parse safely: unbalanced $( ... )";
    for (const body of inner) {
      const v = readOnlyViolation(body);
      if (v) return v;
    }
    let s = text;
    // VAR=value only sets a shell variable; VAR=value cmd ... runs cmd
    if (/^([A-Za-z_]\w*=\S*\s*)+$/.test(s)) continue;
    s = s.replace(/^([A-Za-z_]\w*=\S*\s+)+/, "");
    if (/`/.test(s.replace(/'[^']*'/g, ""))) return "backtick command substitution";
    commands.push({ seg, s });
  }
  const loop = loopStructure(commands.map((c) => c.s));
  if ("error" in loop) return loopUnsupported(loop.error);
  for (const cmd of loop.commands) {
    if (allow(cmd)) continue;
    // VAR=value only sets a shell variable (also inside loop bodies: `do b=$(…)`); VAR=value cmd … runs cmd
    if (/^([A-Za-z_]\w*=\S*\s*)+$/.test(cmd)) continue;
    const s = cmd.replace(/^([A-Za-z_]\w*=\S*\s+)+/, "").replace(/^cd\s+\S+\s*$/, "pwd");
    if (!READ_ONLY.some((re) => re.test(s))) return `"${cmd.slice(0, 80)}" is not a read-only command`;
  }
  return null;
}

/** Top-level `$( ... )` bodies of one simple command, replaced by SUBST in `text`; inner = null when unbalanced. */
export function extractSubstitutions(seg: string): { text: string; inner: string[] | null } {
  const inner: string[] = [];
  let text = "";
  let sq = false;
  let dq = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    if (!sq && c === "$" && seg[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      let q: string | null = null;
      for (; j < seg.length; j++) {
        const d = seg[j];
        if (q) {
          if (d === q) q = null;
          continue;
        }
        if (d === "'" || d === '"') q = d;
        else if (d === "(") depth++;
        else if (d === ")" && --depth === 0) break;
      }
      if (j >= seg.length) return { text, inner: null };
      inner.push(seg.slice(i + 2, j));
      text += "SUBST";
      i = j;
      continue;
    }
    text += c;
  }
  return { text, inner };
}

export const loopUnsupported = (detail: string) =>
  `cú pháp vòng lặp chưa được hỗ trợ (${detail}). Tách vòng lặp thành các lệnh đơn rồi chạy lại: mỗi lệnh một lần gọi Bash, ` +
  `hoặc nối các lệnh chỉ đọc bằng && / ; (chỉ hỗ trợ "for NAME in WORDS; do CMD; done" và "... | while read VAR; do CMD; done")`;

/**
 * Validates loop structure over simple commands and returns the indexes of the commands that actually run (loop
 * bodies, plain commands). Supported: `for NAME in WORDS; do ...; done` and `while [IFS=..] read [-r] VAR...; do ...;
 * done`, nested when balanced. Anything else that looks like control flow is reported as unsupported, never guessed.
 */
function loopStructure(input: string[]): { commands: string[] } | { error: string } {
  const commands: string[] = [];
  // "do CMD" on one line is "do" followed by CMD (which may itself open a nested loop)
  const segs = input.flatMap((s) => (/^do\s+\S/.test(s) ? ["do", s.slice(2).trim()] : [s]));
  const stack: Array<{ kind: string; open: boolean }> = []; // open = `do` seen
  for (const s of segs) {
    const top = stack.at(-1);
    if (/^for\b/.test(s)) {
      const m = s.match(/^for\s+([A-Za-z_]\w*)\s+in(?:\s+(.*))?$/);
      if (!m) return { error: `"${s.slice(0, 60)}" — chỉ hỗ trợ dạng "for NAME in WORDS"` };
      if (/(^|\s)(do|done)(\s|$)/.test(m[2] ?? "")) return { error: `thiếu ";" trước do trong "${s.slice(0, 60)}"` };
      if (top && !top.open) return { error: "vòng lặp lồng trước do" };
      stack.push({ kind: "for", open: false });
      // the word list may hold $(...) — already checked above; the `for` line itself runs nothing
      continue;
    }
    if (/^while\b/.test(s)) {
      if (!/^while\s+(IFS=\S*\s+)?read(\s+-r)?(\s+[A-Za-z_]\w*)+$/.test(s)) return { error: `"${s.slice(0, 60)}" — chỉ hỗ trợ "while read VAR"` };
      if (top && !top.open) return { error: "vòng lặp lồng trước do" };
      stack.push({ kind: "while", open: false });
      continue;
    }
    if (/^do(\s|$)/.test(s)) {
      if (!top || top.open) return { error: '"do" không thuộc vòng lặp nào' };
      top.open = true;
      continue;
    }
    if (/^done(\s+<\s*\S+)?$/.test(s)) {
      if (!top || !top.open) return { error: '"done" không khớp với do' };
      stack.pop();
      continue;
    }
    if (/^(until|select|if|then|elif|else|fi|case|esac|function)\b|^[{}()]|^\(\(/.test(s)) return { error: `"${s.slice(0, 40)}" không được hỗ trợ` };
    if (top && !top.open) return { error: `có lệnh giữa "${top.kind}" và "do"` };
    commands.push(s);
  }
  if (stack.length) return { error: `vòng lặp "${stack.at(-1)!.kind}" chưa được đóng bằng done` };
  return { commands };
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
 * A worktree may borrow the primary checkout's node_modules through a symlink (to run eslint/tsc/prettier), but then a
 * package install would write THROUGH the link into the primary checkout: refuse it while node_modules is a symlink.
 */
export function packageInstallViolation(p: ShellParse, dirs: Array<string | undefined>, workspaces: string[]): string | null {
  const linkedHere = p.segments.some((seg) => /^ln\s+-[a-zA-Z]*s[a-zA-Z]*\s+\S*node_modules\/?\s+\S*node_modules\/?$/.test(seg));
  for (const [i, seg] of p.segments.entries()) {
    if (!/^(npm|yarn|pnpm)\s+(install|i|ci|add|remove|rm|uninstall|update|up|upgrade|link)\b/.test(seg)) continue;
    const dir = dirs[i];
    let symlinked = linkedHere;
    try {
      if (dir && isInside(dir, workspaces)) symlinked ||= lstatSync(resolve(dir, "node_modules")).isSymbolicLink();
    } catch { }
    if (symlinked) return "node_modules in this worktree is a symlink to the primary checkout: installing/changing packages would modify the primary checkout. Remove the symlink first (rm node_modules) and install into the worktree, or report the needed dependency in submit_result";
  }
  return null;
}

/**
 * A scratch worktree: `git [-C repo] worktree add [--detach|-f|-q…] <path under /tmp> [<commit-ish>]` without creating a
 * branch (-b/-B), or `worktree remove` of such a path. It only writes under /tmp (plus git's own worktree bookkeeping
 * in the repository's .git), never the checkout's files — agents use it to run tests on the base commit.
 */
export function isScratchWorktreeOp(seg: string): boolean {
  const m = seg.match(/^git\s+(?:-C\s+\S+\s+)?worktree\s+(add|remove)\s+(.*)$/);
  if (!m) return false;
  const args = m[2].trim().split(/\s+/);
  if (args.some((a) => /^-(b|B)$/.test(a) || a.startsWith("--orphan"))) return false;
  const path = args.find((a) => !a.startsWith("-"));
  if (!path || /[$`~]/.test(path) || !path.startsWith("/")) return false;
  return TEMP_ROOTS().some((r) => strictlyInside(resolve(path.replace(/^['"]|['"]$/g, "")), r));
}

/**
 * `git worktree remove` is allowed only for scratch worktrees under /tmp or $TMPDIR (e.g. a detached checkout the agent
 * made to run tests on the base commit). The run's own worktrees and any repository checkout stay off-limits.
 */
export function worktreeRemoveViolation(p: ShellParse): string | null {
  for (const seg of p.segments) {
    const m = seg.match(/\bgit\s+(?:-C\s+\S+\s+)?worktree\s+remove\b(.*)$/);
    if (!m) continue;
    const targets = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith("-")).map((a) => a.replace(/^['"]|['"]$/g, ""));
    if (!targets.length) return "git worktree remove without a target";
    for (const t of targets) {
      if (/[$`~]/.test(t) || !t.startsWith("/") || !TEMP_ROOTS().some((r) => strictlyInside(resolve(t), r)))
        return `worktrees are managed by the platform — you may only remove scratch worktrees you created under /tmp (absolute path), not "${t}"; keep working in the worktree returned by mcp__platform__prepare_branch`;
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

/**
 * The directory a command explicitly runs in via its own flag (`go -C d`, `git -C d`, `make -C d`, `npm --prefix d`,
 * `pnpm -C d` / `--dir d`, `yarn --cwd d`), when it is a literal absolute (or ~) path. Otherwise undefined.
 */
export function explicitDir(seg: string): string | undefined {
  const m = seg
    .replace(/^([A-Za-z_]\w*=\S*\s+)+/, "")
    .match(/^(?:(?:go|git|make|pnpm)\s+-C(?:\s+|=)|npm\s+(?:\S+\s+)*?--prefix(?:\s+|=)|pnpm\s+--dir(?:\s+|=)|yarn\s+--cwd(?:\s+|=))(\S+)/);
  if (!m) return undefined;
  const d = expandHome(m[1].replace(/^(['"])(.*)\1$/, "$2"));
  return d.startsWith("/") && !/[$`*?]/.test(d) ? resolve(d) : undefined;
}

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
  const wt = worktreeRemoveViolation(p);
  if (wt) return deny(wt);
  const base = ctx.baseBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\bgit\\s+(-C\\s+\\S+\\s+)?(checkout|switch)\\s+${base}\\b`).test(scan)) return deny(`do not check out ${ctx.baseBranch} — compare with git diff origin/${ctx.baseBranch}...HEAD or read a file with git show origin/${ctx.baseBranch}:<path>`);
  if (ctx.mode === "coding") {
    if (/\bgit\s+(-C\s+\S+\s+)?(checkout\s+-[bB]|switch\s+-[cC]|branch\s+(?!-)[^\s|;&]+)/.test(scan))
      return deny("branches are managed by the platform: use mcp__platform__prepare_branch and work in the returned worktree");
    const roots = ctx.protectedRoots ?? [];
    const primary = (x: string) => isInside(x, roots) && !isInside(x, ctx.workspaces);
    const dirs = segmentDirs(p, cwd);
    // `ln -s <primary>/node_modules node_modules`, `cp <primary>/file .`: the primary path is only READ, the write lands
    // in the worktree. Those source paths do not make the command a write to the primary checkout.
    const readSources = new Set<string>();
    p.segments.forEach((seg, i) => {
      const m = seg.match(/^(ln|cp)\s+((?:-[a-zA-Z]+\s+)*)(\S+)\s+(\S+)$/);
      if (!m || (m[1] === "ln" && !/s/.test(m[2])) || (m[1] === "cp" && /l/.test(m[2]))) return;
      const src = expandHome(m[3]), dst = expandHome(m[4]);
      const dstAbs = dst.startsWith("/") ? resolve(dst) : dirs[i] ? resolve(dirs[i]!, dst) : null;
      if (src.startsWith("/") && dstAbs && isInside(dstAbs, ctx.workspaces)) readSources.add(resolve(src));
    });
    const pkgWrite = packageInstallViolation(p, dirs, ctx.workspaces);
    if (pkgWrite) return deny(pkgWrite);
    p.segments.forEach((seg) => {
      const c = seg.match(/^git\s+-C\s+(\S+)\s+worktree\s/);
      if (c && isScratchWorktreeOp(seg)) readSources.add(resolve(expandHome(c[1])));
    });
    const scratchOnly = (i: number) => isScratchWorktreeOp(p.segments[i] ?? "");
    // `go -C /worktree test`, `git -C /worktree commit`, `npm --prefix /worktree i`: the command runs in that directory,
    // not in the shell's cwd. Such a segment is charged to the directory it names (absolute paths only), provided it
    // mentions no primary-checkout path itself (`go -C /wt build -o /primary/bin` still counts as a write there).
    const elsewhere = (seg: string) => {
      const d = explicitDir(seg);
      return !!d && !primary(d) && !pathsIn(seg).some(primary);
    };
    const away = (i: number) => elsewhere(p.segments[i] ?? "");
    const touched = [
      ...(cwd && primary(cwd) && !p.segments.every((seg, i) => scratchOnly(i) || away(i) || readOnlyViolation(seg) === null) ? [cwd] : []),
      ...dirs.filter((d, i): d is string => !!d && primary(d) && !scratchOnly(i) && !away(i)),
      ...pathsIn(command).filter((x) => primary(x) && !readSources.has(resolve(x))),
    ];
    // Literal variables assigned in the same command (`L=/abs/dir; … > $L-lint.log`) are expanded for redirect checks.
    const vars = new Map<string, string>();
    for (const seg of p.segments) {
      const a = seg.match(/^([A-Za-z_]\w*)=(?:'([^']*)'|"([^"$`]*)"|([^\s$`'"]+))$/);
      if (a) vars.set(a[1], a[2] ?? a[3] ?? a[4] ?? "");
    }
    const expandVars = (t: string) => t.replace(/\$\{(\w+)\}|\$(\w+)/g, (all, b, c) => vars.get(b ?? c) ?? all);
    // Real output redirections: resolve each target where its command runs, so `> ../../src/repo/f` is caught too.
    for (const r of p.redirects) {
      if (harmlessRedirect(r.target) || r.target.startsWith("&")) continue;
      const target = expandVars(r.target);
      if (/[$`*?{]/.test(target)) return deny(`cannot resolve redirection target "${r.target}" safely; use a literal path (or assign the variable a literal value earlier in the same command)`);
      const t = expandHome(target);
      if (!t.startsWith("/") && !dirs[r.seg]) return deny(`cannot resolve relative redirection target "${r.target}": the working directory is unknown`);
      const abs = t.startsWith("/") ? resolve(t) : resolve(dirs[r.seg]!, t);
      if (primary(abs)) touched.push(abs);
    }
    if (touched.length) {
      const v = readOnlyViolation(command, (s) => isScratchWorktreeOp(s) || elsewhere(s));
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
/** Workflow control remains available so a restricted step can finish or ask for help. */
export function toolAllowed(tool: string, allowed?: string[] | null): boolean {
  const logical = tool.startsWith("mcp__platform__") ? `platform.${tool.slice(15)}` : tool;
  if (["platform.submit_result", "platform.ask_user", "platform.request_clarification", "platform.post_update"].includes(logical)) return true;
  // Dispatchers enforce the actual target, including call_tool aliases, after validating the attempt binding.
  if (["platform.call_tool", "platform.list_tools", "platform.describe_tool"].includes(logical)) return true;
  return allowed == null || allowed.includes(logical);
}

export function decide(tool: string, input: Record<string, unknown>, ctx: PolicyContext, cwd?: string, agentId?: string): Decision {
  if (!toolAllowed(tool, ctx.allowedTools)) return deny(`tool ${tool} is excluded by this attempt's allowed_tools`);
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
