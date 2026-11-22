/**
 * Shared Production Bug Hunter fixture: the seeded Go repository registered as a local repository, its incidents
 * persisted like the scanner would, the real agent and integration executors, and the fake `codex` CLI scripting the
 * three agent roles (src/eval/bugHuntFixtures.ts).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../../src/config.ts";
import { repositories } from "../../src/repos/service.ts";
import { seedTemplates } from "../../src/workflow/definitions.ts";
import { registerExecutor } from "../../src/workflow/executors/registry.ts";
import {
  integrationExecutor,
  registerIntegrationAction,
  runIsolatedCommand,
} from "../../src/workflow/executors/builtin.ts";
import { registerBugHuntActions } from "../../src/bugHunt/steps.ts";
import { agentExecutor } from "../../src/agent/harness/executor.ts";
import {
  BUG_HUNT_CASES,
  FIXTURE_FILES,
  scriptedBugHuntAgent,
} from "../../src/eval/bugHuntFixtures.ts";
import { seedIncident } from "../../src/eval/bugHuntBenchmark.ts";
import { shareAllRepositoriesForTests } from "./repositoryAccess.ts";

export async function setupBugHuntFixture(root: string) {
  await shareAllRepositoriesForTests();
  await seedTemplates();
  const repo = `bughunt-shop-${process.pid}`;
  const primary = join(config.reposRoot, repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", primary, ...args], { encoding: "utf8" }).trim();
  mkdirSync(primary, { recursive: true });
  git("init", "-q", "-b", "main");
  for (const [p, c] of Object.entries(FIXTURE_FILES)) {
    mkdirSync(dirname(join(primary, p)), { recursive: true });
    writeFileSync(join(primary, p), c);
  }
  git("add", ".");
  git("-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-qm", "shop");
  const revision = git("rev-parse", "HEAD");
  await repositories.upsert(repo, { projects: ["Shop"], default_branch: "main" });
  for (const c of BUG_HUNT_CASES) if (!c.replays) await seedIncident(c, repo, revision);
  registerExecutor("agent", agentExecutor);
  registerExecutor("integration", integrationExecutor);
  registerBugHuntActions(registerIntegrationAction, runIsolatedCommand);
  const bin = join(import.meta.dirname, "fake-codex.mjs");
  chmodSync(bin, 0o755);
  Object.assign(process.env, {
    CODEX_BIN: bin,
    FAKE_CODEX_MODE: "script",
    FAKE_CODEX_LOG: join(root, "bughunt-codex.jsonl"),
  });
  const useScript = (name: string, body: string) => {
    const path = join(root, `${name}.mjs`);
    writeFileSync(path, body);
    process.env.FAKE_CODEX_SCRIPT = path;
  };
  const defaultScript = () => useScript("bughunt-agent", scriptedBugHuntAgent(repo));
  defaultScript();
  return { repo, primary, revision, git, useScript, defaultScript };
}
