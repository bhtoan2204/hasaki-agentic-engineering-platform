import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../../config.ts";
import { pool, q, json } from "../../db/pool.ts";

const exec = promisify(execFile);

/**
 * Baseline-aware regression testing for Go: a failure only counts as a regression when it does not also happen on the
 * base branch. Comparison is per test and per compile error, so a package that already had an old failure still
 * reports a new one.
 */

export interface GoPackageResult {
  status: "ok" | "fail";
  /** Failed test names (including subtests, e.g. TestA/case_1). */
  tests: string[];
  /** Compile errors with file:line:col stripped, e.g. "app/x_test.go: undefined: fakeLock". */
  buildErrors: string[];
}
export type GoTestReport = Record<string, GoPackageResult>;

const normalizeBuildError = (line: string) =>
  line
    .trim()
    .replace(/^(\S+?\.go):\d+(:\d+)?:\s*/, "$1: ")
    .replace(/\s+/g, " ");

/** Parse plain `go test` output (several packages, possibly interleaved with build output). */
export function parseGoTest(output: string): GoTestReport {
  const report: GoTestReport = {};
  const get = (pkg: string) => (report[pkg] ??= { status: "ok", tests: [], buildErrors: [] });
  let pendingTests: string[] = [];
  let buildPkg: string | null = null;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const header = line.match(/^# (\S+)(?: \[\S+\])?\s*$/);
    if (header) {
      buildPkg = header[1];
      continue;
    }
    if (buildPkg && /^\S+\.go:\d+(:\d+)?: /.test(line.trim()) && !line.startsWith("---")) {
      get(buildPkg).buildErrors.push(normalizeBuildError(line));
      get(buildPkg).status = "fail";
      continue;
    }
    if (buildPkg && !/^\s/.test(line) && line.trim()) buildPkg = null;
    const t = line.match(/^\s*--- FAIL: (\S+)/);
    if (t) {
      pendingTests.push(t[1]);
      continue;
    }
    const fail = line.match(/^FAIL\s+(\S+)(?:\s+\[(build failed|setup failed)\]|\s+[\d.]+s)?\s*$/);
    if (fail && fail[1] !== "FAIL") {
      const p = get(fail[1]);
      p.status = "fail";
      p.tests.push(...pendingTests);
      if (fail[2] && !p.buildErrors.length) p.buildErrors.push(fail[2]);
      pendingTests = [];
      continue;
    }
    const ok = line.match(/^ok\s+(\S+)/);
    if (ok) {
      get(ok[1]);
      pendingTests = [];
    }
  }
  for (const p of Object.values(report)) {
    p.tests = [...new Set(p.tests)];
    p.buildErrors = [...new Set(p.buildErrors)];
  }
  return report;
}

export interface Classification {
  regressions: Array<{ package: string; tests: string[]; build_errors: string[]; reason: string }>;
  pre_existing: Array<{ package: string; tests: string[]; build_errors: string[] }>;
}

/** Compare branch failures against the same packages on the base branch. */
export function classify(branch: GoTestReport, base: GoTestReport): Classification {
  const out: Classification = { regressions: [], pre_existing: [] };
  for (const [pkg, b] of Object.entries(branch)) {
    if (b.status !== "fail") continue;
    const base0 = base[pkg];
    if (!base0) {
      out.regressions.push({ package: pkg, tests: b.tests, build_errors: b.buildErrors, reason: "package does not exist or was not tested on the base branch" });
      continue;
    }
    const baseTests = new Set(base0.status === "fail" ? base0.tests : []);
    const baseErrors = new Set(base0.status === "fail" ? base0.buildErrors : []);
    const newTests = b.tests.filter((t) => !baseTests.has(t));
    const newErrors = b.buildErrors.filter((e) => !baseErrors.has(e));
    const oldTests = b.tests.filter((t) => baseTests.has(t));
    const oldErrors = b.buildErrors.filter((e) => baseErrors.has(e));
    // A package failing with no identifiable test/compile error (e.g. panic in TestMain) is new only if base passed.
    const opaqueNew = !b.tests.length && !b.buildErrors.length && base0.status !== "fail";
    if (newTests.length || newErrors.length || opaqueNew)
      out.regressions.push({ package: pkg, tests: newTests, build_errors: newErrors, reason: opaqueNew ? "package fails on the branch but passes on base" : "new failures compared to base" });
    if (oldTests.length || oldErrors.length || (!b.tests.length && !b.buildErrors.length && base0.status === "fail"))
      out.pre_existing.push({ package: pkg, tests: oldTests, build_errors: oldErrors });
  }
  return out;
}

