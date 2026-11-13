import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  classify,
  parseGoTest,
  type Classification,
  type GoTestReport,
} from "../workflow/executors/baseline.ts";
import { languageReminder, type OutputLocale } from "./language.ts";
import type { WorkspaceConflict } from "../git/provider.ts";
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
  /** Shell command run in each worktree (trusted: comes from the workflow definition, never from the agent). */
  command: string;
  maxRepairs: number;
  timeoutMs: number;
  /** "go": failures that also fail on the base branch are pre-existing, not regressions. */
  baseline: "go" | null;
  /** Hard test-weakening signals (removed/skipped/disabled tests) fail verification unless explicitly allowed. */
  allowTestWeakening: boolean;
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
    maxRepairs: Math.max(0, Math.min(5, Math.floor(Number(o.max_repairs ?? 2)) || 0)),
    timeoutMs: Math.max(30, Math.min(3600, Number(o.timeout_seconds ?? 600) || 600)) * 1000,
    baseline: o.baseline === null || o.baseline === false ? null : "go",
    allowTestWeakening: o.allow_test_weakening === true,
  };
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
export type RepoStatus = "passed" | "accepted_preexisting" | "failed" | "error" | "skipped";

/** The reason a test command gave for not running at all (dedicated exit + marker line), or null. */
export function environmentUnavailable(code: number | null, output: string): string | null {
  if (code !== ENVIRONMENT_UNAVAILABLE_EXIT) return null;
  const line = output.split("\n").find((l) => l.startsWith(ENVIRONMENT_UNAVAILABLE_MARKER));
  return line ? line.slice(ENVIRONMENT_UNAVAILABLE_MARKER.length).trim() : null;
}

export interface RepoVerification {
  repo: string;
  status: RepoStatus;
  /** passed or accepted_preexisting. */
  passed: boolean;
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
}
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
      return `${r.repo}{${r.status === "error" ? `ERROR:${r.error ?? ""}` : ""}${reg.join(";")}${opaque}${r.timed_out ? "TIMEOUT" : ""}${r.weakened.length ? `|weakened:${r.weakened.join(",")}` : ""}}`;
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
  artifact?(name: string, content: string, data: Record<string, unknown>): Promise<number>;
  log?(text: string, data?: Record<string, unknown>): Promise<void> | void;
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
    const baseEnv = { ...env, REPO: w.repo, ...(w.branch ? { BRANCH: w.branch } : {}) };
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
    entry.passed = entry.status === "passed" || entry.status === "accepted_preexisting";
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
    repos.push(entry);
  }
  return {
    round,
    passed: repos.every((r) => r.passed),
    error: repos.some((r) => r.status === "error"),
    needs_review: repos.some((r) => r.needs_review),
    repos,
    signature: failureSignature(repos),
    duration_ms: Date.now() - t0,
  };
}

export type LoopOutcome =
  "passed" | "failed" | "no_progress" | "error" | "skipped" | "canceled" | "stopped";
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
    outcome: res.outcome,
    /** clean | accepted_with_preexisting | failed | error | … — what kind of pass/failure this was. */
    status:
      res.outcome === "passed" ? (accepted ? "accepted_with_preexisting" : "clean") : res.outcome,
    /** null when the tests could not run at all (skipped): neither a pass nor a code failure. */
    passed: res.outcome === "skipped" ? null : res.outcome === "passed",
    needs_review: reviewReasons.length > 0,
    review_reasons: reviewReasons,
    errors: (last?.repos ?? [])
      .filter((r) => r.status === "error")
      .map((r) => `${r.repo}: ${r.error}`),
    rounds: res.rounds.length,
    repairs: res.repairs,
    max_repairs: cfg.maxRepairs,
    duration_ms: res.rounds.reduce((s, r) => s + r.duration_ms, 0),
    failure_signatures: res.rounds.filter((r) => !r.passed).map((r) => r.signature),
    last:
      last?.repos.map(
        ({
          repo,
          status,
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
        }) => ({
          repo,
          status,
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
        }),
      ) ?? [],
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
