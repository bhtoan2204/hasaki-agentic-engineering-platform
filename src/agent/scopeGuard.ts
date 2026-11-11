/**
 * Deterministic scope enforcement: what a coding step actually changed (read from git by the platform — never from
 * the agent's own account) compared with the scope a human approved.
 *
 *  - Changed files = committed (vs the merge base) + staged + unstaged + untracked, renames split into both paths.
 *  - Paths are compared repository-relative after strict normalization; absolute paths, `..`, backslashes, NUL and
 *    ambiguous forms (`a//b`, `a/./b`, wildcards other than a trailing directory marker) are violations, never matches.
 *  - A changed file is in scope only when it is approved exactly or lies under an approved directory (`dir/`, `dir/**`).
 *  - Test files get no blanket exemption: one is in scope only inside an approved repository AND as the companion test
 *    of an approved file (same directory, same stem: refund.go → refund_test.go / refund.test.ts / test_refund.py) or
 *    when named by the approved `required_tests`. A test file in any other repository is out of scope.
 *  - Every violation requires renewed human approval, bound to a `revision` = hash of the approved proposal, the exact
 *    changed-file set, every repository's HEAD and its uncommitted content. A renewed approval for one revision does
 *    not cover a later one: the diff is re-validated before the PR is published.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import type { ApprovedScope } from "./evidence.ts";

const exec = promisify(execFile);

export const TEST_FILE =
  /(?:^|\/)(?:tests?|__tests__|spec|testdata|fixtures?)\/|[._-](?:test|spec)\.[a-z0-9]+$|_test\.go$/i;

/** `dir/name` without extension (and, for a test file, without its test marker): the key that pairs a test with its source. */
export function stemKey(p: string, test = false) {
  const dir = posix.dirname(p);
  let base = posix.basename(p).replace(/\.[^.]+$/, "");
  if (test) base = base.replace(/(?:_test|[._-](?:test|spec))$/i, "").replace(/^test_/i, "");
  return `${dir}/${base}`;
}

export type NormalizedPath = { path: string; dir: boolean } | { invalid: string };

/**
 * Normalize one path to repository-relative POSIX form. `repo` lets an approved entry written as `<repo>/<path>` match.
 * Returns `{ invalid }` for anything that cannot be compared unambiguously.
 */
export function normalizeScopePath(raw: unknown, repo = "", allowDir = false): NormalizedPath {
  let p = String(raw ?? "")
    .trim()
    .replace(/:\d+(?:-\d+)?$/, "");
  if (!p) return { invalid: "empty path" };
  if (p.includes("\0")) return { invalid: "NUL byte in path" };
  if (p.includes("\\")) return { invalid: "backslash in path (ambiguous separator)" };
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.startsWith("~"))
    return { invalid: "absolute path" };
  while (p.startsWith("./")) p = p.slice(2);
  if (repo && p.startsWith(`${repo}/`)) p = p.slice(repo.length + 1);
  let dir = false;
  if (allowDir && (p.endsWith("/**") || p.endsWith("/"))) {
    dir = true;
    p = p.replace(/\/\*\*$/, "").replace(/\/$/, "");
  }
  if (!p) return { invalid: "empty path" };
  const segs = p.split("/");
  if (segs.includes("..")) return { invalid: "path traversal (..)" };
  if (segs.some((s) => s === "" || s === "."))
    return { invalid: "ambiguous path (empty or '.' segment)" };
  if (/[*?[\]]/.test(p))
    return { invalid: "wildcard path (only a trailing directory marker is allowed)" };
  if (posix.normalize(p) !== p) return { invalid: "non-canonical path" };
  return { path: p, dir };
}

export interface ScopeEvaluation {
  out_of_scope_files: string[];
  invalid_paths: string[];
  unauthorized_repos: string[];
  /** Out-of-scope test files (listed in out_of_scope_files too), reported separately for clarity. */
  out_of_scope_tests: string[];
}

