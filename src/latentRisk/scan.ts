import { dirname } from "node:path";
import { changes, git, readSource } from "../codeIntelligence/git.ts";
import { withTree } from "../codeIntelligence/parser.ts";
import {
  LATENT_RISK_VERSION,
  collectStructs,
  detectLatentRisks,
  type LatentRisk,
  type StructIndex,
} from "./detectors.ts";

export interface GoSource {
  path: string;
  source: string;
}

/** Cheap text filters before parsing: files that can hold a thunk closure, a lock call, or a struct with a mutex. */
const CANDIDATE = /func\s*\(\s*\)|\.R?Lock\(\)/;
const HAS_MUTEX = /sync\.(RW)?Mutex/;
const GREP = "func *\\( *\\)|\\.R?Lock\\(\\)|sync\\.(RW)?Mutex";
const SKIP =
  /(^|\/)(vendor|third_party|testdata|node_modules)\/|_test\.go$|\.pb(\.gw)?\.go$|_mock\.go$|(^|\/)mock_[^/]*\.go$|\.gen\.go$|_gen\.go$/;
const MAX_FILES = 400;
const MAX_BYTES = 300_000;
const TIME_BUDGET_MS = 45_000;

export const scannable = (path: string) => path.endsWith(".go") && !SKIP.test(path);

const rank = (risks: LatentRisk[]) =>
  risks.sort(
    (a, b) =>
      Number(b.confidence === "high") - Number(a.confidence === "high") ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );

/**
 * Risks in targets. context only feeds the struct index (a method and its struct often sit in different files of one
 * package), so a diff scan still sees the mutex of a struct the change did not touch.
 */
export async function scanSources(
  targets: GoSource[],
  context: GoSource[] = [],
  signal?: AbortSignal,
): Promise<LatentRisk[]> {
  const files = new Map<string, GoSource>();
  for (const f of [...context, ...targets]) files.set(f.path, f);
  const structs: StructIndex = new Map();
  for (const f of files.values())
    if (HAS_MUTEX.test(f.source))
      await withTree("go", f.source, signal, (root) => collectStructs(root, f.path, structs));
  const out: LatentRisk[] = [];
  for (const f of targets)
    if (CANDIDATE.test(f.source) || HAS_MUTEX.test(f.source))
      out.push(
        ...(await withTree("go", f.source, signal, (root) =>
          detectLatentRisks(root, f.path, structs),
        )),
      );
  return rank(out);
}

const withBudget = (signal?: AbortSignal) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(TIME_BUDGET_MS)])
    : AbortSignal.timeout(TIME_BUDGET_MS);

/** The whole repository at one commit or ref (read-only: git grep + git show, the working tree is never touched). */
export async function scanRef(root: string, ref: string, signal?: AbortSignal) {
  const budget = withBudget(signal);
  const listed = await git(root, ["grep", "-l", "-I", "-E", GREP, ref, "--", "*.go"], budget).catch(
    () => "",
  );
  const paths = listed
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(ref.length + 1))
    .filter(scannable)
    .sort()
    .slice(0, MAX_FILES);
  const sources: GoSource[] = [];
  for (const path of paths) {
    const source = await git(root, ["show", `${ref}:${path}`], budget).catch(() => "");
    if (source && source.length <= MAX_BYTES) sources.push({ path, source });
  }
  return scanSources(sources, [], budget);
}

const identity = (r: LatentRisk) => `${r.rule}|${r.path}|${r.symbol}`;

/** Risks the change introduces: present in the changed Go files now, absent from the same symbols at the merge base. */
export async function scanChanged(root: string, baseRef: string, signal?: AbortSignal) {
  const budget = withBudget(signal);
  const mergeBase = (await git(root, ["merge-base", "HEAD", baseRef], budget)).trim();
  const state = await changes(root, mergeBase);
  const changed: GoSource[] = state.files
    .filter((f) => f.content !== null && scannable(f.path) && f.content.length <= MAX_BYTES)
    .map((f) => ({ path: f.path, source: f.content! }));
  if (!changed.length) return [];
  const dirs = new Set(changed.map((f) => dirname(f.path)));
  const touched = new Set(changed.map((f) => f.path));
  const siblings: GoSource[] = [];
  const tracked = (await git(root, ["ls-files", "-z"], budget)).split("\0");
  for (const path of tracked) {
    if (siblings.length >= MAX_FILES) break;
    if (!scannable(path) || touched.has(path) || !dirs.has(dirname(path))) continue;
    const source = await readSource(root, path).catch(() => null);
    if (source && source.length <= MAX_BYTES) siblings.push({ path, source });
  }
  const head = await scanSources(changed, siblings, budget);
  if (!head.length) return head;
  const before: GoSource[] = [];
  for (const f of changed) {
    const source = await git(root, ["show", `${mergeBase}:${f.path}`], budget).catch(() => "");
    if (source) before.push({ path: f.path, source });
  }
  const known = new Set((await scanSources(before, siblings, budget)).map(identity));
  return head.filter((r) => !known.has(identity(r)));
}

const MAX_LINES = 25;

/** The prompt section: candidates per repository, and for each rule present how to demonstrate it. */
export function formatRisks(
  sections: Array<{ repo: string; risks: LatentRisk[] }>,
  mode: "repository" | "diff",
): string {
  const lines: string[] = [];
  const rules = new Map<string, string>();
  let total = 0;
  for (const { repo, risks } of sections)
    for (const r of risks) {
      total++;
      rules.set(r.rule, r.hint);
      if (lines.length < MAX_LINES)
        lines.push(
          `- [${r.confidence}/${r.rule}] ${repo}:${r.path}:${r.line} (${r.symbol}) — ${r.message}`,
        );
    }
  if (!total) return "";
  if (total > lines.length) lines.push(`- … ${total - lines.length} more not shown`);
  return [
    `Deterministic AST probe ${LATENT_RISK_VERSION} over ${mode === "diff" ? "the changed Go files of this branch (new candidates only)" : "the Go source of the pinned revision"}. ` +
      "These are CANDIDATES, not findings: confirm each in the code (who calls it, can two goroutines reach the shared value), drop the false ones silently, " +
      "and keep looking beyond this list, it only knows two shapes.",
    ...lines,
    "How to demonstrate each rule (a test that fails now and passes after the fix):",
    ...[...rules].map(([rule, hint]) => `- ${rule}: ${hint}`),
  ].join("\n");
}
