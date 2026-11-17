import { fileURLToPath } from "node:url";
import { normalizeScopePath } from "./scopeGuard.ts";
import { worktreeFingerprint } from "./scopeGuard.ts";
import {
  baseTip,
  envFingerprint,
  type EvidenceCache,
  type EvidenceParts,
  type EvidenceStats,
} from "./verifyEvidence.ts";
import { execFile } from "node:child_process";
import { realpath, stat, readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, basename } from "node:path";
import { promisify } from "node:util";
import {
  classify,
  parseGoTest,
  type Classification,
  type GoTestReport,
} from "../workflow/executors/baseline.ts";
import { languageReminder, type OutputLocale } from "./language.ts";
import type { WorkspaceConflict } from "../git/provider.ts";
import { failedReport, type Finding, type SlopReport } from "../slop/findings.ts";
import { DETECTOR_VERSION } from "../slop/detectors.ts";
import {
  ENVIRONMENT_UNAVAILABLE_EXIT,
  ENVIRONMENT_UNAVAILABLE_MARKER,
} from "../platform/postgresBinaries.ts";

/**
 * Verification-and-repair loop for coding steps (harness layer around the Claude executor).
 *
 * After the agent submits a result, the platform — not the agent — runs the mandatory verification in every worktree
 * of the run. Failures are turned into structured diagnostics and fed back to the SAME Claude session for a bounded
 * number of repairs. The step only completes when verification passes; repeated identical failures stop early.
 * Everything here is deterministic and injectable so it can be tested without Claude or Go.
 */

const exec = promisify(execFile);

export interface VerifyConfig {
  broadCommand?: string;
  /** Shell command run in each worktree (trusted: comes from the workflow definition, never from the agent). */
  command: string;
  maxRepairs: number;
  timeoutMs: number;
  /** "go": failures that also fail on the base branch are pre-existing, not regressions. */
  baseline: "go" | null;
  /** Hard test-weakening signals (removed/skipped/disabled tests) fail verification unless explicitly allowed. */
  allowTestWeakening: boolean;
  requiredTests?: string[];
  contractRevision?: string;
  /**
   * Explicit, workflow-defined policy under which a change without executable tests (docs, config) is NOT_APPLICABLE
   * instead of NOT_EXECUTED. Honoured only when every changed file matches `allowedPaths`; never read from agent output.
   */
  notApplicable?: { allowedPaths: string[]; reason: string };
}

/**
 * `config.verify` of a coding step. Only the workflow DEFINITION decides (step config is platform-authored and versioned;
 * per-attempt pending input, agent output or anything inside the worktree is never consulted). `false` disables it —
 * the executor records that as outcome "disabled" so it shows up in evaluation.
 */
export function verifyConfig(
  stepConfig: Record<string, any>,
  defaultCommand: string,
): VerifyConfig | null {
  const v = stepConfig.verify;
  if (v === false) return null;
  const o = typeof v === "object" && v ? v : {};
  const command = typeof o.command === "string" && o.command.trim() ? o.command : defaultCommand;
  return {
    command,
    ...(typeof o.broad_command === "string" ? { broadCommand: o.broad_command } : {}),
    maxRepairs: Math.max(0, Math.min(5, Math.floor(Number(o.max_repairs ?? 2)) || 0)),
    timeoutMs: Math.max(30, Math.min(3600, Number(o.timeout_seconds ?? 600) || 600)) * 1000,
    baseline: o.baseline === null || o.baseline === false ? null : "go",
    allowTestWeakening: o.allow_test_weakening === true,
    ...(Array.isArray(o.required_tests) ? { requiredTests: o.required_tests } : {}),
    ...notApplicablePolicy(o.not_applicable),
  };
}

function notApplicablePolicy(v: unknown): {
  notApplicable?: NonNullable<VerifyConfig["notApplicable"]>;
} {
  const o = v as { allowed_paths?: unknown; reason?: unknown } | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.allowed_paths)) return {};
  const allowedPaths = o.allowed_paths.filter(
    (x): x is string => typeof x === "string" && !!x.trim(),
  );
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  return allowedPaths.length && reason ? { notApplicable: { allowedPaths, reason } } : {};
}

const globRe = (glob: string) =>
  new RegExp(
    "^" +
      glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "@@DIR@@")
        .replace(/\*\*/g, "@@ANY@@")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/@@DIR@@/g, "(?:.*/)?")
        .replace(/@@ANY@@/g, ".*") +
      "$",
  );
const TEST_FILE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$/;

/** Changes no test can exercise on their own: generated protobuf code, .proto schemas and swag-generated API docs. */
export const GENERATED_ONLY: NonNullable<VerifyConfig["notApplicable"]> = {
  allowedPaths: [
    "**/*.pb.go",
    "**/*.pb.*.go",
    "**/*.proto",
    "**/docs/docs.go",
    "**/docs/swagger.json",
    "**/docs/swagger.yaml",
  ],
  reason: "only generated protobuf code, .proto schemas or generated swagger docs changed",
};

/** True only when there is at least one changed file and every one is covered by the policy and is not a test file. */
export function notApplicableCovers(
  policy: VerifyConfig["notApplicable"],
  files: string[],
): boolean {
  if (!policy || !files.length) return false;
  const res = policy.allowedPaths.map(globRe);
  return files.every((f) => !TEST_FILE.test(f) && res.some((re) => re.test(f)));
}

/**
 * What the test command's output proves. `executed` = tests that actually ran and passed (null: no recognised runner
 * summary), `skipped` = tests the runner skipped, `marker` = the command itself said nothing was run. Exit code 0 is
 * never evidence on its own.
 */
