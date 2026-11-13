import { mkdir, writeFile, readFile, lstat, realpath, access } from "node:fs/promises";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { config } from "../config.ts";
import {
  fixtureTrees,
  caseTemplates,
  SuiteSchema,
  sha256,
  FIXTURE_VERSION,
  type BenchmarkSuite,
} from "./dataset.ts";
export const fixtureNamespace = sha256(JSON.stringify(fixtureTrees)).slice(0, 12);
export const fixtureName = (logical: string) => `bench-${fixtureNamespace}-${logical}`;
export const fixtureRoot = (name: string) => join(config.dataDir, "evaluation-fixtures", name);
const gitTail = new Map<string, Promise<void>>();

/** Worktree edits of one fixture repo share a git directory; queue them and retry the lock instead of failing the case. */
function enqueueGit(root: string, job: () => Promise<string>) {
  const prev = gitTail.get(root) ?? Promise.resolve();
  const run = prev.then(job, job);
  gitTail.set(
    root,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

async function fixtureGitOnce(root: string, args: string[], input?: string) {
  let detail = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const cp = execFile(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", root, ...args],
      {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Hasaki synthetic benchmark",
          GIT_AUTHOR_EMAIL: "benchmark@example.invalid",
          GIT_COMMITTER_NAME: "Hasaki synthetic benchmark",
          GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
          GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
        },
      },
    );
    if (input !== undefined) cp.stdin!.end(input);
    const result = await new Promise<{ ok: boolean; stdout: string; stderr: string }>(
      (resolve, reject) => {
        let stdout = "";
        let stderr = "";
        cp.stdout!.on("data", (b) => (stdout += b));
        cp.stderr?.on("data", (b) => (stderr += b));
        cp.on("error", reject);
        cp.on("close", (c) => resolve({ ok: c === 0, stdout, stderr }));
      },
    );
    // Success stays stdout-only. A hint on stderr must not change commit SHAs or NUL-delimited paths.
    if (result.ok) return result.stdout.trim();
    detail = `${result.stdout}\n${result.stderr}`.trim();
    if (!/index\.lock|Unable to create|Another git process/i.test(detail) || attempt === 7) break;
    await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
  }
  throw new Error(
    detail ? `Fixture Git operation failed: ${detail}` : "Fixture Git operation failed",
  );
}

export async function fixtureGit(root: string, args: string[], input?: string) {
  const run = () => fixtureGitOnce(root, args, input);
  return args[0] === "worktree" ? enqueueGit(root, run) : run();
}
export async function materializeSuite(): Promise<BenchmarkSuite> {
  const repos: BenchmarkSuite["repositories"] = {};
  for (const [logical, files] of Object.entries(fixtureTrees)) {
    const name = fixtureName(logical),
      root = fixtureRoot(name);
    await mkdir(root, { recursive: true });
    if (
      (await lstat(root)).isSymbolicLink() ||
      relative(await realpath(config.dataDir), await realpath(root)).startsWith("..")
    )
      throw new Error("Unsafe benchmark fixture root");
    let existing = false;
    try {
      await access(join(root, ".git"));
      existing = true;
    } catch {}
    if (!existing) {
      await fixtureGit(root, ["init", "--quiet", "--initial-branch", config.baseBranch]);
      for (const [path, source] of Object.entries(files)) {
        await writeFile(join(root, path), source);
      }
      await fixtureGit(root, ["add", "--all"]);
      const tree = await fixtureGit(root, ["write-tree"]);
      const commit = await fixtureGit(root, ["commit-tree", tree], `Hasaki ${FIXTURE_VERSION}\n`);
      await fixtureGit(root, ["update-ref", `refs/heads/${config.baseBranch}`, commit]);
    }
    const commit = await fixtureGit(root, ["rev-parse", "HEAD"]);
    for (const [path, source] of Object.entries(files)) {
      const actual = await fixtureGit(root, ["show", `${commit}:${path}`]);
      if (actual !== source.trim()) throw new Error("Pinned fixture source has been modified");
      if ((await readFile(join(root, path), "utf8")) !== source)
        throw new Error("Dirty managed fixture repository");
    }
    if (await fixtureGit(root, ["status", "--porcelain"]))
      throw new Error("Dirty managed fixture repository");
    repos[logical] = { commit, tree_hash: sha256(JSON.stringify(files)) };
  }
  return SuiteSchema.parse({
    key: "backend-v1",
    version: 4,
    title: "Synthetic backend engineering and P1 navigation",
    fixture_version: FIXTURE_VERSION,
    harness_hash: await harnessHash(),
    repositories: repos,
    cases: caseTemplates.map((c) => ({
      ...c,
      base_commit: repos[c.repository].commit,
    })),
  });
}

export async function harnessHash() {
  return sha256(
    (
      await Promise.all(
        [
          "dataset.ts",
          "service.ts",
          "scope.ts",
          "fixtures.ts",
          "isolation.ts",
          "validator.ts",
          "scoring.ts",
          "runner.ts",
          "configuration.ts",
          "providerPhase.ts",
          "controls.ts",
          "contextEffect.ts",
          "liveProvider.ts",
          "liveRuntime.ts",
          "livePrerequisites.ts",
          "ponytailSuite.ts",
          "liveCase.ts",
          "ponytailMetrics.ts",
          "ponytailReport.ts",
        ].map((p) => readFile(new URL(p, import.meta.url), "utf8")),
      )
    ).join("\n"),
  );
}
