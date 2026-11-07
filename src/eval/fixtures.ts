import {
  mkdir,
  writeFile,
  readFile,
  lstat,
  realpath,
  access,
} from "node:fs/promises";
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
export const fixtureNamespace = sha256(JSON.stringify(fixtureTrees)).slice(
  0,
  12,
);
export const fixtureName = (logical: string) =>
  `bench-${fixtureNamespace}-${logical}`;
export const fixtureRoot = (name: string) =>
  join(config.dataDir, "evaluation-fixtures", name);
export async function fixtureGit(root: string, args: string[], input?: string) {
  const cp = execFile(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-C",
      root,
      ...args,
    ],
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
  return await new Promise<string>((resolve, reject) => {
    let out = "";
    cp.stdout!.on("data", (b) => (out += b));
    cp.on("error", reject);
    cp.on("close", (c) =>
      c === 0
        ? resolve(out.trim())
        : reject(new Error("Fixture Git operation failed")),
    );
  });
}
export async function materializeSuite(): Promise<BenchmarkSuite> {
  const repos: BenchmarkSuite["repositories"] = {};
  for (const [logical, files] of Object.entries(fixtureTrees)) {
    const name = fixtureName(logical),
      root = fixtureRoot(name);
    await mkdir(root, { recursive: true });
    if (
      (await lstat(root)).isSymbolicLink() ||
      relative(await realpath(config.dataDir), await realpath(root)).startsWith(
        "..",
      )
    )
      throw new Error("Unsafe benchmark fixture root");
    let existing = false;
    try {
      await access(join(root, ".git"));
      existing = true;
    } catch {}
    if (!existing) {
      await fixtureGit(root, [
        "init",
        "--quiet",
        "--initial-branch",
        config.baseBranch,
      ]);
      for (const [path, source] of Object.entries(files)) {
        await writeFile(join(root, path), source);
      }
      await fixtureGit(root, ["add", "--all"]);
      const tree = await fixtureGit(root, ["write-tree"]);
      const commit = await fixtureGit(
        root,
        ["commit-tree", tree],
        `Hasaki ${FIXTURE_VERSION}\n`,
      );
      await fixtureGit(root, [
        "update-ref",
        `refs/heads/${config.baseBranch}`,
        commit,
      ]);
    }
    const commit = await fixtureGit(root, ["rev-parse", "HEAD"]);
    for (const [path, source] of Object.entries(files)) {
      const actual = await fixtureGit(root, ["show", `${commit}:${path}`]);
      if (actual !== source.trim())
        throw new Error("Pinned fixture source has been modified");
      if ((await readFile(join(root, path), "utf8")) !== source)
        throw new Error("Dirty managed fixture repository");
    }
    if (await fixtureGit(root, ["status", "--porcelain"]))
      throw new Error("Dirty managed fixture repository");
    repos[logical] = { commit, tree_hash: sha256(JSON.stringify(files)) };
  }
  return SuiteSchema.parse({
    key: "backend-v1",
    version: 3,
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
        ].map((p) => readFile(new URL(p, import.meta.url), "utf8")),
      )
    ).join("\n"),
  );
}
