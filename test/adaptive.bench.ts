/** Isolated orchestration control; uses the existing scheduler, never a live model or application database. */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { config } from "../src/config.ts";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { repositories } from "../src/repos/service.ts";
import { indexRepository } from "../src/codeIntelligence/indexer.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, getRun, cancelRun } from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { registerDefaultExecutors } from "../src/workflow/executors/index.ts";
import { setHandoffReadinessForTests } from "../src/agent/handoff.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
import { runMetrics } from "../src/api/metrics.ts";
import { newMetrics } from "../src/agent/metrics.ts";
import { ensureContextPack } from "../src/context/pack.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import { matchedBenchmark, type ProfileSample } from "../src/workflow/profileMetrics.ts";
import type { Profile } from "../src/workflow/profiles.ts";
const samples: ProfileSample[] = [];
const calls = new Map<number, number>();
try {
  await migrate();
  await shareAllRepositoriesForTests();
  config.codeIntelligence.enabled = true;
  config.learning.detectChanges = false;
  config.learning.evolveSkills = false;
  setHandoffReadinessForTests(async () => ({ ok: true, quota: "unknown", cost: "unknown" }));
  registerDefaultExecutors();
  for (const type of ["agent", "coding_agent"] as const)
    registerExecutor(type, {
      execute: async (ctx) => {
        calls.set(ctx.run.id, (calls.get(ctx.run.id) ?? 0) + 1);
        await ensureContextPack(ctx, newMetrics("scripted-control"), {
          mode: type === "coding_agent" ? "coding" : "analysis",
          workspaces: [],
          baseBranch: config.baseBranch,
        });
        return {
          kind: "completed",
          output: {
            summary: "Orchestration control; no business change or model inference performed.",
          },
        };
      },
    });
  const repo = "adaptive-control";
  const root = join(config.reposRoot, repo);
  mkdirSync(join(root, "src"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", config.baseBranch);
  writeFileSync(join(root, "src/label.ts"), 'export const label = "old";\n');
  git("add", ".");
  git("commit", "-qm", "fixture");
  const base = git("rev-parse", "HEAD");
  await repositories.upsert(repo, { projects: ["BENCH"] });
  await indexRepository(repo);
  await definitions.create({
    key: "adaptive-control",
    spec: TEMPLATES.find((t) => t.key === "micro-change")!.spec,
  });
  const profiles: Profile[] = ["MICRO", "FAST", "STANDARD"];
  for (let fixture = 0; fixture < 20; fixture++)
    for (let repetition = 1; repetition <= 3; repetition++) {
      const offset = (fixture + repetition) % profiles.length;
      for (const profile of [...profiles.slice(offset), ...profiles.slice(0, offset)]) {
        const started = performance.now();
        const run = await startRun({
          definitionKey: "adaptive-control",
          title: `Fix label ${fixture}`,
          repositories: [repo],
          profile,
          inputs: { risk: "low", files: ["src/label.ts"] },
        });
        await drain();
        const wallMs = performance.now() - started;
        const state = await getRun(run.id);
        const metrics = await runMetrics(run.id);
        samples.push({
          fixture: `label-${fixture}`,
          repetition,
          base,
          provider: "scripted-control",
          model: "none",
          cache: "warm",
          checks: ["approval-retained", "source-unchanged"],
          requestedProfile: profile,
          initialProfile: run.profile!,
          finalProfile: state.profile!,
          wallMs,
          queueMs: metrics.totals.queue_ms,
          activeMs: metrics.totals.exec_ms,
          invocations: calls.get(run.id) ?? 0,
          tokens: null,
          contextTokens: metrics.adaptive.samples.reduce(
            (sum, s) => sum + (s.contextTokens ?? 0),
            0,
          ),
          verificationMs: null,
          correct:
            state.steps.find((s) => s.key === "approve_diff")?.status === "WAITING_APPROVAL" &&
            readFileSync(join(root, "src/label.ts"), "utf8") === 'export const label = "old";\n',
          expectedProfile: null,
        });
        await cancelRun(run.id);
        await drain();
      }
    }
  const hash = createHash("sha256");
  for (const file of [
    "src/workflow/profiles.ts",
    "src/workflow/profileRuntime.ts",
    "src/workflow/profileTransitions.ts",
    "src/workflow/microEvidence.ts",
    "src/workflow/engine.ts",
    "src/context/pack.ts",
  ])
    hash.update(file).update(readFileSync(file));
  console.log(
    JSON.stringify(
      {
        evidence: "fixture",
        candidate_source_sha256: hash.digest("hex"),
        limitation:
          "Measured scheduler/context orchestration only. Invocation counts are scripted executor calls; tokens and verification duration are unavailable. This does not establish live model speed, token savings or business correctness.",
        ...matchedBenchmark(samples),
      },
      null,
      2,
    ),
  );
} finally {
  setHandoffReadinessForTests(undefined);
  await pool.end();
}