export function testEvidence(output: string): {
  executed: number | null;
  skipped: number;
  marker: boolean;
} {
  const marker =
    /VERIFY_NOT_EXECUTED|no test runner detected|no matching test files|no Go packages changed|no platform test harness/.test(
      output,
    );
  let executed = 0;
  let skipped = 0;
  let recognised = false;
  const node = (name: string) => {
    const m = output.match(new RegExp(`^(?:#|ℹ)\\s+${name}\\s+(\\d+)\\s*$`, "gm"));
    return m ? m.reduce((n, l) => n + Number(l.match(/(\d+)\s*$/)![1]), 0) : null;
  };
  const pass = node("pass");
  if (pass !== null) {
    recognised = true;
    executed += pass;
    skipped += (node("skipped") ?? 0) + (node("todo") ?? 0);
  }
  const jest =
    output.match(/^Tests:.*?(\d+) passed/m) ?? output.match(/^\s*Tests\s+.*?(\d+) passed/m);
  if (jest) {
    recognised = true;
    executed += Number(jest[1]);
  }
  // Go: `ok  pkg  0.2s` (a package with `[no tests to run]` or `[no test files]` proves nothing) or verbose `--- PASS`.
  const goOk = (output.match(/^ok\s+\S+\s+(?:\(cached\)|[\d.]+s)\s*$/gm) ?? []).length;
  const goPass = (output.match(/^\s*--- PASS: /gm) ?? []).length;
  if (goOk || goPass) {
    recognised = true;
    executed += Math.max(goOk, goPass);
  }
  // `go test -json`: one event per line; only test-level pass/skip events count (package events prove nothing).
  const jsonPass = (output.match(/"Action":"pass"[^\n]*"Test":"/g) ?? []).length;
  const jsonSkip = (output.match(/"Action":"skip"[^\n]*"Test":"/g) ?? []).length;
  if (jsonPass || jsonSkip) {
    recognised = true;
    executed += jsonPass;
    skipped += jsonSkip;
  }
  return { executed: recognised ? executed : null, skipped, marker };
}

/**
 * passed: command succeeded and integrity checks are clean.
 * accepted_preexisting: the only failures are ones that also fail on the base branch, CONFIRMED by re-running with those
 *   tests excluded (anything else still failing → failed). Explicitly listed, never reported as a clean pass.
 * failed: regressions, unclassified failures, timeouts or hard test weakening — sent back to the agent for repair.
 * error: verification itself could not complete (integrity check or tooling failure) — not repairable by the agent.
 * skipped: the command reported that its environment cannot run the tests (e.g. no PostgreSQL), or the worktree could
 *   not be restored — nothing was tested,
 *   never counted as passed, not repairable by the agent.
 */
export type RepoStatus =
  | "passed"
  | "accepted_preexisting"
  | "failed"
  | "error"
  | "skipped"
  | "not_executed"
  | "not_applicable";
export type VerificationOutcome = "PASSED" | "FAILED" | "NOT_EXECUTED" | "NOT_APPLICABLE";
/** Reported outcome of a repo's verification, derived from its status. */
export const outcomeOf = (status: RepoStatus): VerificationOutcome =>
  status === "passed" || status === "accepted_preexisting"
    ? "PASSED"
    : status === "not_applicable"
      ? "NOT_APPLICABLE"
      : status === "not_executed" || status === "skipped" || status === "error"
        ? "NOT_EXECUTED"
        : "FAILED";

/** The reason a test command gave for not running at all (dedicated exit + marker line), or null. */
export function environmentUnavailable(code: number | null, output: string): string | null {
  if (code !== ENVIRONMENT_UNAVAILABLE_EXIT) return null;
  const line = output.split("\n").find((l) => l.startsWith(ENVIRONMENT_UNAVAILABLE_MARKER));
  return line ? line.slice(ENVIRONMENT_UNAVAILABLE_MARKER.length).trim() : null;
}

export interface RepoVerification {
  tested_state?: { head: string; fingerprint: string };
  contract_revision?: string;
  required_tests?: Record<string, "passed" | "failed" | "skipped" | "not_executed">;
  repo: string;
  status: RepoStatus;
  /** passed, accepted_preexisting or an authorized not_applicable. */
  passed: boolean;
  outcome?: VerificationOutcome;
  /** Tests that provably ran (null: no recognised runner summary) and tests the runner skipped. */
  test_evidence?: { executed: number | null; skipped: number; marker: boolean };
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  /** New failures (baseline-aware when available). */
  regressions: Array<{ package: string; tests: string[]; build_errors: string[] }>;
  pre_existing: number;
  pre_existing_tests: string[];
  /** Hard weakening: tests removed / skipped / disabled by this branch. */
  weakened: string[];
  /** Soft signals that automated checks cannot judge (e.g. many assertions removed): human review. */
  suspected: string[];
  needs_review: boolean;
  /** Relevant output lines for the agent (untrusted when shown). */
  excerpt: string;
  note?: string;
  error?: string;
  artifact_id?: number;
  commit_sha?: string;
  /** Slop detection for this worktree; `blocking` is non-empty only under enforcement. */
  slop?: SlopVerification;
  /** Present when this result was served from verification evidence instead of running the command. */
  evidence?: {
    reused: true;
    key: string;
    source_attempt_id: number | null;
    original_duration_ms: number;
    saved_ms: number;
    joined?: boolean;
  };
}
export type SlopVerification = SlopReport & { mode: string; blocking: Finding[] };
export interface VerificationRound {
  round: number;
  passed: boolean;
  /** At least one repo could not be verified (infrastructure / integrity error). */
  error: boolean;
  needs_review: boolean;
  repos: RepoVerification[];
  /** Stable fingerprint of the failure set; equal consecutive signatures = no progress. */
  signature: string;
  duration_ms: number;
  /** Evidence-cache counters for this round (absent when reuse is not configured). */
  evidence?: EvidenceStats;
}

/** Lines that explain a failure (test failures, compile errors, panics, assertion output), bounded. */
export function failureExcerpt(output: string, maxLines = 60, maxChars = 4000): string {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (
      /(--- FAIL|^FAIL\s|panic:|\berror\b|\.go:\d+:|\bexpected\b|\bwant\b|\bgot\b|Error Trace|cannot|undefined:|\[build failed\])/i.test(
        l,
      )
    )
      for (let k = i; k <= Math.min(i + 2, lines.length - 1); k++) keep.add(k);
  });
  let picked = [...keep].sort((a, b) => a - b).map((i) => lines[i]);
  if (!picked.length) picked = lines.filter((l) => l.trim()).slice(-40);
  const text = picked.slice(0, maxLines).join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…" : text;
}

/** Fingerprint: which tests / compile errors fail (durations, line numbers and addresses removed). */
export function failureSignature(repos: RepoVerification[]): string {
  const parts = repos
    .filter((r) => !r.passed)
    .map((r) => {
      const reg = r.regressions
        .map(
          (x) =>
            `${x.package}:${[...x.tests].sort().join(",")}|${[...x.build_errors].sort().join(",")}`,
        )
        .sort();
      const opaque = reg.length
        ? ""
        : r.excerpt
            .replace(/\d+(\.\d+)?s\b/g, "")
            .replace(/0x[0-9a-f]+/gi, "")
            .replace(/:\d+(:\d+)?/g, "")
            .replace(/\s+/g, " ")
            .slice(0, 400);
      const slop = r.slop?.blocking.length
        ? `|slop:${r.slop.blocking
            .map((f) => f.fingerprint)
            .sort()
            .join(",")}`
        : "";
      return `${r.repo}{${r.status === "error" ? `ERROR:${r.error ?? ""}` : ""}${reg.join(";")}${opaque}${r.timed_out ? "TIMEOUT" : ""}${r.weakened.length ? `|weakened:${r.weakened.join(",")}` : ""}${slop}}`;
    })
    .sort();
  return parts.join(" ");
}

const ASSERTION =
  /\bt\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\(|\b(assert|require)\.\w+\(|\.Expect\(|\bgomock\.|\bt\.Run\(/;

/**
 * Obvious test-weakening signals in a unified diff of *_test.go files (branch vs base). Regex heuristics: they catch
 * blatant cases (deleted/skipped/disabled tests) and flag suspicious ones for a human; they cannot prove test integrity.
 */
export function testWeakeningSignals(diff: string): { hard: string[]; soft: string[] } {
  const removed = new Set<string>();
  const added = new Set<string>();
  const hard: string[] = [];
  const soft: string[] = [];
  const assertDelta = new Map<string, number>();
  let file = "";
  let oldFile = "";
  for (const line of diff.split("\n")) {
    const g = line.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (g) ((oldFile = g[1]), (file = g[2]));
    const minus = line.match(/^--- a\/(.+)$/);
    if (minus) oldFile = minus[1];
    if (line === "+++ /dev/null" && /_test\.go$/.test(oldFile))
      hard.push(`${oldFile}: test file deleted`);
    const plus = line.match(/^\+\+\+ b\/(.+)$/);
    if (plus) file = plus[1];
    const r = line.match(/^-func (Test\w+)\(/);
    if (r) removed.add(r[1]);
    const a = line.match(/^\+func (Test\w+)\(/);
    if (a) added.add(a[1]);
    if (/^\+.*\bt\.(Skip|SkipNow|Skipf)\(/.test(line)) hard.push(`${file}: t.Skip added`);
    if (/^\+\s*\/\/\s*func Test\w+\(/.test(line)) hard.push(`${file}: test commented out`);
    if (/^\+\s*\/\/(go:build| \+build)\s.*\bignore\b/.test(line))
      hard.push(`${file}: build tag disables the file`);
    if (/^\+\s*if\s+false\s*\{/.test(line)) soft.push(`${file}: "if false" block added`);
    if (/^[-+]/.test(line) && !/^(\+\+\+|---)/.test(line) && ASSERTION.test(line))
      assertDelta.set(file, (assertDelta.get(file) ?? 0) + (line.startsWith("+") ? 1 : -1));
  }
  for (const t of removed) if (!added.has(t)) hard.push(`${t} removed`);
  for (const [f, d] of assertDelta) if (d <= -3) soft.push(`${f}: ${-d} assertion line(s) removed`);
  return { hard: [...new Set(hard)], soft: [...new Set(soft)] };
}
/** Hard signals only (kept for callers that only need the blocking list). */
export const testWeakening = (diff: string) => testWeakeningSignals(diff).hard;

export interface VerifyDeps {
  run(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
    signal: AbortSignal,
    onChunk?: (s: string) => void,
  ): Promise<{ code: number | null; output: string; timedOut: boolean }>;
  /** Base-branch report for failing packages (null when unavailable). */
  baseline?(repo: { repo: string; path: string }, failing: string[]): Promise<GoTestReport | null>;
  /** Tests skipped up front because they are known to fail on the same base commit. */
  knownFailures?(path: string): Promise<{ skipRegex: string | null; tests: string[] } | null>;
  diffTests?(path: string): Promise<string>;
  /** Every file changed against the base (committed, staged, unstaged, untracked); used by the NOT_APPLICABLE policy. */
  changedFiles?(path: string): Promise<string[]>;
  artifact?(name: string, content: string, data: Record<string, unknown>): Promise<number>;
  log?(text: string, data?: Record<string, unknown>): Promise<void> | void;
  /**
   * Optional slop scan of the worktree (deterministic, no model). null = disabled. Its failures never change the
   * verification status: they are recorded as slop.status "error" and flagged for review.
   */
  slop?(repo: { repo: string; path: string }): Promise<SlopVerification | null>;
  /** Optional evidence reuse + singleflight. Absent = always run (backward compatible). */
  evidence?: EvidenceCache;
}

/**
 * Canonical-path authorisation: the directory must exist and its realpath must equal the realpath of one of the run's
 * worktrees. Prefix checks on resolve() are not enough: a symlink inside (or named like) a worktree could point anywhere.
 */
export async function authorizeWorkspace(path: string, allowedRoots: string[]): Promise<string> {
  let real: string;
  try {
    real = await realpath(resolve(path));
    if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
  } catch (e) {
    throw new Error(
      `verification refused: ${path} is not an accessible worktree (${(e as Error).message})`,
    );
  }
  for (const root of allowedRoots) {
    const r = await realpath(resolve(root)).catch(() => null);
    if (r && r === real) return real;
  }
  throw new Error(
    `verification refused: ${path} is not a worktree of this run (resolves to ${real})`,
  );
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type RequiredTestTarget = { id: string; selector: string; format: "go" | "node"; command: string };
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const directGoJson = (command: string) =>
  /^go[ \t]+test[ \t]+-json(?:[ \t]+[-\w./=,*]+)*[ \t]*$/.test(command.trim());

async function plannedPath(path: string, allowMissing: boolean): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    if (!allowMissing || dirname(path) === path) return null;
    const parent = await plannedPath(dirname(path), true);
    return parent ? resolve(parent, basename(path)) : null;
  }
}

/** Resolve ownership before execution. Ambiguous IDs need an explicit repository:: selector. */
export async function requiredTestTargets(
  workspaces: Array<{ repo: string; path: string }>,
  ids: string[],
  beforeApproval = false,
) {
  const targets = new Map<string, RequiredTestTarget[]>();
  const problems: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id.trim() || id !== id.trim()) {
      problems.push("Invalid required test selector");
      continue;
    }
    const separator = id.indexOf("::");
    const repository = separator < 0 ? null : id.slice(0, separator);
    const selector = separator < 0 ? id : id.slice(separator + 2);
    if ("invalid" in normalizeScopePath(selector) || /[\s;$`|&<>]/.test(selector)) {
      problems.push(`${id}: invalid executable test selector`);
      continue;
    }
    const matches: Array<{ repo: string; target: RequiredTestTarget }> = [];
    for (const workspace of workspaces.filter((w) => !repository || w.repo === repository)) {
      if (/\.(?:[cm]?[jt]s)$/.test(selector) && !isAbsolute(selector)) {
        const root = await realpath(workspace.path).catch(() => null);
        const file = await plannedPath(resolve(workspace.path, selector), beforeApproval);
        const manifest = JSON.parse(
          await readFile(resolve(workspace.path, "package.json"), "utf8").catch(() => "{}"),
        );
        if (/\b(jest|vitest|mocha|ava)\b/.test(String(manifest.scripts?.test ?? ""))) {
          problems.push(
            `${id}: repository runner is incompatible with the Node structured test runner`,
          );
          continue;
        }
        if (
          !root ||
          !file ||
          relative(root, file).startsWith("..") ||
          isAbsolute(relative(root, file))
        )
          continue;
        const preload = /\.integration\./.test(selector) ? "test/setup.ts" : "test/env.ts";
        const hasPreload = await stat(resolve(root, preload))
          .then((s) => s.isFile())
          .catch(() => false);
        const args = [
          process.execPath,
          ...(hasPreload ? ["--import", `./${preload}`] : []),
          "--test",
          `--test-reporter=${fileURLToPath(new URL("./testReporter.mjs", import.meta.url))}`,
          file,
        ];
        matches.push({
          repo: workspace.repo,
          target: { id, selector: file, format: "node", command: args.map(shellQuote).join(" ") },
        });
      } else {
        const module = /^module\s+["']?([^\s"']+)/m.exec(
          await readFile(resolve(workspace.path, "go.mod"), "utf8").catch(() => ""),
        )?.[1];
        const testAt = selector.search(/\/Test[A-Za-z0-9_]/);
        if (
          !module ||
          testAt < 0 ||
          !/^Test[A-Za-z0-9_]+(?:\/[A-Za-z0-9_-]+)*$/.test(selector.slice(testAt + 1))
        )
          continue;
        const pkg = selector.slice(0, testAt),
          test = selector.slice(testAt + 1);
        if (pkg !== module && !pkg.startsWith(`${module}/`)) continue;
        const packagePath = pkg === module ? "." : `.${pkg.slice(module.length)}`;
        if (packagePath.split("/").includes("..")) continue;
        const root = await realpath(workspace.path).catch(() => null);
        const directory = await plannedPath(resolve(workspace.path, packagePath), beforeApproval);
        if (
          !root ||
          !directory ||
          relative(root, directory).startsWith("..") ||
          isAbsolute(relative(root, directory))
        )
          continue;
        const pattern = test.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        matches.push({
          repo: workspace.repo,
          target: {
            id,
            selector,
            format: "go",
            command: `go test -json -run ${shellQuote(`^${pattern}$`)} ${shellQuote(packagePath)}`,
          },
        });
      }
    }
    if (matches.length !== 1)
      problems.push(
        `${id}: ${matches.length ? "ambiguous repository; use repository::test ID" : "test has no authorized repository owner"}`,
      );
    else {
      const match = matches[0];
      targets.set(match.repo, [...(targets.get(match.repo) ?? []), match.target]);
    }
  }
  return { targets, problems };
}

function requiredTestStatus(
  output: string,
  target: RequiredTestTarget,
): NonNullable<RepoVerification["required_tests"]>[string] {
  if (output.endsWith("\n[output truncated]")) return "not_executed";
  let status: NonNullable<RepoVerification["required_tests"]>[string] = "not_executed";
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line);
      let next: NonNullable<RepoVerification["required_tests"]>[string] | null = null;
      if (target.format === "go" && `${event.Package}/${event.Test}` === target.selector)
        next =
          event.Action === "pass"
            ? "passed"
            : event.Action === "fail"
              ? "failed"
              : event.Action === "skip"
                ? "skipped"
                : null;
      if (
        target.format === "node" &&
        event.type === "platform:test-summary" &&
        event.complete === true &&
        event.file === target.selector &&
        [event.passed, event.failed, event.skipped].every(
          (count) => Number.isInteger(count) && count >= 0,
        )
      )
        next =
          event.failed > 0
            ? "failed"
            : event.skipped > 0
              ? "skipped"
              : event.passed > 0
                ? "passed"
                : null;
      if (next && status !== "failed" && status !== "skipped") status = next;
    } catch {
      /* Logs, including test stdout, are never passing evidence. */
    }
  }
  return status;
}

/** Run verification once in every worktree. Refuses to run anywhere else. */
export async function verifyWorkspaces(
  workspaces: Array<{ repo: string; path: string; branch?: string; skip?: string }>,
  allowedRoots: string[],
  cfg: VerifyConfig,
  round: number,
  signal: AbortSignal,
  deps: VerifyDeps,
  env: Record<string, string> = {},
): Promise<VerificationRound> {
  const t0 = Date.now();
  const repos: RepoVerification[] = [];
  const required = await requiredTestTargets(workspaces, cfg.requiredTests ?? []);
  for (const w of workspaces) {
    if (w.skip) {
      await deps.log?.(`■ verify ${w.repo}: SKIPPED (${w.skip})`, {
        repo: w.repo,
        verification: round,
        status: "skipped",
      });
      repos.push({
        repo: w.repo,
        status: "skipped",
        passed: false,
        exit_code: null,
        timed_out: false,
        duration_ms: 0,
        regressions: [],
        pre_existing: 0,
        pre_existing_tests: [],
        weakened: [],
        suspected: [],
        needs_review: true,
        excerpt: "",
        note: w.skip,
      });
      continue;
    }
    const p = await authorizeWorkspace(w.path, allowedRoots);
    const known =
      cfg.baseline === "go" && deps.knownFailures
        ? await deps.knownFailures(p).catch(() => null)
        : null;
    await deps.log?.(
      `◆ verify ${w.repo} (round ${round})${known?.tests.length ? `, skipping ${known.tests.length} test(s) known to fail on base` : ""}`,
    );
    const started = Date.now();
    const beforeState = await worktreeFingerprint(p).catch(() => null);
    const baseEnv = { ...env, REPO: w.repo, ...(w.branch ? { BRANCH: w.branch } : {}) };
    // Evidence reuse: any failure to establish the full key means a real run (fail closed).
    let flight: Extract<Awaited<ReturnType<EvidenceCache["begin"]>>, { kind: "lead" }> | null =
      null;
    if (deps.evidence && beforeState) {
      const parts = await evidenceParts(
        p,
        w,
        cfg,
        beforeState,
        baseEnv,
        known?.skipRegex ?? null,
      ).catch(() => null);
      const d = parts ? await deps.evidence.begin(w.repo, parts) : null;
      const reuse = (
        e: RepoVerification,
        extra: Partial<NonNullable<RepoVerification["evidence"]>>,
        key: string,
        why: string,
      ) => {
        const entry: RepoVerification = {
          ...e,
          evidence: {
            reused: true,
            key,
            source_attempt_id: null,
            original_duration_ms: e.duration_ms,
            saved_ms: e.duration_ms,
            ...extra,
          },
          duration_ms: Date.now() - started,
        };
        return (
          deps.log?.(
            `■ verify ${w.repo}: ${entry.status.toUpperCase()} (reused evidence ${key.slice(0, 12)}: ${why})`,
            {
              repo: w.repo,
              verification: round,
              status: entry.status,
              evidence: { reused: true, key },
            },
          ),
          entry
        );
      };
      if (d?.kind === "hit") {
        repos.push(
          reuse(
            d.record.result,
            { source_attempt_id: d.record.attempt_id },
            d.key,
            `same state as attempt #${d.record.attempt_id ?? "?"}, saved ${d.record.duration_ms}ms`,
          ),
        );
        continue;
      }
      if (d?.kind === "joined") {
        const shared = await d.promise;
        if (shared && !signal.aborted) {
          repos.push(
            reuse(shared, { joined: true }, d.key, "joined identical in-flight verification"),
          );
          continue;
        }
      }
      if (d?.kind === "lead") {
        flight = d;
        await deps.log?.(
          `◆ verify ${w.repo}: evidence miss (${d.reason}) key ${d.key.slice(0, 12)}`,
          { repo: w.repo, verification: round, evidence: { key: d.key, reason: d.reason } },
        );
      }
    }
    try {
      const runWith = (skip: string | null) =>
        deps.run(
          cfg.command,
          p,
          { ...baseEnv, ...(skip ? { GO_TEST_SKIP: skip } : {}) },
          cfg.timeoutMs,
          signal,
          (s) => void deps.log?.(s, { repo: w.repo, verification: round, stream: true }),
        );
      let r = await runWith(known?.skipRegex ?? null);
      if (signal.aborted) throw new Error("verification canceled");
      const headCommit = await exec("git", ["-C", p, "rev-parse", "HEAD"])
        .then(({ stdout }) => stdout.trim())
        .catch(() => "");
      const entry: RepoVerification = {
        repo: w.repo,
        status: r.code === 0 && !r.timedOut ? "passed" : "failed",
        passed: false,
        exit_code: r.code,
        timed_out: r.timedOut,
        duration_ms: 0,
        regressions: [],
        pre_existing: 0,
        pre_existing_tests: [],
        weakened: [],
        suspected: [],
        needs_review: false,
        excerpt: "",
        commit_sha: headCommit,
      };
      const unavailable = r.timedOut ? null : environmentUnavailable(r.code, r.output);
      if (unavailable)
        Object.assign(entry, {
          status: "skipped",
          needs_review: true,
          note: `environment unavailable: ${unavailable}`,
          excerpt: failureExcerpt(r.output),
        });
      if (entry.status === "failed") {
        entry.excerpt = failureExcerpt(r.output);
        const report = parseGoTest(r.output);
        const failing = Object.entries(report)
          .filter(([, x]) => x.status === "fail")
          .map(([k]) => k);
        let c: Classification | null = null;
        if (failing.length && cfg.baseline === "go" && deps.baseline) {
          const base = await deps
            .baseline({ repo: w.repo, path: p }, failing)
            .catch(
              (e) => (
                (entry.note = `baseline unavailable: ${(e as Error).message.split("\n")[0]}`),
                null
              ),
            );
          if (base) c = classify(report, base);
        }
        if (!failing.length)
          entry.note = `exit ${r.timedOut ? "timeout" : r.code} without a parseable test failure (build/script error) — counted as a failure`;
        if (c) {
          entry.regressions = c.regressions.map(({ package: pkg, tests, build_errors }) => ({
            package: pkg,
            tests,
            build_errors,
          }));
          entry.pre_existing = c.pre_existing.length;
          entry.pre_existing_tests = [
            ...new Set(c.pre_existing.flatMap((x) => x.tests.map((t) => t.split("/")[0]))),
          ];
          const preBuild = c.pre_existing.some((x) => x.build_errors.length || !x.tests.length);
          if (!r.timedOut && !entry.regressions.length) {
            if (preBuild) {
              // Base packages that do not even compile cannot be isolated with -skip: accept explicitly, flag for a human.
              Object.assign(entry, {
                status: "accepted_preexisting",
                needs_review: true,
                note: `${entry.pre_existing} package(s) fail on the base branch too, incl. build errors that cannot be isolated — needs human review`,
              });
            } else {
              // Confirm: re-run with the pre-existing tests excluded; anything still failing is not explained by the base.
              const skip = [
                known?.skipRegex,
                `^(${entry.pre_existing_tests.map(escapeRe).join("|")})$`,
              ]
                .filter(Boolean)
                .join("|");
              await deps.log?.(
                `◆ verify ${w.repo}: confirming that only pre-existing failures remain (re-run excluding ${entry.pre_existing_tests.length} test(s))`,
              );
              const again = await runWith(skip);
              if (signal.aborted) throw new Error("verification canceled");
              if (again.code === 0 && !again.timedOut)
                Object.assign(entry, {
                  status: "accepted_preexisting",
                  note: `only failures that also fail on the base branch (${entry.pre_existing_tests.join(", ")}); re-run without them passed`,
                });
              else {
                r = again;
                Object.assign(entry, {
                  status: "failed",
                  exit_code: again.code,
                  timed_out: again.timedOut,
                  excerpt: failureExcerpt(again.output),
                  note: "failures remain after excluding the pre-existing tests (unclassified) — counted as a failure",
                });
              }
            }
          }
        } else if (failing.length)
          entry.regressions = failing.map((pkg) => ({
            package: pkg,
            tests: report[pkg].tests,
            build_errors: report[pkg].buildErrors,
          }));
      }
      if (!cfg.allowTestWeakening && deps.diffTests) {
        try {
          const sig = testWeakeningSignals(await deps.diffTests(p));
          entry.weakened = sig.hard;
          entry.suspected = sig.soft;
          if (sig.hard.length && entry.status !== "error") entry.status = "failed";
          if (sig.soft.length) entry.needs_review = true;
        } catch (e) {
          // An integrity check that cannot run must never look like a clean result.
          Object.assign(entry, {
            status: "error",
            error: `could not inspect test changes: ${(e as Error).message.split("\n")[0]}`,
          });
        }
      }
      if (cfg.requiredTests?.length) {
        const results: NonNullable<RepoVerification["required_tests"]> = {};
        for (const target of required.targets.get(w.repo) ?? []) {
          let status =
            target.format === "go" && directGoJson(cfg.command)
              ? requiredTestStatus(r.output, target)
              : "not_executed";
          if (
            status === "not_executed" &&
            ["passed", "accepted_preexisting"].includes(entry.status)
          ) {
            const remaining = cfg.timeoutMs - (Date.now() - started);
            if (remaining > 0) {
              await deps.log?.(`◆ required test ${target.id} (${w.repo})`);
              const evidence = await deps.run(target.command, p, baseEnv, remaining, signal);
              if (signal.aborted) throw new Error("verification canceled");
              status = requiredTestStatus(evidence.output, target);
              r = { ...r, output: `${r.output}\n== required ${target.id}\n${evidence.output}` };
              if (evidence.code !== 0 || evidence.timedOut) {
                entry.status = "failed";
                entry.exit_code = evidence.code;
                entry.timed_out = evidence.timedOut;
                status = "failed";
              }
            }
          }
          results[target.id] = status;
        }
        entry.required_tests = results;
        if (Object.values(results).some((status) => status !== "passed")) {
          entry.status = "failed";
          entry.note = `Required tests lack passing structured evidence: ${JSON.stringify(results)}`;
        }
      }
      if (
        entry.status === "passed" &&
        !(
          cfg.requiredTests?.length &&
          Object.values(entry.required_tests ?? {}).every((x) => x === "passed")
        )
      ) {
        const ev = testEvidence(r.output);
        entry.test_evidence = ev;
        if (!ev.executed || ev.executed <= 0) {
          entry.status = "not_executed";
          entry.needs_review = true;
          entry.note = ev.marker
            ? "exit 0, but the command reported that no tests were run"
            : ev.skipped
              ? `exit 0, but every test was skipped (${ev.skipped})`
              : "exit 0, but the output contains no evidence that any test ran";
          const files = deps.changedFiles ? await deps.changedFiles(p).catch(() => []) : [];
          const policy = [cfg.notApplicable, GENERATED_ONLY].find((x) =>
            notApplicableCovers(x, files),
          );
          if (policy) {
            entry.status = "not_applicable";
            entry.note = `no executable tests apply: ${policy.reason}`;
          }
        }
      }
      if (deps.slop) {
        try {
          const report = await deps.slop({ repo: w.repo, path: p });
          if (report) entry.slop = report;
        } catch (e) {
          if (signal.aborted) throw e;
          entry.slop = {
            ...failedReport(
              `slop detection failed: ${(e as Error).message.split("\n")[0]}`,
              DETECTOR_VERSION,
            ),
            mode: "unknown",
            blocking: [],
          };
        }
        if (entry.slop?.status === "error") entry.needs_review = true;
        if (
          entry.slop?.blocking.length &&
          ["passed", "accepted_preexisting", "failed"].includes(entry.status)
        ) {
          entry.status = "failed";
          entry.note = [entry.note, `${entry.slop.blocking.length} blocking slop finding(s)`]
            .filter(Boolean)
            .join("; ");
        }
      }
      {
        const afterState = await worktreeFingerprint(p).catch(() => null);
        if (
          !beforeState ||
          !afterState ||
          JSON.stringify(beforeState) !== JSON.stringify(afterState)
        ) {
          if (entry.status !== "error" && entry.status !== "skipped") {
            entry.status = "failed";
            entry.note =
              "Workspace changed during verification or its state could not be established";
          }
        } else entry.tested_state = afterState;
        entry.contract_revision = cfg.contractRevision;
      }
      entry.passed =
        entry.status === "passed" ||
        entry.status === "accepted_preexisting" ||
        entry.status === "not_applicable";
      entry.outcome = outcomeOf(entry.status);
      entry.duration_ms = Date.now() - started;
      if (deps.artifact)
        entry.artifact_id = await deps.artifact(`verify-${round}-${w.repo}.log`, r.output, {
          exit_code: entry.exit_code,
          timed_out: entry.timed_out,
          round,
          status: entry.status,
        });
      await deps.log?.(
        `■ verify ${w.repo}: ${entry.status.toUpperCase()}${entry.note ? ` (${entry.note})` : ""}${entry.error ? ` — ${entry.error}` : ""}${entry.weakened.length ? ` — tests weakened: ${entry.weakened.join(", ")}` : ""}${entry.suspected.length ? ` — review: ${entry.suspected.join(", ")}` : ""}`,
        { repo: w.repo, verification: round, status: entry.status },
      );
      const why = flight ? await flight.settle(entry) : null;
      if (flight && why)
        await deps.log?.(`◆ verify ${w.repo}: evidence not stored (${why})`, {
          repo: w.repo,
          verification: round,
          evidence: { key: flight.key, not_stored: why },
        });
      repos.push(entry);
    } catch (e) {
      flight?.fail();
      throw e;
    }
  }
  if (required.problems.length && repos.length) {
    repos[0].status = "failed";
    repos[0].passed = false;
    repos[0].note = `Required test ownership could not be established: ${required.problems.join("; ")}`;
  }
  return {
    round,
    passed: repos.every((r) => r.passed),
    // Nothing ran: the agent cannot fix that by repairing code, so it is not a repairable failure.
    error: repos.some((r) => r.status === "error" || r.status === "not_executed"),
    needs_review: repos.some((r) => r.needs_review),
    repos,
    signature: failureSignature(repos),
    duration_ms: Date.now() - t0,
    ...(deps.evidence ? { evidence: structuredClone(deps.evidence.stats) } : {}),
  };
}

async function evidenceParts(
  path: string,
  w: { repo: string; skip?: string },
  cfg: VerifyConfig,
  state: { head: string; fingerprint: string },
  env: Record<string, string>,
  skip: string | null,
): Promise<EvidenceParts> {
  const vars = ["BASE_BRANCH", "RUN_ID", "REPO", "BRANCH"]
    .map((k) => `${k}=${env[k] ?? ""}`)
    .join("\n");
  return {
    repo_name: w.repo,
    workspace: path,
    head: state.head,
    workspace_fingerprint: state.fingerprint,
    base_tip: await baseTip(path, env.BASE_BRANCH),
    contract_revision: cfg.contractRevision ?? "",
    command: cfg.command,
    selectors: [...(cfg.requiredTests ?? [])].sort().join("\n"),
    policy: `allowTestWeakening=${cfg.allowTestWeakening}`,
    baseline: String(cfg.baseline),
    timeout: String(cfg.timeoutMs),
    env_fingerprint: await envFingerprint(path),
    env_vars: vars,
    skip: skip ?? "",
  };
}

export type LoopOutcome =
  | "passed"
  | "failed"
  | "no_progress"
  | "error"
  | "skipped"
  | "canceled"
  | "stopped";
export interface LoopResult<S> {
  outcome: LoopOutcome;
  rounds: VerificationRound[];
  repairs: number;
  stop?: S;
}

/**
 * verify → (repair → verify)* until passed, the repair budget is spent, or two consecutive rounds fail identically.
 * `prior` carries rounds from before a pause (questions asked during a repair) so the budget survives resume.
 */
export async function verificationLoop<S>(opts: {
  cfg: VerifyConfig;
  prior?: VerificationRound[];
  signal: AbortSignal;
  verify: (round: number) => Promise<VerificationRound>;
  /** Ask the agent to repair; return a value to stop the loop with it (e.g. waiting_input, agent error). */
  repair: (failed: VerificationRound, repairNo: number) => Promise<S | undefined>;
}): Promise<LoopResult<S>> {
  const rounds = [...(opts.prior ?? [])];
  for (;;) {
    if (opts.signal.aborted)
      return { outcome: "canceled", rounds, repairs: Math.max(0, rounds.length - 1) };
    let r: VerificationRound;
    try {
      r = await opts.verify(rounds.length + 1);
    } catch (e) {
      if (opts.signal.aborted)
        return { outcome: "canceled", rounds, repairs: Math.max(0, rounds.length - 1) };
      throw e;
    }
    rounds.push(r);
    const repairs = rounds.length - 1;
    if (r.passed) return { outcome: "passed", rounds, repairs };
    // The agent cannot repair the verification infrastructure: stop instead of spending repairs.
    if (r.error) return { outcome: "error", rounds, repairs };
    // Nothing left that a code change could fix: the environment could not run the tests.
    if (
      r.repos.some((x) => x.status === "skipped") &&
      r.repos.every((x) => x.passed || x.status === "skipped")
    )
      return { outcome: "skipped", rounds, repairs };
    if (repairs >= opts.cfg.maxRepairs) return { outcome: "failed", rounds, repairs };
    if (rounds.length >= 2 && rounds[rounds.length - 2].signature === r.signature)
      return { outcome: "no_progress", rounds, repairs };
    const stop = await opts.repair(r, repairs + 1);
    if (opts.signal.aborted) return { outcome: "canceled", rounds, repairs: repairs + 1 };
    if (stop !== undefined) return { outcome: "stopped", rounds, repairs: repairs + 1, stop };
  }
}

const untrusted = (label: string, body: string) =>
  `<untrusted_input source="${label}">\n${body.replace(/<\/untrusted_input>/g, "<\\/untrusted_input>")}\n</untrusted_input>`;

/** Repair instructions for the agent: actionable diagnostics, tool output marked untrusted, firm rules. */
export function repairPrompt(
  r: VerificationRound,
  repairNo: number,
  cfg: VerifyConfig,
  locale: OutputLocale = "vi",
): string {
  const parts = [
    `## Verification failed — repair ${repairNo} of ${cfg.maxRepairs}`,
    "The platform ran the mandatory verification on your worktree(s). Your result is NOT accepted until it passes.",
    `Command (fixed by the workflow; do not change it): \`${cfg.command.split("\n")[0]}${cfg.command.includes("\n") ? " …" : ""}\``,
  ];
  for (const x of r.repos.filter((y) => y.status === "failed")) {
    parts.push(
      `### ${x.repo}: ${x.timed_out ? "timed out" : `exit ${x.exit_code}`}${x.pre_existing ? ` (${x.pre_existing} package(s) also fail on the base branch — ignore those)` : ""}`,
    );
    if (x.regressions.length)
      parts.push(
        "New failures caused by this branch:\n" +
          x.regressions
            .map(
              (g) =>
                `- ${g.package}: ${[...g.tests, ...g.build_errors].slice(0, 12).join("; ") || "(package fails)"}`,
            )
            .join("\n"),
      );
    if (x.weakened.length)
      parts.push(
        `Tests were removed or skipped (not allowed): ${x.weakened.join(", ")}. Restore them; fix the code or correct the assertion instead.`,
      );
    if (x.slop?.blocking.length)
      parts.push(
        "Slop findings to fix (new or worsened by this branch; fix only these, inside the approved scope):",
        untrusted(
          `slop:${x.repo}`,
          x.slop.blocking
            .slice(0, 20)
            .map(
              (f) =>
                `- ${f.rule} ${f.path}:${f.line}${f.symbol ? ` (${f.symbol})` : ""}: ${f.message}\n  ${f.snippet.replace(/\n/g, "\n  ")}`,
            )
            .join("\n"),
        ),
        "Never remove security checks, business invariants, idempotency, transaction or concurrency safeguards, or public contracts just to clear a slop finding. If a finding is a false positive, leave the code and explain why in submit_result.",
      );
    if (x.excerpt) parts.push(untrusted(`verification:${x.repo}`, x.excerpt));
  }
  parts.push(
    "Rules: fix the cause in code (change a test only when the test itself is wrong, and say why in your result). Never delete, skip or weaken tests,",
    "never edit CI/verification scripts, and keep working only inside the worktree. Run the failing tests yourself to confirm, commit, then call",
    "mcp__platform__submit_result again with an updated summary. If the failure cannot be fixed within this task, explain why in submit_result.",
    languageReminder(locale),
  );
  return parts.join("\n\n");
}

/** Repos whose worktree could not be restored (branch held elsewhere) → why they are not verified; a human decides. */
export function restoreConflictSkips(
  blocked: { kind: string; checkpoint?: unknown } | null,
): Map<string, string> {
  const conflicts =
    blocked?.kind === "waiting_input"
      ? ((blocked.checkpoint as { workspace_conflict?: WorkspaceConflict[] } | undefined)
          ?.workspace_conflict ?? [])
      : [];
  return new Map(
    conflicts.map((c) => [
      c.repo,
      `workspace conflict while restoring the worktree, tests not run: ${c.branch} is checked out at ${c.holder_path} (${c.reason})`,
    ]),
  );
}

/** Compact record for outputs, metrics and the checkpoint. */
export function verificationSummary(cfg: VerifyConfig, res: LoopResult<unknown>) {
  const last = res.rounds.at(-1);
  const accepted = !!last?.repos.some((r) => r.status === "accepted_preexisting");
  const reviewReasons = (last?.repos ?? []).flatMap((r) => [
    ...r.suspected,
    ...(r.needs_review && ["accepted_preexisting", "skipped"].includes(r.status)
      ? [`${r.repo}: ${r.note}`]
      : []),
  ]);
  return {
    contract_revision: cfg.contractRevision,
    outcome: res.outcome,
    /** clean | accepted_with_preexisting | failed | error | … — what kind of pass/failure this was. */
    status:
      res.outcome === "passed" ? (accepted ? "accepted_with_preexisting" : "clean") : res.outcome,
    /** null when the tests could not run at all (skipped): neither a pass nor a code failure. */
    passed: res.outcome === "skipped" ? null : res.outcome === "passed",
    needs_review: reviewReasons.length > 0,
    review_reasons: reviewReasons,
    errors: (last?.repos ?? [])
      .filter((r) => r.status === "error" || r.status === "not_executed")
      .map((r) => `${r.repo}: ${r.error ?? r.note}`),
    outcome_by_repo: Object.fromEntries(
      (last?.repos ?? []).map((r) => [r.repo, r.outcome ?? outcomeOf(r.status)]),
    ),
    rounds: res.rounds.length,
    repairs: res.repairs,
    max_repairs: cfg.maxRepairs,
    duration_ms: res.rounds.reduce((s, r) => s + r.duration_ms, 0),
    failure_signatures: res.rounds.filter((r) => !r.passed).map((r) => r.signature),
    ...slopSummary(last?.repos ?? []),
    // Cumulative evidence-cache counters (the cache lives for the whole step), from the last round that has them.
    ...(res.rounds.findLast((r) => r.evidence)?.evidence
      ? { evidence: res.rounds.findLast((r) => r.evidence)!.evidence }
      : {}),
    last:
      last?.repos.map(
        ({
          repo,
          status,
          outcome,
          evidence,
          passed,
          exit_code,
          timed_out,
          regressions,
          pre_existing,
          pre_existing_tests,
          weakened,
          suspected,
          needs_review,
          note,
          error,
          artifact_id,
          tested_state,
          contract_revision,
          required_tests,
          slop,
        }) => ({
          repo,
          status,
          outcome: outcome ?? outcomeOf(status),
          evidence,
          passed,
          exit_code,
          timed_out,
          regressions,
          pre_existing,
          pre_existing_tests,
          weakened,
          suspected,
          needs_review,
          note,
          error,
          artifact_id,
          tested_state,
          contract_revision,
          required_tests,
          ...(slop ? { slop: { ...slop, findings: slop.findings.slice(0, 50) } } : {}),
        }),
      ) ?? [],
  };
}

/** Run-level slop totals of the last round (absent when no repo was scanned). llm_tokens is always 0. */
function slopSummary(repos: RepoVerification[]) {
  const scanned = repos.filter((r) => r.slop).map((r) => r.slop!);
  if (!scanned.length) return {};
  const sum = (pick: (s: SlopVerification) => Record<string, number>) =>
    scanned.reduce<Record<string, number>>((acc, s) => {
      for (const [k, v] of Object.entries(pick(s))) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    }, {});
  return {
    slop: {
      mode: scanned[0].mode,
      level: scanned[0].level,
      status: scanned.some((s) => s.status === "error")
        ? "error"
        : scanned.some((s) => s.status === "partial")
          ? "partial"
          : "ok",
      counts: sum((s) => s.counts),
      by_category: sum((s) => s.by_category),
      blocking: scanned.flatMap((s) =>
        s.blocking.map(({ rule, path, line, symbol, fingerprint }) => ({
          rule,
          path,
          line,
          symbol,
          fingerprint,
        })),
      ),
      detector_ms: scanned.reduce((n, s) => n + s.detector_ms, 0),
      files_scanned: scanned.reduce((n, s) => n + s.files_scanned, 0),
      cache_hits: scanned.reduce((n, s) => n + s.cache_hits, 0),
      llm_tokens: 0,
      unsupported_rules: scanned[0].unsupported_rules,
      errors: scanned.flatMap((s) => s.errors),
    },
  };
}

/** `git diff origin/<base> -- *_test.go` of the worktree (committed + uncommitted changes). */
export async function diffTestsAgainstBase(path: string, baseBranch: string) {
  const { stdout } = await exec(
    "git",
    ["-C", path, "diff", "--no-color", `origin/${baseBranch}`, "--", "*_test.go"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
}