const baselineCache = new Map<string, GoTestReport>(); // `${repoPath}@${sha}:${pkg}` → report for that package

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}

/**
 * Run `go test` for `packages` on origin/<baseBranch> in a temporary detached worktree of the same repository.
 * `run` executes a shell command in a directory (the command step's runner, so output streams to the UI).
 */
export async function goBaseline(
  workspace: string,
  packages: string[],
  run: (command: string, cwd: string) => Promise<{ code: number | null; output: string; timedOut: boolean }>,
): Promise<{ sha: string; report: GoTestReport; cached: string[] }> {
  const sha = await git(workspace, "rev-parse", `origin/${config.baseBranch}`);
  const repoKey = await git(workspace, "rev-parse", "--git-common-dir");
  const report: GoTestReport = {};
  const cached: string[] = [];
  const todo: string[] = [];
  const persisted = new Map(
    (await q<{ package: string; report: GoPackageResult }>(pool, "SELECT package, report FROM test_baselines WHERE repo_key = $1 AND base_sha = $2 AND package = ANY($3)", [repoKey, sha, packages])).map((r) => [r.package, r.report]),
  );
  for (const p of packages) {
    const hit = baselineCache.get(`${repoKey}@${sha}:${p}`) ?? (persisted.has(p) ? { [p]: persisted.get(p)! } : undefined);
    if (hit) Object.assign(report, hit), cached.push(p);
    else todo.push(p);
  }
  if (todo.length) {
    const dir = join(config.dataDir, "baselines", `${sha.slice(0, 12)}-${process.pid}-${Date.now()}`);
    mkdirSync(join(config.dataDir, "baselines"), { recursive: true });
    await git(workspace, "worktree", "add", "--detach", dir, sha);
    try {
      // Packages that only exist on the branch would make `go test` abort for all packages: test only those present on base.
      const listed = await exec("go", ["list", "-e", "-f", "{{.ImportPath}}|{{if .Error}}err{{end}}|{{len .GoFiles}}{{len .TestGoFiles}}{{len .XTestGoFiles}}", ...todo], { cwd: dir, maxBuffer: 8 * 1024 * 1024 })
        .then((r) => r.stdout)
        .catch((e) => String(e.stdout ?? ""));
      const present = new Set(listed.split("\n").filter((l) => l && l.split("|")[1] === "" && l.split("|")[2] !== "000").map((l) => l.split("|")[0]));
      const testable = todo.filter((p) => present.has(p));
      const r = testable.length ? await run(`go test -short -timeout 5m ${testable.join(" ")}`, dir) : { code: 0, output: "", timedOut: false };
      const parsed = parseGoTest(r.output);
      for (const p of todo) {
        const res = parsed[p] ?? (r.timedOut ? { status: "fail" as const, tests: [], buildErrors: ["timed out"] } : undefined);
        if (res) {
          report[p] = res;
          baselineCache.set(`${repoKey}@${sha}:${p}`, { [p]: res });
          await q(pool, "INSERT INTO test_baselines (repo_key, base_sha, package, report) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [repoKey, sha, p, json(res)]);
        }
      }
    } finally {
      await git(workspace, "worktree", "remove", "--force", dir).catch(() => {});
    }
  }
  return { sha, report, cached };
}

/**
 * Tests known to fail on the CURRENT base commit of this repository (from the persisted baseline cache). Exported as
 * GO_TEST_SKIP so the branch run does not wait again for failures that are already established as pre-existing
 * (e.g. integration tests timing out on an unreachable DB). A new base commit has no entries, so nothing stale is skipped.
 */
export async function knownBaseFailures(workspace: string): Promise<{ sha: string; tests: string[]; skipRegex: string | null }> {
  try {
    const sha = await git(workspace, "rev-parse", `origin/${config.baseBranch}`);
    const repoKey = await git(workspace, "rev-parse", "--git-common-dir");
    const rows = await q<{ report: GoPackageResult }>(pool, "SELECT report FROM test_baselines WHERE repo_key = $1 AND base_sha = $2", [repoKey, sha]);
    const tests = [...new Set(rows.flatMap((r) => (r.report.status === "fail" && !r.report.buildErrors.length ? r.report.tests : [])).map((t) => t.split("/")[0]))].sort();
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { sha, tests, skipRegex: tests.length ? `^(${tests.map(esc).join("|")})$` : null };
  } catch {
    return { sha: "", tests: [], skipRegex: null };
  }
}
