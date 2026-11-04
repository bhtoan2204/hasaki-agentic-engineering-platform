import { execFile } from "node:child_process";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { classify, parseGoTest, type Classification, type GoTestReport } from "../workflow/executors/baseline.ts";

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
  /** Deleting Test functions or adding t.Skip counts as weakening verification unless explicitly allowed. */
  allowTestWeakening: boolean;
}

/** `config.verify` of a coding step: false disables it; an object overrides defaults. */
export function verifyConfig(stepConfig: Record<string, any>, defaultCommand: string): VerifyConfig | null {
  const v = stepConfig.verify;
  if (v === false) return null;
  const o = typeof v === "object" && v ? v : {};
  return {
    command: String(o.command ?? defaultCommand),
    maxRepairs: Math.max(0, Math.min(5, Number(o.max_repairs ?? 2))),
    timeoutMs: Number(o.timeout_seconds ?? 600) * 1000,
    baseline: o.baseline === null || o.baseline === false ? null : "go",
    allowTestWeakening: o.allow_test_weakening === true,
  };
}

export interface RepoVerification {
  repo: string;
  passed: boolean;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  /** New failures (baseline-aware when available). */
  regressions: Array<{ package: string; tests: string[]; build_errors: string[] }>;
  pre_existing: number;
  /** Tests removed / skipped by this branch (verification weakening). */
  weakened: string[];
  /** Relevant output lines for the agent (untrusted when shown). */
  excerpt: string;
  note?: string;
  artifact_id?: number;
}
export interface VerificationRound {
  round: number;
  passed: boolean;
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
    if (/(--- FAIL|^FAIL\s|panic:|\berror\b|\.go:\d+:|\bexpected\b|\bwant\b|\bgot\b|Error Trace|cannot|undefined:|\[build failed\])/i.test(l))
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
      const reg = r.regressions.map((x) => `${x.package}:${[...x.tests].sort().join(",")}|${[...x.build_errors].sort().join(",")}`).sort();
      const opaque = reg.length ? "" : r.excerpt.replace(/\d+(\.\d+)?s\b/g, "").replace(/0x[0-9a-f]+/gi, "").replace(/:\d+(:\d+)?/g, "").replace(/\s+/g, " ").slice(0, 400);
      return `${r.repo}{${reg.join(";")}${opaque}${r.timed_out ? "TIMEOUT" : ""}${r.weakened.length ? `|weakened:${r.weakened.join(",")}` : ""}}`;
    })
    .sort();
  return parts.join(" ");
}