/** Pure comparison of changed files (per repository) with the approved scope. */
export function evaluateScope(
  scope: Pick<ApprovedScope, "changes" | "required_tests">,
  files: Record<string, string[]>,
): ScopeEvaluation {
  const approved = new Map<string, { files: Set<string>; dirs: string[]; stems: Set<string> }>();
  for (const c of scope.changes ?? []) {
    const repo = String(c.repo ?? "");
    if (!repo) continue;
    const a = approved.get(repo) ?? {
      files: new Set<string>(),
      dirs: [],
      stems: new Set<string>(),
    };
    for (const f of c.files ?? []) {
      const n = normalizeScopePath(f, repo, true);
      if ("invalid" in n) continue; // an unusable approved entry grants nothing
      if (n.dir) a.dirs.push(n.path);
      else {
        a.files.add(n.path);
        a.stems.add(stemKey(n.path));
      }
    }
    approved.set(repo, a);
  }
  const requiredTests = (scope.required_tests ?? []).map(String);
  const out: ScopeEvaluation = {
    out_of_scope_files: [],
    invalid_paths: [],
    unauthorized_repos: [],
    out_of_scope_tests: [],
  };
  for (const [repo, paths] of Object.entries(files)) {
    if (!paths.length) continue;
    const a = approved.get(repo);
    if (!a) out.unauthorized_repos.push(repo);
    for (const raw of paths) {
      const n = normalizeScopePath(raw);
      if ("invalid" in n) {
        out.invalid_paths.push(`${repo}:${String(raw).slice(0, 200)} (${n.invalid})`);
        continue;
      }
      const p = n.path;
      const isTest = TEST_FILE.test(p);
      let ok = false;
      if (a) {
        ok = a.files.has(p) || a.dirs.some((d) => p === d || p.startsWith(`${d}/`));
        if (!ok && isTest)
          ok = a.stems.has(stemKey(p, true)) || requiredTests.some((t) => t.includes(p));
      }
      if (!ok) {
        out.out_of_scope_files.push(`${repo}:${p}`);
        if (isTest) out.out_of_scope_tests.push(`${repo}:${p}`);
      }
    }
  }
  return out;
}

export const scopeViolations = (e: ScopeEvaluation) => [
  ...e.unauthorized_repos.map((r) => `${r}: repository is not in the approved scope`),
  ...e.invalid_paths.map((p) => `invalid path ${p}`),
  ...e.out_of_scope_files.map((p) => `${p} is outside the approved scope`),
];

async function git(path: string, args: string[]) {
  return (await exec("git", ["-C", path, ...args], { maxBuffer: 64 << 20 })).stdout;
}
const z = (s: string) => s.split("\0").filter(Boolean);

/** Every file the worktree differs in from `base`: committed, staged, unstaged and untracked. Throws when git fails. */
export async function changedFiles(path: string, base: string) {
  const committed = z(
    await git(path, ["diff", "--name-only", "-z", "--no-renames", `${base}...HEAD`]),
  );
  const staged = z(await git(path, ["diff", "--name-only", "-z", "--no-renames", "--cached"]));
  const unstaged = z(await git(path, ["diff", "--name-only", "-z", "--no-renames"]));
  const untracked = z(await git(path, ["ls-files", "-z", "--others", "--exclude-standard"]));
  const all = [...new Set([...committed, ...staged, ...unstaged, ...untracked])].sort();
  return { committed, staged, unstaged, untracked, all };
}

/** HEAD plus a fingerprint of uncommitted content: any edit, staged or not, changes it. */
export async function worktreeFingerprint(path: string) {
  const head = (await git(path, ["rev-parse", "HEAD"])).trim();
  const h = createHash("sha256")
    .update(head)
    .update("\0")
    .update(await git(path, ["diff", "--no-color", "--binary", "--no-renames", "HEAD"]));
  for (const f of z(await git(path, ["ls-files", "-z", "--others", "--exclude-standard"]))
    .sort()
    .slice(0, 500)) {
    const blob = (await git(path, ["hash-object", "--", f]).catch(() => "?")).trim();
    h.update(`\0${f}\0${blob}`);
  }
  return { head, fingerprint: h.digest("hex") };
}

/** Revision a renewed approval must name: the approved proposal + exact changed files + exact code state. */
export function scopeRevision(
  proposalHash: string,
  files: Record<string, string[]>,
  states: Record<string, string>,
) {
  const canon = Object.keys(files)
    .sort()
    .map((r) => [r, [...files[r]].sort(), states[r] ?? ""]);
  const extra = Object.keys(states)
    .filter((r) => !(r in files))
    .sort()
    .map((r) => [r, [], states[r]]);
  return createHash("sha256")
    .update(JSON.stringify([proposalHash, canon, extra]))
    .digest("hex")
    .slice(0, 16);
}

