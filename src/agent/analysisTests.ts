import { join } from "node:path";
import { redactContextText } from "../context/redact.ts";
import { inspectGoTests, type UnsafeFinding } from "./testSafety.ts";
import { environmentUnavailable, failureExcerpt, testEvidence } from "./verify.ts";

/**
 * Test execution for read-only (analysis) steps. The agent never runs `go test` itself (tool policy): it asks for it
 * here, and the platform (1) inspects the test code first, (2) runs only the packages without external-service
 * signals, (3) runs them in the verification sandbox with the network cut, credentials masked and the repository
 * mounted read-only, and (4) reports exact exit codes, what was not run and why. Nothing is inferred from a pass
 * when part of the repository was skipped: that is `incomplete`, never `passed`.
 */

export interface IsolatedResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}
export type IsolatedRunner = (
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
  opts: { readOnly: true },
) => Promise<IsolatedResult>;

export interface AnalysisTestRequest {
  repository: string;
  path: string;
  packages?: string[];
  run?: string;
  race?: boolean;
  timeoutMs: number;
  signal: AbortSignal;
  sandboxAvailable: boolean;
  runner: IsolatedRunner;
}
export interface ModuleRun {
  module: string;
  command: string;
  exit_code: number | null;
  timed_out: boolean;
  packages_run: number;
  tests_executed: number | null;
  tests_skipped: number;
  duration_ms: number;
  excerpt: string;
  /** Redacted complete output, for the evidence artifact (not returned to the agent). */
  log: string;
}
export interface AnalysisTestReport {
  repository: string;
  status: "passed" | "failed" | "incomplete" | "skipped";
  exit_code: number | null;
  modules: Array<Omit<ModuleRun, "log">>;
  unsafe_packages: Array<{ module: string; package: string; findings: UnsafeFinding[] }>;
  /** Everything that was not verified, one line each: unsafe packages, skipped repositories, environment, timeouts. */
  incomplete: string[];
  sandbox: { network: "none"; repository: "read-only"; credentials: "masked" };
}

const MAX_PACKAGES = 400;
const PACKAGE = /^(?:\.\/)?[\w@+-][\w.@+/-]*?(?:\/\.\.\.)?$|^(?:\.\/)?\.\.\.$|^\.$/;
const RUN_FILTER = /^[\w.*+?|()[\]^$\\/ -]{1,200}$/;
const quote = (s: string) => `'${s}'`;