/** Removed `func TestX` and added `t.Skip` in a unified diff of *_test.go files (branch vs base). */
export function testWeakening(diff: string): string[] {
  const removed = new Set<string>();
  const added = new Set<string>();
  const skips: string[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    const f = line.match(/^\+\+\+ b\/(.+)$/);
    if (f) file = f[1];
    const r = line.match(/^-func (Test\w+)\(/);
    if (r) removed.add(r[1]);
    const a = line.match(/^\+func (Test\w+)\(/);
    if (a) added.add(a[1]);
    if (/^\+.*\bt\.(Skip|SkipNow|Skipf)\(/.test(line)) skips.push(`${file}: t.Skip added`);
  }
  return [...[...removed].filter((t) => !added.has(t)).map((t) => `${t} removed`), ...skips];
}

export interface VerifyDeps {
  run(command: string, cwd: string, env: Record<string, string>, timeoutMs: number, signal: AbortSignal, onChunk?: (s: string) => void): Promise<{ code: number | null; output: string; timedOut: boolean }>;
  /** Base-branch report for failing packages (null when unavailable). */
  baseline?(repo: { repo: string; path: string }, failing: string[]): Promise<GoTestReport | null>;
  /** Tests skipped up front because they are known to fail on the same base commit. */
  knownFailures?(path: string): Promise<{ skipRegex: string | null; tests: string[] } | null>;
  diffTests?(path: string): Promise<string>;
  artifact?(name: string, content: string, data: Record<string, unknown>): Promise<number>;
  log?(text: string, data?: Record<string, unknown>): Promise<void> | void;
}

/** Run verification once in every worktree. Refuses to run anywhere else. */
export async function verifyWorkspaces(
  workspaces: Array<{ repo: string; path: string; branch?: string }>,
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
    const p = resolve(w.path);
    if (!allowedRoots.some((r) => p === resolve(r) || p.startsWith(resolve(r) + sep))) throw new Error(`verification refused: ${w.path} is not a worktree of this run`);
    const known = cfg.baseline === "go" && deps.knownFailures ? await deps.knownFailures(p) : null;
    await deps.log?.(`◆ verify ${w.repo} (round ${round})${known?.tests.length ? `, skipping ${known.tests.length} test(s) known to fail on base` : ""}`);
    const started = Date.now();
    const r = await deps.run(cfg.command, p, { ...env, REPO: w.repo, ...(w.branch ? { BRANCH: w.branch } : {}), ...(known?.skipRegex ? { GO_TEST_SKIP: known.skipRegex } : {}) }, cfg.timeoutMs, signal, (s) => void deps.log?.(s, { repo: w.repo, verification: round, stream: true }));
    if (signal.aborted) throw new Error("verification canceled");
    const entry: RepoVerification = { repo: w.repo, passed: r.code === 0 && !r.timedOut, exit_code: r.code, timed_out: r.timedOut, duration_ms: Date.now() - started, regressions: [], pre_existing: 0, weakened: [], excerpt: "" };
    if (!entry.passed) {
      entry.excerpt = failureExcerpt(r.output);
      const report = parseGoTest(r.output);
      const failing = Object.entries(report).filter(([, x]) => x.status === "fail").map(([k]) => k);
      let c: Classification | null = null;
      if (failing.length && cfg.baseline === "go" && deps.baseline) {
        const base = await deps.baseline({ repo: w.repo, path: p }, failing).catch(() => null);
        if (base) c = classify(report, base);
      }
      if (c) {
        entry.regressions = c.regressions.map(({ package: pkg, tests, build_errors }) => ({ package: pkg, tests, build_errors }));
        entry.pre_existing = c.pre_existing.length;
        // Only failures that also happen on the base branch: not caused by this change.
        if (!r.timedOut && !entry.regressions.length) (entry.passed = true), (entry.note = `${entry.pre_existing} package(s) fail on the base branch too (pre-existing)`);
      } else entry.regressions = failing.map((pkg) => ({ package: pkg, tests: report[pkg].tests, build_errors: report[pkg].buildErrors }));
    }
    if (!cfg.allowTestWeakening && deps.diffTests) {
      entry.weakened = testWeakening(await deps.diffTests(p).catch(() => ""));
      if (entry.weakened.length) entry.passed = false;
    }
    if (deps.artifact) entry.artifact_id = await deps.artifact(`verify-${round}-${w.repo}.log`, r.output, { exit_code: r.code, timed_out: r.timedOut, round, passed: entry.passed });
    await deps.log?.(`■ verify ${w.repo}: ${entry.passed ? "passed" : "FAILED"}${entry.note ? ` (${entry.note})` : ""}${entry.weakened.length ? ` — tests weakened: ${entry.weakened.join(", ")}` : ""}`, { repo: w.repo, verification: round, passed: entry.passed });
    repos.push(entry);
  }
  return { round, passed: repos.every((r) => r.passed), repos, signature: failureSignature(repos), duration_ms: Date.now() - t0 };
}

export type LoopOutcome = "passed" | "failed" | "no_progress" | "canceled" | "stopped";
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
    if (opts.signal.aborted) return { outcome: "canceled", rounds, repairs: Math.max(0, rounds.length - 1) };
    let r: VerificationRound;
    try {
      r = await opts.verify(rounds.length + 1);
    } catch (e) {
      if (opts.signal.aborted) return { outcome: "canceled", rounds, repairs: Math.max(0, rounds.length - 1) };
      throw e;
    }
    rounds.push(r);
    const repairs = rounds.length - 1;
    if (r.passed) return { outcome: "passed", rounds, repairs };
    if (repairs >= opts.cfg.maxRepairs) return { outcome: "failed", rounds, repairs };
    if (rounds.length >= 2 && rounds[rounds.length - 2].signature === r.signature) return { outcome: "no_progress", rounds, repairs };
    const stop = await opts.repair(r, repairs + 1);
    if (opts.signal.aborted) return { outcome: "canceled", rounds, repairs: repairs + 1 };
    if (stop !== undefined) return { outcome: "stopped", rounds, repairs: repairs + 1, stop };
  }
}