export interface WorkspaceScopeState {
  files: Record<string, string[]>;
  states: Record<string, string>;
  heads: Record<string, string>;
  /** Repositories whose changes could not be read: fail closed (treated as violations). */
  unreadable: string[];
}

/** Read the actual changes of every worktree of a run. */
export async function collectScopeState(
  workspaces: Array<{ repo: string; path: string; base: string }>,
): Promise<WorkspaceScopeState> {
  const st: WorkspaceScopeState = { files: {}, states: {}, heads: {}, unreadable: [] };
  for (const w of workspaces) {
    try {
      const ch = await changedFiles(w.path, w.base);
      const fp = await worktreeFingerprint(w.path);
      if (ch.all.length) st.files[w.repo] = ch.all;
      st.states[w.repo] = fp.fingerprint;
      st.heads[w.repo] = fp.head;
    } catch (e) {
      st.unreadable.push(
        `${w.repo}: cannot read changes (${(e as Error).message.split("\n")[0].slice(0, 200)})`,
      );
    }
  }
  return st;
}

export const SCOPE_REVISION_TAG = (rev: string) => `[scope revision ${rev}]`;
const APPROVE_ANSWER = /^\s*(approve|duyệt|đồng ý)/i;

/** A renewed approval counts only for the exact revision named in the question that was answered. */
export function renewedApprovalFor(
  answers: Array<{ question?: unknown; answer?: unknown }>,
  prefix: string,
  revision: string,
) {
  const tag = SCOPE_REVISION_TAG(revision);
  const a = [...answers]
    .reverse()
    .find((x) => String(x.question ?? "").startsWith(prefix) && String(x.question).includes(tag));
  return a && APPROVE_ANSWER.test(String(a.answer ?? ""))
    ? { answer: String(a.answer).slice(0, 500), revision }
    : null;
}

/**
 * Pre-publish gate (pure): what must hold right before pushing / opening the PR, whether or not the workflow has an
 * independent verifier. `scope` null = legacy run without an approved scope (no scope check). Returns problems.
 */
export function prePublishProblems(input: {
  publish: Record<string, { head: string; branchTip: string; dirty: string }>;
  scope: Pick<ApprovedScope, "changes" | "required_tests" | "proposal_hash"> | null;
  state: WorkspaceScopeState | null;
  renewedRevision: string | null;
  tested: Array<{ step: string; heads: Record<string, string> }>;
}): string[] {
  const problems: string[] = [];
  for (const [repo, st] of Object.entries(input.publish)) {
    if (!st.head || !st.branchTip)
      problems.push(`${repo}: cannot read the commit that would be published`);
    else if (st.head !== st.branchTip)
      problems.push(
        `${repo}: worktree HEAD ${st.head.slice(0, 12)} is not the tip of the pushed branch (${st.branchTip.slice(0, 12)})`,
      );
    if (st.dirty)
      problems.push(
        `${repo}: uncommitted or untracked changes in the worktree would not be published as reviewed`,
      );
  }
  // Tested commit == published commit: every test record bound to commits must cover exactly what is pushed.
  for (const t of input.tested)
    for (const [repo, st] of Object.entries(input.publish))
      if (t.heads[repo] !== undefined && t.heads[repo] !== st.branchTip)
        problems.push(
          `${repo}: tests in "${t.step}" ran on ${t.heads[repo].slice(0, 12) || "an unknown commit"}, but ${st.branchTip.slice(0, 12)} would be published`,
        );
  if (input.scope && input.state) {
    problems.push(...input.state.unreadable);
    const ev = evaluateScope(input.scope, input.state.files);
    const violations = scopeViolations(ev);
    if (violations.length) {
      const rev = scopeRevision(input.scope.proposal_hash, input.state.files, input.state.states);
      if (input.renewedRevision !== rev)
        problems.push(
          `scope drift: ${violations.slice(0, 8).join("; ")}${violations.length > 8 ? ` (+${violations.length - 8} more)` : ""} — ${input.renewedRevision ? `the renewed approval covered revision ${input.renewedRevision}, the code is now at ${rev}` : "no renewed approval"}`,
        );
    }
  }
  return problems;
}