function selectPackages(
  requested: string[] | undefined,
  dir: string,
  available: string[],
): { selected: string[]; unmatched: string[] } {
  if (!requested?.length) return { selected: available, unmatched: [] };
  const repoRelative = (p: string) => (dir === "." ? p : p === "." ? dir : `${dir}/${p}`);
  const selected = new Set<string>();
  const unmatched: string[] = [];
  for (const raw of requested) {
    const p = raw.replace(/^\.\//, "");
    const recursive = p === "..." || p.endsWith("...");
    const tree = recursive ? p.replace(/\/?\.\.\.$/, "") : p;
    const hits = available.filter((a) => {
      const rel = repoRelative(a);
      return recursive ? !tree || rel === tree || rel.startsWith(tree + "/") : rel === p;
    });
    if (!hits.length) unmatched.push(raw);
    for (const h of hits) selected.add(h);
  }
  return { selected: [...selected], unmatched };
}

export interface AnalysisTestOutcome {
  report: AnalysisTestReport;
  logs: Array<{ module: string; command: string; log: string }>;
}

export async function runAnalysisTests(req: AnalysisTestRequest): Promise<AnalysisTestOutcome> {
  const incomplete: string[] = [];
  const modules: ModuleRun[] = [];
  const logs: Array<{ module: string; command: string; log: string }> = [];
  const unsafe: AnalysisTestReport["unsafe_packages"] = [];
  const base = {
    repository: req.repository,
    sandbox: { network: "none", repository: "read-only", credentials: "masked" } as const,
  };
  let failedRun: ModuleRun | undefined;
  const done = (status: AnalysisTestReport["status"]): AnalysisTestOutcome => {
    return {
      report: {
        ...base,
        status,
        exit_code: (failedRun ?? modules[0])?.exit_code ?? null,
        modules: modules.map(({ log: _log, ...m }) => m),
        unsafe_packages: unsafe,
        incomplete,
      },
      logs,
    };
  };
  if (req.run && !RUN_FILTER.test(req.run)) {
    incomplete.push("the run filter is not a plain regular expression: no test was run");
    return done("skipped");
  }
  const badPackage = req.packages?.find(
    (p) => p.startsWith("-") || p.includes("../") || !PACKAGE.test(p),
  );
  if (badPackage !== undefined) {
    incomplete.push(
      `package pattern "${badPackage.slice(0, 80)}" is not a repository-relative directory: no test was run`,
    );
    return done("skipped");
  }
  const inspection = await inspectGoTests(req.path);
  if (!inspection.modules.length) {
    incomplete.push("no Go module with test files: this repository was not test-verified");
    return done("skipped");
  }
  if (inspection.truncated)
    incomplete.push(
      "the source scan hit its file limit: packages beyond it were not inspected or run",
    );
  if (!req.sandboxAvailable) {
    incomplete.push(
      "no network-isolated sandbox (bubblewrap) on this worker: tests never run unsandboxed, so nothing was executed",
    );
    return done("skipped");
  }
  const unmatched = new Set(req.packages ?? []);
  for (const m of inspection.modules) {
    const { selected, unmatched: none } = selectPackages(req.packages, m.dir, m.packages);
    for (const p of req.packages ?? []) if (!none.includes(p)) unmatched.delete(p);
    const flagged = new Set(m.unsafe.map((u) => u.package));
    for (const u of m.unsafe)
      if (selected.includes(u.package)) {
        unsafe.push({ module: m.dir, package: u.package, findings: u.findings.slice(0, 5) });
      }
    const safe = selected.filter((p) => !flagged.has(p));
    const skippedUnsafe = selected.length - safe.length;
    if (skippedUnsafe)
      incomplete.push(
        `${skippedUnsafe} package(s) in module ${m.dir} were NOT run: their code shows signals of real external services (hardcoded credentials, external endpoints or cloud SDKs); \`go test -short\` is not a safeguard`,
      );
    if (!safe.length) continue;
    const run = safe.slice(0, MAX_PACKAGES);
    if (safe.length > run.length)
      incomplete.push(
        `${safe.length - run.length} safe package(s) in module ${m.dir} were not run: pass \`packages\` to run them in batches`,
      );
    const targets = run.map((p) => quote(p === "." ? "." : "./" + p)).join(" ");
    const command = `go test -count=1${req.race ? " -race" : ""}${req.run ? ` -run ${quote(req.run)}` : ""} ${targets}`;
    const started = Date.now();
    const r = await req.runner(
      command,
      join(req.path, m.dir),
      {
        GOFLAGS: "-mod=readonly",
        GOPROXY: "off",
        GOTOOLCHAIN: "local",
        CGO_ENABLED: req.race ? "1" : "0",
      },
      req.timeoutMs,
      req.signal,
      { readOnly: true },
    );
    const evidence = testEvidence(r.output);
    const unavailable = environmentUnavailable(r.code, r.output);
    const failed = r.code !== null && r.code !== 0 && !r.timedOut && !unavailable;
    if (r.timedOut)
      incomplete.push(`module ${m.dir}: timed out after ${Math.round(req.timeoutMs / 1000)}s`);
    else if (r.code === null)
      incomplete.push(`module ${m.dir}: the test process did not finish (no exit code)`);
    else if (unavailable) incomplete.push(`module ${m.dir}: ${unavailable}`);
    else if (!failed && !evidence.executed)
      incomplete.push(`module ${m.dir}: exit 0 but no executed test could be confirmed`);
    const log = redactContextText(
      `$ ${command}\n# cwd ${m.dir}, exit ${r.code}${r.timedOut ? " (timed out)" : ""}, network none, repository read-only\n\n${r.output}`,
    );
    logs.push({ module: m.dir, command, log });
    const entry: ModuleRun = {
      module: m.dir,
      command,
      exit_code: r.code,
      timed_out: r.timedOut,
      packages_run: run.length,
      tests_executed: evidence.executed,
      tests_skipped: evidence.skipped,
      duration_ms: Date.now() - started,
      excerpt: redactContextText(r.code === 0 ? "" : failureExcerpt(r.output, 40, 3000)),
      log,
    };
    modules.push(entry);
    if (failed) failedRun ??= entry;
  }
  for (const p of unmatched) incomplete.push(`no test package matches "${p.slice(0, 80)}"`);
  if (!modules.length) {
    incomplete.push("no safe test package was run");
    return done("skipped");
  }
  return done(failedRun ? "failed" : incomplete.length ? "incomplete" : "passed");
}