const untrusted = (label: string, body: string) => `<untrusted_input source="${label}">\n${body.replace(/<\/untrusted_input>/g, "<\\/untrusted_input>")}\n</untrusted_input>`;

/** Repair instructions for the agent: actionable diagnostics, tool output marked untrusted, firm rules. */
export function repairPrompt(r: VerificationRound, repairNo: number, cfg: VerifyConfig): string {
  const parts = [
    `## Verification failed — repair ${repairNo} of ${cfg.maxRepairs}`,
    "The platform ran the mandatory verification on your worktree(s). Your result is NOT accepted until it passes.",
    `Command (fixed by the workflow; do not change it): \`${cfg.command.split("\n")[0]}${cfg.command.includes("\n") ? " …" : ""}\``,
  ];
  for (const x of r.repos.filter((y) => !y.passed)) {
    parts.push(`### ${x.repo}: ${x.timed_out ? "timed out" : `exit ${x.exit_code}`}${x.pre_existing ? ` (${x.pre_existing} package(s) also fail on the base branch — ignore those)` : ""}`);
    if (x.regressions.length)
      parts.push("New failures caused by this branch:\n" + x.regressions.map((g) => `- ${g.package}: ${[...g.tests, ...g.build_errors].slice(0, 12).join("; ") || "(package fails)"}`).join("\n"));
    if (x.weakened.length) parts.push(`Tests were removed or skipped (not allowed): ${x.weakened.join(", ")}. Restore them; fix the code or correct the assertion instead.`);
    if (x.excerpt) parts.push(untrusted(`verification:${x.repo}`, x.excerpt));
  }
  parts.push(
    "Rules: fix the cause in code (change a test only when the test itself is wrong, and say why in your result). Never delete, skip or weaken tests,",
    "never edit CI/verification scripts, and keep working only inside the worktree. Run the failing tests yourself to confirm, commit, then call",
    "mcp__platform__submit_result again with an updated summary. If the failure cannot be fixed within this task, explain why in submit_result.",
  );
  return parts.join("\n\n");
}

/** Compact record for outputs, metrics and the checkpoint. */
export function verificationSummary(cfg: VerifyConfig, res: LoopResult<unknown>) {
  return {
    outcome: res.outcome,
    passed: res.outcome === "passed",
    rounds: res.rounds.length,
    repairs: res.repairs,
    max_repairs: cfg.maxRepairs,
    duration_ms: res.rounds.reduce((s, r) => s + r.duration_ms, 0),
    failure_signatures: res.rounds.filter((r) => !r.passed).map((r) => r.signature),
    last: res.rounds.at(-1)?.repos.map(({ repo, passed, exit_code, timed_out, regressions, pre_existing, weakened, note, artifact_id }) => ({ repo, passed, exit_code, timed_out, regressions, pre_existing, weakened, note, artifact_id })) ?? [],
  };
}

/** `git diff origin/<base> -- *_test.go` of the worktree (committed + uncommitted changes). */
export async function diffTestsAgainstBase(path: string, baseBranch: string) {
  const { stdout } = await exec("git", ["-C", path, "diff", "--no-color", `origin/${baseBranch}`, "--", "*_test.go"], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
