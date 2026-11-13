import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveRepoPath } from "../repos/paths.ts";
import { directoryIsSelfRepository, isSelfRepository } from "../platform/selfDevelopment.ts";
import { repositories, type RepositoryRow } from "../repos/service.ts";
import { SuiteSchema, sha256 } from "./dataset.ts";
import { harnessHash } from "./fixtures.ts";
const exec = promisify(execFile);
export const ponytailProviders = ["claude", "codex", "cursor", "antigravity"] as const;
export function ponytailConfigurations() {
  return ponytailProviders.flatMap((provider) =>
    [false, true].map((ponytail) => ({
      mode: "live" as const,
      provider,
      provider_sequence: [{ provider }],
      context_variant: "tools" as const,
      ponytail,
      repetitions: 2,
      case_limit: 8,
      max_case_seconds: 1800,
      max_tokens: 3_000_000,
      max_cost_usd: 10,
      max_suite_cost_usd: 300,
    })),
  );
}
export async function eligiblePonytailRepositories(rows: RepositoryRow[]) {
  const named = rows
    .filter(
      (r) =>
        r.enabled &&
        r.provider !== "benchmark" &&
        !/^(?:hasaki-agentic-engineering-platform|claude-task-platform)$/.test(r.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  // A renamed or re-registered copy of this platform must never become a benchmark target; unknown means excluded.
  const self = await Promise.all(
    named.map(async (r) => {
      try {
        return (await isSelfRepository(r)) || (await directoryIsSelfRepository(resolveRepoPath(r)));
      } catch {
        return true;
      }
    }),
  );
  return named.filter((_, i) => !self[i]);
}
export async function materializePonytailSuite(rows?: RepositoryRow[]) {
  const registry = await eligiblePonytailRepositories(rows ?? (await repositories.list()));
  if (!registry.length)
    throw new Error("Ponytail suite requires registered repositories other than this platform");
  const entries = await Promise.all(
    registry.map(async (repo) => {
      const cwd = resolveRepoPath(repo);
      const run = async (args: string[]) =>
        (
          await exec("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
            timeout: 5000,
            maxBuffer: 4 * 1024 * 1024,
          })
        ).stdout.trim();
      const commit = await run(["rev-parse", "HEAD"]);
      const files = (await run(["ls-tree", "-r", "--name-only", commit])).split("\n");
      return { repo, commit, tree_hash: await run(["rev-parse", `${commit}^{tree}`]), files };
    }),
  );
  const go = entries.filter((e) => e.files.includes("go.mod"));
  const ts = entries.filter(
    (e) => e.files.includes("package.json") && e.files.some((p) => /\.tsx?$/.test(p)),
  );
  if (!go.length || !ts.length)
    throw new Error("Ponytail suite needs both registered Go and TypeScript repositories");
  const kinds = ["go_bugfix", "go_feature", "ts_feature", "refactor", "review", "regression"];
  const cases = kinds.map((category, i) => {
    const candidates = category.startsWith("go_") ? go : category === "ts_feature" ? ts : entries;
    const entry = candidates[i % candidates.length];
    const path = entry.files.find(
      (p) => /\.(go|ts|tsx)$/.test(p) && !/(?:_test|\.test)\./.test(p),
    )!;
    const command = entry.files.includes("go.mod") ? "go test ./..." : "npm test";
    const descriptions: Record<string, string> = {
      go_bugfix:
        "Find and fix one reproducible boundary-condition bug in the selected Go backend file. Add a regression test that fails on the pinned base and passes after the fix.",
      go_feature:
        "Extend an existing Go API in the selected file with input validation consistent with its neighboring APIs. Preserve existing successful inputs and test invalid inputs.",
      ts_feature:
        "Extend an existing TypeScript API in the selected file with input validation consistent with neighboring APIs. Preserve successful inputs and test invalid inputs.",
      refactor:
        "Refactor duplicated logic around the selected file using an existing helper or the smallest shared function. Preserve public behavior and keep all existing tests.",
      review:
        "Review the selected file and its direct callers for correctness and security. Report concrete findings with file:line evidence, severity, and verification. Do not change source files.",
      regression:
        "Add a regression test for an uncovered boundary case in the selected file. If the test exposes a defect, fix only that defect. Preserve all existing assertions.",
    };
    return {
      task_id: `BENCH-${String(101 + i).padStart(3, "0")}`,
      category,
      difficulty: "medium",
      origin: "real_derived",
      provenance: `verified: registered repository ${entry.repo.name} pinned at ${entry.commit}; exploratory task, no historical ticket claim`,
      description: `${descriptions[category]} Start at ${path}.`,
      repository: entry.repo.name,
      repositories: [
        ...new Set([
          entry.repo.name,
          ...entries.filter((_, j) => j % kinds.length === i).map((e) => e.repo.name),
        ]),
      ],
      base_commit: entry.commit,
      repository_commits: Object.fromEntries(entries.map((e) => [e.repo.name, e.commit])),
      expected_behavior: [
        "Existing targeted and regression tests pass",
        "No test weakening or security regression",
        "Evidence of applied skills is recorded",
      ],
      validation: {
        type: "commands",
        path,
        commands: [command],
        public_checks: [],
        hidden_checks: [],
        timeout_seconds: 30,
      },
      allowed_changes: category === "review" ? [] : [{ repository: entry.repo.name, path: "**" }],
      tags: ["ponytail", category],
      critical: true,
    };
  });
  return SuiteSchema.parse({
    key: "knowledge-ponytail-v1",
    version: 1,
    title: "Ponytail knowledge pilot A/B",
    fixture_version: "registered-repositories-v1",
    harness_hash: await harnessHash(),
    repositories: Object.fromEntries(
      entries.map((e) => [e.repo.name, { commit: e.commit, tree_hash: e.tree_hash }]),
    ),
    cases,
  });
}
export const ponytailSuiteHash = (suite: ReturnType<typeof SuiteSchema.parse>) =>
  sha256(JSON.stringify(suite));
